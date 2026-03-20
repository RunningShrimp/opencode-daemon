import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ProjectID } from "@/project/schema"
import { resolveProjectRepositoryIdentity, resolveProjectRuntimeIdentity } from "@/daemon/identity/project-identity"
import { WorkerID } from "@/daemon/identity/ids"
import { LaneController } from "@/daemon/worker/lane-controller"
import { RecoveryCoordinator } from "@/daemon/worker/recovery-coordinator"

const cleanup: string[] = []

async function tempLaneRegistryPath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-recovery-coordinator-"))
  cleanup.push(dir)
  return path.join(dir, "daemon", "lane-registry.json")
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

function runtimeKey(worktree: string): string {
  const repository = resolveProjectRepositoryIdentity({
    projectID: ProjectID.make("project-recovery"),
    repoRoot: worktree,
    vcs: "git",
  })

  return resolveProjectRuntimeIdentity({
    namespaceID: "local",
    repository,
    worktree,
    runtimeBoundary: {
      projectEnv: { NODE_ENV: "development" },
      toolchain: {
        language: "typescript",
        runtime: "bun",
        env: {},
      },
    },
  }).runtimeKey
}

describe("recovery coordinator", () => {
  test("recovers cancelled lanes by resume token", async () => {
    const filePath = await tempLaneRegistryPath()
    let now = 1_700_000_800_000
    const controller = new LaneController(filePath, () => now)
    const coordinator = new RecoveryCoordinator({ laneController: controller })

    const laneA = await controller.acquire({
      workerID: WorkerID.make("worker.recovery.1"),
      runtimeKey: runtimeKey("/tmp/recovery-a"),
      sessionID: "session-recovery-a",
      directory: "/tmp/recovery-a",
    })
    await controller.cancel({
      laneID: laneA.laneID,
      reason: "drop",
      requestID: "req-a",
    })

    now += 100

    const laneB = await controller.acquire({
      workerID: WorkerID.make("worker.recovery.2"),
      runtimeKey: runtimeKey("/tmp/recovery-b"),
      sessionID: "session-recovery-b",
      directory: "/tmp/recovery-b",
    })
    await controller.cancel({
      laneID: laneB.laneID,
      reason: "drop",
      requestID: "req-b",
    })

    now += 500

    const result = await coordinator.recover()
    expect(result.recovered).toHaveLength(2)
    expect(result.skippedTokens).toHaveLength(0)
    expect(result.recovered.every((lane) => lane.state === "active")).toBe(true)

    const all = await controller.list()
    const activeRecovered = all.filter((lane) => lane.state === "active" && lane.rebuiltFromLaneID)
    expect(activeRecovered).toHaveLength(2)
  })

  test("skips tokens already having an active lane and is effectively idempotent", async () => {
    const filePath = await tempLaneRegistryPath()
    let now = 1_700_000_810_000
    const controller = new LaneController(filePath, () => now)
    const coordinator = new RecoveryCoordinator({ laneController: controller })

    const lane = await controller.acquire({
      workerID: WorkerID.make("worker.recovery.3"),
      runtimeKey: runtimeKey("/tmp/recovery-c"),
      sessionID: "session-recovery-c",
      directory: "/tmp/recovery-c",
    })
    const cancelled = await controller.cancel({
      laneID: lane.laneID,
      reason: "drop",
      requestID: "req-c",
    })

    now += 300

    const first = await coordinator.recover()
    expect(first.recovered).toHaveLength(1)

    now += 300

    const second = await coordinator.recover()
    expect(second.recovered).toHaveLength(0)

    const all = await controller.list()
    const token = cancelled?.resumeToken
    const activeForToken = all.filter((entry) => entry.resumeToken === token && entry.state === "active")
    expect(activeForToken).toHaveLength(1)
  })

  test("supports scoped recovery by runtimeKey", async () => {
    const filePath = await tempLaneRegistryPath()
    let now = 1_700_000_820_000
    const controller = new LaneController(filePath, () => now)
    const coordinator = new RecoveryCoordinator({ laneController: controller })

    const keyA = runtimeKey("/tmp/recovery-scope-a")
    const keyB = runtimeKey("/tmp/recovery-scope-b")

    const laneA = await controller.acquire({
      workerID: WorkerID.make("worker.recovery.4"),
      runtimeKey: keyA,
      sessionID: "session-scope-a",
      directory: "/tmp/recovery-scope-a",
    })
    await controller.cancel({
      laneID: laneA.laneID,
      reason: "drop",
      requestID: "req-scope-a",
    })

    const laneB = await controller.acquire({
      workerID: WorkerID.make("worker.recovery.5"),
      runtimeKey: keyB,
      sessionID: "session-scope-b",
      directory: "/tmp/recovery-scope-b",
    })
    await controller.cancel({
      laneID: laneB.laneID,
      reason: "drop",
      requestID: "req-scope-b",
    })

    now += 600

    const scoped = await coordinator.recover({ runtimeKey: keyA })
    expect(scoped.recovered).toHaveLength(1)
    expect(scoped.recovered[0]?.runtimeKey).toBe(keyA)

    const remaining = (await controller.list()).filter((lane) => lane.runtimeKey === keyB && lane.state === "active")
    expect(remaining).toHaveLength(0)
  })
})
