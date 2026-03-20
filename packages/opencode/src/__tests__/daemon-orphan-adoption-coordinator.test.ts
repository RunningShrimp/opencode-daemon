import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ProjectID } from "@/project/schema"
import { resolveProjectRepositoryIdentity, resolveProjectRuntimeIdentity } from "@/daemon/identity/project-identity"
import { FencingEpochGenerator } from "@/daemon/protocol/fencing-epoch"
import { WorkerID } from "@/daemon/identity/ids"
import { ORPHAN_ADOPTION_RULESET_VERSION } from "@/daemon/protocol/orphan-adoption"
import { ProjectWorkerLeaseRegistry } from "@/daemon/worker/project-worker-lease-registry"
import type { ProjectWorkerDescriptor } from "@/daemon/worker/worker-descriptor"
import { OrphanAdoptionCoordinator } from "@/daemon/worker/orphan-adoption-coordinator"

const cleanup: string[] = []

async function tempRegistryPath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-orphan-coordinator-"))
  cleanup.push(dir)
  return path.join(dir, "daemon", "project-worker-registry.json")
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

function descriptor(input: {
  workerID: string
  projectID: string
  worktree: string
  epochSeed: number
  startupAt: number
  pid: number
}): ProjectWorkerDescriptor {
  const repository = resolveProjectRepositoryIdentity({
    projectID: ProjectID.make(input.projectID),
    repoRoot: input.worktree,
    vcs: "git",
  })

  const runtime = resolveProjectRuntimeIdentity({
    namespaceID: "local",
    repository,
    worktree: input.worktree,
    runtimeBoundary: {
      projectEnv: { NODE_ENV: "development" },
      toolchain: {
        language: "typescript",
        runtime: "bun",
        env: {},
      },
    },
  })

  return {
    workerID: WorkerID.make(input.workerID),
    runtime,
    state: "hot",
    pid: input.pid,
    startupEpoch: new FencingEpochGenerator(input.epochSeed).next(input.startupAt),
    startedAt: input.startupAt,
    lastActiveAt: input.startupAt,
    laneCount: 1,
    toolchainCellCount: 1,
  }
}

