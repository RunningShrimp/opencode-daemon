import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ProjectID } from "@/project/schema"
import { resolveProjectRepositoryIdentity, resolveProjectRuntimeIdentity } from "@/daemon/identity/project-identity"
import { ResumeToken, WorkerID } from "@/daemon/identity/ids"
import { LaneController } from "@/daemon/worker/lane-controller"

const cleanup: string[] = []

async function tempLaneRegistryPath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-lane-controller-"))
  cleanup.push(dir)
  return path.join(dir, "daemon", "lane-registry.json")
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

function runtimeKey(worktree: string): string {
  const repository = resolveProjectRepositoryIdentity({
    projectID: ProjectID.make("project-lane"),
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

describe("lane controller", () => {
  test("acquires a new active lane and persists it", async () => {
    const filePath = await tempLaneRegistryPath()
    const controller = new LaneController(filePath, () => 1_700_000_700_000)

    const lane = await controller.acquire({
      workerID: WorkerID.make("worker.lane.1"),
      runtimeKey: runtimeKey("/tmp/lane-a"),
      sessionID: "session-a",
      directory: "/tmp/lane-a",
    })

    expect(lane.state).toBe("active")
    expect(lane.acquiredAt).toBe(1_700_000_700_000)

    const persisted = await controller.get(lane.laneID)
    expect(persisted?.laneID).toBe(lane.laneID)
    expect(persisted?.sessionID).toBe("session-a")
  })

  test("acquire is idempotent for same worker/runtime/session tuple", async () => {
    const filePath = await tempLaneRegistryPath()
    let now = 1_700_000_710_000
    const controller = new LaneController(filePath, () => now)

    const key = runtimeKey("/tmp/lane-b")
    const first = await controller.acquire({
      workerID: WorkerID.make("worker.lane.2"),
      runtimeKey: key,
      sessionID: "session-b",
      directory: "/tmp/lane-b",
    })

    now = 1_700_000_710_500

    const second = await controller.acquire({
      workerID: WorkerID.make("worker.lane.2"),
      runtimeKey: key,
      sessionID: "session-b",
      directory: "/tmp/lane-b-updated",
    })

    expect(second.laneID).toBe(first.laneID)
    expect(second.directory).toBe("/tmp/lane-b-updated")
    expect(second.lastHeartbeatAt).toBe(1_700_000_710_500)

    const all = await controller.list()
    expect(all).toHaveLength(1)
  })

  test("release transitions lane to released with reason", async () => {
    const filePath = await tempLaneRegistryPath()
    let now = 1_700_000_720_000
    const controller = new LaneController(filePath, () => now)

    const lane = await controller.acquire({
      workerID: WorkerID.make("worker.lane.3"),
      runtimeKey: runtimeKey("/tmp/lane-c"),
      sessionID: "session-c",
      directory: "/tmp/lane-c",
    })

    now = 1_700_000_720_800

    const released = await controller.release({
      laneID: lane.laneID,
      reason: "session-finished",
    })

    expect(released?.state).toBe("released")
    expect(released?.releaseReason).toBe("session-finished")
    expect(released?.releasedAt).toBe(1_700_000_720_800)

    const persisted = await controller.get(lane.laneID)
    expect(persisted?.state).toBe("released")
    expect(persisted?.releaseReason).toBe("session-finished")
  })

  test("cancel transitions lane to cancelled and assigns resume token", async () => {
    const filePath = await tempLaneRegistryPath()
    let now = 1_700_000_730_000
    const controller = new LaneController(filePath, () => now)

    const lane = await controller.acquire({
      workerID: WorkerID.make("worker.lane.4"),
      runtimeKey: runtimeKey("/tmp/lane-d"),
      sessionID: "session-d",
      directory: "/tmp/lane-d",
    })

    now = 1_700_000_730_700

    const cancelled = await controller.cancel({
      laneID: lane.laneID,
      reason: "user-cancel",
      requestID: "req-123",
    })

    expect(cancelled?.state).toBe("cancelled")
    expect(cancelled?.cancelReason).toBe("user-cancel")
    expect(cancelled?.cancelRequestID).toBe("req-123")
    expect(cancelled?.cancelledAt).toBe(1_700_000_730_700)
    expect(cancelled?.resumeToken).toBeTruthy()
  })

  test("rebuild marks source lane rebuilding and creates a new active lane", async () => {
    const filePath = await tempLaneRegistryPath()
    let now = 1_700_000_740_000
    const controller = new LaneController(filePath, () => now)

    const lane = await controller.acquire({
      workerID: WorkerID.make("worker.lane.5"),
      runtimeKey: runtimeKey("/tmp/lane-e"),
      sessionID: "session-e",
      directory: "/tmp/lane-e",
    })

    now = 1_700_000_740_300
    await controller.cancel({
      laneID: lane.laneID,
      reason: "transport-reset",
      requestID: "req-456",
    })

    now = 1_700_000_740_900
    const rebuilt = await controller.rebuild({
      laneID: lane.laneID,
      reason: "rebuild-after-cancel",
      directory: "/tmp/lane-e-rebuilt",
    })

    expect(rebuilt).toBeTruthy()
    expect(rebuilt?.previous.state).toBe("rebuilding")
    expect(rebuilt?.current.state).toBe("active")
    expect(rebuilt?.current.rebuiltFromLaneID).toBe(lane.laneID)
    expect(rebuilt?.current.resumeToken).toBe(rebuilt?.previous.resumeToken)
    expect(rebuilt?.current.directory).toBe("/tmp/lane-e-rebuilt")

    const all = await controller.list()
    expect(all).toHaveLength(2)
  })

  test("resume is idempotent when active lane for token already exists", async () => {
    const filePath = await tempLaneRegistryPath()
    let now = 1_700_000_750_000
    const controller = new LaneController(filePath, () => now)

    const lane = await controller.acquire({
      workerID: WorkerID.make("worker.lane.6"),
      runtimeKey: runtimeKey("/tmp/lane-f"),
      sessionID: "session-f",
      directory: "/tmp/lane-f",
    })

    now = 1_700_000_750_100
    const cancelled = await controller.cancel({
      laneID: lane.laneID,
      reason: "network-drop",
      requestID: "req-789",
    })
    const token = ResumeToken.make(cancelled?.resumeToken ?? "")

    now = 1_700_000_750_500
    const resumedFirst = await controller.resume({
      resumeToken: token,
      directory: "/tmp/lane-f-resumed",
    })
    expect(resumedFirst?.state).toBe("active")
    expect(resumedFirst?.resumeToken).toBe(token)

    now = 1_700_000_750_900
    const resumedSecond = await controller.resume({
      resumeToken: token,
      directory: "/tmp/lane-f-resumed-2",
    })

    expect(resumedSecond?.laneID).toBe(resumedFirst?.laneID)
    expect(resumedSecond?.directory).toBe("/tmp/lane-f-resumed-2")

    const activeForToken = (await controller.list()).filter((x) => x.resumeToken === token && x.state === "active")
    expect(activeForToken).toHaveLength(1)
  })
})
