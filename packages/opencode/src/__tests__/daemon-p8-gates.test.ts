import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ProjectID } from "@/project/schema"
import { resolveProjectRepositoryIdentity, resolveProjectRuntimeIdentity } from "@/daemon/identity/project-identity"
import { FencingEpochGenerator } from "@/daemon/protocol/fencing-epoch"
import { WorkerID } from "@/daemon/identity/ids"
import { ProjectWorkerLeaseRegistry } from "@/daemon/worker/project-worker-lease-registry"
import type { ProjectWorkerDescriptor } from "@/daemon/worker/worker-descriptor"
import { OrphanAdoptionCoordinator } from "@/daemon/worker/orphan-adoption-coordinator"
import { LaneController } from "@/daemon/worker/lane-controller"
import { createLocalTransportAdapter } from "@/daemon/transport/local-transport-adapter"

const cleanup: string[] = []

async function tempDir(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  cleanup.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

function runtime(worktree: string, project = "project-p8") {
  const repository = resolveProjectRepositoryIdentity({
    projectID: ProjectID.make(project),
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
  })
}

function descriptor(input: {
  workerID: string
  runtimeKey: ReturnType<typeof runtime>
  pid: number
  state: ProjectWorkerDescriptor["state"]
  at: number
  epoch: string
}): ProjectWorkerDescriptor {
  return {
    workerID: WorkerID.make(input.workerID),
    runtime: input.runtimeKey,
    state: input.state,
    pid: input.pid,
    startupEpoch: input.epoch as ProjectWorkerDescriptor["startupEpoch"],
    startedAt: input.at,
    lastActiveAt: input.at,
    laneCount: 0,
    toolchainCellCount: 0,
  }
}

describe("P8 gates", () => {
  test("Z-Gate: stale orphan is reaped and replaced without lease leak", async () => {
    const dir = await tempDir("opencode-p8-z-")
    const leaseRegistry = new ProjectWorkerLeaseRegistry(path.join(dir, "daemon", "project-worker-registry.json"))

    const rt = runtime("/tmp/p8-z")
    const epochs = new FencingEpochGenerator(5151)
    const workerEpoch = epochs.next(1_710_000_000_000)
    const masterEpoch = epochs.next(1_710_000_000_010)

    await leaseRegistry.put(
      descriptor({
        workerID: "worker.p8.z.old",
        runtimeKey: rt,
        pid: 55100,
        state: "hot",
        at: 1_710_000_000_000,
        epoch: workerEpoch,
      }),
    )

    const reaped: number[] = []
    const coordinator = new OrphanAdoptionCoordinator({
      leaseRegistry,
      workerSupervisor: {
        async ensureWorker() {
          return {
            mode: "spawned",
            command: ["opencode", "daemon", "worker"],
            descriptor: descriptor({
              workerID: "worker.p8.z.new",
              runtimeKey: rt,
              pid: 55101,
              state: "starting",
              at: 1_710_000_000_020,
              epoch: masterEpoch,
            }),
          }
        },
      },
      probeHealth: () => ({
        responsive: true,
        stateComplete: true,
        hasRecoverableState: true,
      }),
      isProcessAlive: (pid) => pid === 55100,
      reapProcess: (pid) => {
        reaped.push(pid)
      },
      now: () => 1_710_000_000_030,
    })

    const result = await coordinator.reconcile({ masterEpoch })
    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]?.action).toBe("reap-and-respawn")
    expect(result.entries[0]?.replacementWorkerID).toBe("worker.p8.z.new")
    expect(reaped).toEqual([55100])

    const staleLease = await leaseRegistry.get(rt.runtimeKey)
    expect(staleLease).toBeUndefined()
  })

  test("W-Gate: same repo different worktree keeps runtime and lease isolated", async () => {
    const dir = await tempDir("opencode-p8-w-")
    const leaseRegistry = new ProjectWorkerLeaseRegistry(path.join(dir, "daemon", "project-worker-registry.json"))

    const rtA = runtime("/tmp/p8-w-worktree-a", "project-shared")
    const rtB = runtime("/tmp/p8-w-worktree-b", "project-shared")
    expect(rtA.runtimeKey).not.toBe(rtB.runtimeKey)

    const epochA = new FencingEpochGenerator(7001).next(1_710_000_100_000)
    const epochB = new FencingEpochGenerator(7002).next(1_710_000_100_000)

    await leaseRegistry.put(
      descriptor({
        workerID: "worker.p8.w.a",
        runtimeKey: rtA,
        pid: 57001,
        state: "hot",
        at: 1_710_000_100_000,
        epoch: epochA,
      }),
    )
    await leaseRegistry.put(
      descriptor({
        workerID: "worker.p8.w.b",
        runtimeKey: rtB,
        pid: 57002,
        state: "hot",
        at: 1_710_000_100_000,
        epoch: epochB,
      }),
    )

    const all = await leaseRegistry.list()
    expect(all).toHaveLength(2)

    await leaseRegistry.delete(rtA.runtimeKey)
    const remainA = await leaseRegistry.get(rtA.runtimeKey)
    const remainB = await leaseRegistry.get(rtB.runtimeKey)
    expect(remainA).toBeUndefined()
    expect(remainB?.workerID).toBe("worker.p8.w.b")
  })

  test("L-Gate: cancelling one lane does not disturb sibling lane on same worker", async () => {
    const dir = await tempDir("opencode-p8-l-")
    const laneController = new LaneController(path.join(dir, "daemon", "lane-registry.json"), () => 1_710_000_200_000)

    const rt = runtime("/tmp/p8-l")
    const laneA = await laneController.acquire({
      workerID: WorkerID.make("worker.p8.l"),
      runtimeKey: rt.runtimeKey,
      sessionID: "session-p8-l-a",
      directory: "/tmp/p8-l",
    })
    const laneB = await laneController.acquire({
      workerID: WorkerID.make("worker.p8.l"),
      runtimeKey: rt.runtimeKey,
      sessionID: "session-p8-l-b",
      directory: "/tmp/p8-l",
    })

    await laneController.cancel({
      laneID: laneA.laneID,
      reason: "interrupt-a",
      requestID: "req-p8-l",
    })

    const kept = await laneController.get(laneB.laneID)
    expect(kept?.state).toBe("active")
    expect(kept?.sessionID).toBe("session-p8-l-b")
  })

  test("M-Gate: primary/shadow transport responses stay parity-matched", async () => {
    const compared: Array<{ match: boolean; statusMatch: boolean; bodyMatch: boolean }> = []

    const adapter = createLocalTransportAdapter({
      dispatch: async () => Response.json({ ok: true, value: "same" }),
      shadow: {
        dispatch: async () => Response.json({ ok: true, value: "same" }),
        onCompared(result) {
          compared.push(result)
        },
      },
    })

    const response = await adapter("/global/health", { method: "GET" })
    expect(response.status).toBe(200)
    expect(compared).toHaveLength(1)
    expect(compared[0]).toEqual({
      match: true,
      statusMatch: true,
      bodyMatch: true,
    })
  })
})