describe("orphan adoption coordinator", () => {
  test("adopts recoverable worker when epochs match and worker is healthy", async () => {
    const filePath = await tempRegistryPath()
    const registry = new ProjectWorkerLeaseRegistry(filePath)

    const worker = descriptor({
      workerID: "worker.adoptable",
      projectID: "project-adopt",
      worktree: "/tmp/worktree-adopt",
      epochSeed: 21,
      startupAt: 1_700_000_100_000,
      pid: 62001,
    })
    await registry.put(worker)

    let ensured = 0
    const coordinator = new OrphanAdoptionCoordinator({
      leaseRegistry: registry,
      workerSupervisor: {
        async ensureWorker() {
          ensured += 1
          throw new Error("should not respawn in adopt path")
        },
      },
      probeHealth: () => ({
        responsive: true,
        stateComplete: true,
        hasRecoverableState: true,
      }),
      isProcessAlive: () => true,
      reapProcess: () => {
        throw new Error("should not reap in adopt path")
      },
      now: () => 1_700_000_100_500,
    })

    const result = await coordinator.reconcile({
      masterEpoch: worker.startupEpoch,
    })

    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]?.action).toBe("adopt")
    expect(result.entries[0]?.reason).toBe("worker-safe-to-adopt")
    expect(result.entries[0]?.decisionLog.rulesetVersion).toBe(ORPHAN_ADOPTION_RULESET_VERSION)
    expect(result.entries[0]?.decisionLog.observedAt).toBe(1_700_000_100_500)
    expect(result.entries[0]?.decisionLog.runtimeKey).toBe(worker.runtime.runtimeKey)
    expect(ensured).toBe(0)

    const stillThere = await registry.get(worker.runtime.runtimeKey)
    expect(stillThere?.workerID).toBe(worker.workerID)
  })

  test("reaps and respawns stale worker when worker epoch is older than master", async () => {
    const filePath = await tempRegistryPath()
    const registry = new ProjectWorkerLeaseRegistry(filePath)

    const stale = descriptor({
      workerID: "worker.stale",
      projectID: "project-reap-respawn",
      worktree: "/tmp/worktree-reap-respawn",
      epochSeed: 22,
      startupAt: 1_700_000_100_000,
      pid: 62002,
    })
    await registry.put(stale)

    const reapCalls: number[] = []
    const coordinator = new OrphanAdoptionCoordinator({
      leaseRegistry: registry,
      workerSupervisor: {
        async ensureWorker(input) {
          expect(input.namespaceID).toBe("local")
          expect(input.directory).toBe("/tmp/worktree-reap-respawn")
          return {
            mode: "spawned",
            command: ["opencode", "daemon", "worker"],
            descriptor: {
              ...stale,
              workerID: WorkerID.make("worker.replacement"),
              pid: 63001,
            },
          }
        },
      },
      probeHealth: () => ({
        responsive: true,
        stateComplete: true,
        hasRecoverableState: true,
      }),
      isProcessAlive: (pid) => pid === stale.pid,
      reapProcess: (pid) => {
        reapCalls.push(pid)
      },
      now: () => 1_700_000_200_500,
    })

    const masterEpoch = new FencingEpochGenerator(99).next(1_700_000_200_000)
    const result = await coordinator.reconcile({ masterEpoch })

    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]?.action).toBe("reap-and-respawn")
    expect(result.entries[0]?.reason).toBe("worker-stale-epoch")
    expect(result.entries[0]?.replacementWorkerID).toBe("worker.replacement")
    expect(result.entries[0]?.decisionLog.rulesetVersion).toBe(ORPHAN_ADOPTION_RULESET_VERSION)
    expect(result.entries[0]?.decisionLog.action).toBe("reap-and-respawn")
    expect(result.entries[0]?.decisionLog.reason).toBe("worker-stale-epoch")
    expect(reapCalls).toEqual([62002])

    const deleted = await registry.get(stale.runtime.runtimeKey)
    expect(deleted).toBeUndefined()
  })

  test("reaps newer-epoch worker without respawn", async () => {
    const filePath = await tempRegistryPath()
    const registry = new ProjectWorkerLeaseRegistry(filePath)

    const newer = descriptor({
      workerID: "worker.newer",
      projectID: "project-reap-only",
      worktree: "/tmp/worktree-reap-only",
      epochSeed: 123,
      startupAt: 1_700_000_300_000,
      pid: 62003,
    })
    await registry.put(newer)

    let ensureCount = 0
    const coordinator = new OrphanAdoptionCoordinator({
      leaseRegistry: registry,
      workerSupervisor: {
        async ensureWorker() {
          ensureCount += 1
          throw new Error("should not respawn for worker-epoch-newer")
        },
      },
      probeHealth: () => ({
        responsive: true,
        stateComplete: true,
        hasRecoverableState: true,
      }),
      isProcessAlive: () => true,
      reapProcess: () => undefined,
      now: () => 1_700_000_300_500,
    })

    const masterEpoch = new FencingEpochGenerator(50).next(1_700_000_200_000)
    const result = await coordinator.reconcile({ masterEpoch })

    expect(result.entries).toHaveLength(1)
    expect(result.entries[0]?.action).toBe("reap")
    expect(result.entries[0]?.reason).toBe("worker-epoch-newer")
    expect(result.entries[0]?.decisionLog.rulesetVersion).toBe(ORPHAN_ADOPTION_RULESET_VERSION)
    expect(result.entries[0]?.decisionLog.action).toBe("reap")
    expect(result.entries[0]?.decisionLog.reason).toBe("worker-epoch-newer")
    expect(ensureCount).toBe(0)

    const deleted = await registry.get(newer.runtime.runtimeKey)
    expect(deleted).toBeUndefined()
  })
})
