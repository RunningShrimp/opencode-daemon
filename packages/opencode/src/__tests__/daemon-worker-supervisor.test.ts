import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ProjectID } from "@/project/schema"
import type { ProjectIdentityResolutionOutput } from "@/daemon/identity/project-identity-resolver"
import { resolveProjectRepositoryIdentity, resolveProjectRuntimeIdentity } from "@/daemon/identity/project-identity"
import { FencingEpochGenerator } from "@/daemon/protocol/fencing-epoch"
import { WorkerID } from "@/daemon/identity/ids"
import { ProjectWorkerLeaseRegistry } from "@/daemon/worker/project-worker-lease-registry"
import type { ProjectWorkerDescriptor } from "@/daemon/worker/worker-descriptor"
import { WorkerSupervisor } from "@/daemon/worker/worker-supervisor"

const cleanup: string[] = []

async function tempRegistryPath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-worker-supervisor-"))
  cleanup.push(dir)
  return path.join(dir, "daemon", "project-worker-registry.json")
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

function createResolution(input: { namespaceID: string; projectID: string; worktree: string }): ProjectIdentityResolutionOutput {
  const repository = resolveProjectRepositoryIdentity({
    projectID: ProjectID.make(input.projectID),
    repoRoot: input.worktree,
    vcs: "git",
  })

  const runtime = resolveProjectRuntimeIdentity({
    namespaceID: input.namespaceID,
    repository,
    worktree: input.worktree,
    runtimeBoundary: {
      projectEnv: {
        NODE_ENV: "development",
      },
      toolchain: {
        language: "typescript",
        runtime: "bun",
        version: "1.3.10",
        env: {},
      },
    },
  })

  return {
    directory: input.worktree,
    sandboxRoot: input.worktree,
    worktreeRoot: input.worktree,
    repository,
    runtime,
  }
}

function createDescriptor(input: {
  workerID: string
  resolution: ProjectIdentityResolutionOutput
  pid: number
  state?: ProjectWorkerDescriptor["state"]
  at: number
}): ProjectWorkerDescriptor {
  return {
    workerID: WorkerID.make(input.workerID),
    runtime: input.resolution.runtime,
    state: input.state ?? "hot",
    pid: input.pid,
    startupEpoch: new FencingEpochGenerator(input.pid).next(input.at),
    startedAt: input.at,
    lastActiveAt: input.at,
    laneCount: 1,
    toolchainCellCount: 1,
  }
}

describe("worker supervisor", () => {
  test("spawns worker and stores lease when runtime has no active descriptor", async () => {
    const filePath = await tempRegistryPath()
    const registry = new ProjectWorkerLeaseRegistry(filePath)
    const resolution = createResolution({
      namespaceID: "local",
      projectID: "project-alpha",
      worktree: "/tmp/worktree-alpha",
    })

    const spawnCalls: Array<{ mode: string; namespaceID: string; cwd?: string; env?: Record<string, string> }> = []
    const supervisor = new WorkerSupervisor({
      leaseRegistry: registry,
      identityResolver: {
        async resolve() {
          return resolution
        },
      },
      spawner: {
        spawn(input) {
          spawnCalls.push(input)
          return {
            pid: 31001,
            command: ["opencode", "daemon", "worker"],
          }
        },
      },
      now: () => 1_700_000_100_000,
      epochGenerator: new FencingEpochGenerator(42),
      isProcessAlive: () => true,
    })

    const result = await supervisor.ensureWorker({
      namespaceID: "local",
      directory: "/tmp/worktree-alpha",
    })

    expect(result.mode).toBe("spawned")
    expect(spawnCalls).toHaveLength(1)
    expect(spawnCalls[0]?.mode).toBe("worker")
    expect(spawnCalls[0]?.env?.OPENCODE_WORKER_RUNTIME_KEY).toBe(resolution.runtime.runtimeKey)

    const stored = await registry.get(resolution.runtime.runtimeKey)
    expect(stored?.pid).toBe(31001)
    expect(stored?.state).toBe("starting")
    expect(stored?.runtime.runtimeKey).toBe(resolution.runtime.runtimeKey)
  })

  test("attaches to existing live worker for the same runtime key", async () => {
    const filePath = await tempRegistryPath()
    const registry = new ProjectWorkerLeaseRegistry(filePath)
    const resolution = createResolution({
      namespaceID: "local",
      projectID: "project-beta",
      worktree: "/tmp/worktree-beta",
    })

    const existing = createDescriptor({
      workerID: "worker.existing",
      resolution,
      pid: 42001,
      at: 1_700_000_200_000,
    })
    await registry.put(existing)

    let spawnCount = 0
    const supervisor = new WorkerSupervisor({
      leaseRegistry: registry,
      identityResolver: {
        async resolve() {
          return resolution
        },
      },
      spawner: {
        spawn() {
          spawnCount += 1
          return {
            pid: 99999,
            command: ["unexpected"],
          }
        },
      },
      now: () => 1_700_000_300_000,
      isProcessAlive: (pid) => pid === 42001,
    })

    const result = await supervisor.ensureWorker({
      namespaceID: "local",
      directory: "/tmp/worktree-beta",
    })

    expect(result.mode).toBe("attached")
    expect(result.descriptor.workerID).toBe(existing.workerID)
    expect(result.descriptor.lastActiveAt).toBe(1_700_000_300_000)
    expect(spawnCount).toBe(0)
  })

  test("re-spawns worker when existing descriptor points to dead process", async () => {
    const filePath = await tempRegistryPath()
    const registry = new ProjectWorkerLeaseRegistry(filePath)
    const resolution = createResolution({
      namespaceID: "local",
      projectID: "project-gamma",
      worktree: "/tmp/worktree-gamma",
    })

    await registry.put(
      createDescriptor({
        workerID: "worker.stale",
        resolution,
        pid: 51001,
        at: 1_700_000_400_000,
      }),
    )

    const supervisor = new WorkerSupervisor({
      leaseRegistry: registry,
      identityResolver: {
        async resolve() {
          return resolution
        },
      },
      spawner: {
        spawn() {
          return {
            pid: 51002,
            command: ["opencode", "daemon", "worker"],
          }
        },
      },
      now: () => 1_700_000_500_000,
      epochGenerator: new FencingEpochGenerator(99),
      isProcessAlive: (pid) => pid !== 51001,
    })

    const result = await supervisor.ensureWorker({
      namespaceID: "local",
      directory: "/tmp/worktree-gamma",
    })

    expect(result.mode).toBe("spawned")
    expect(result.descriptor.pid).toBe(51002)

    const stored = await registry.get(resolution.runtime.runtimeKey)
    expect(stored?.pid).toBe(51002)
    expect(stored?.workerID).toBe(result.descriptor.workerID)
  })
})
