import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ProjectID } from "@/project/schema"
import { resolveProjectRepositoryIdentity, resolveProjectRuntimeIdentity } from "@/daemon/identity/project-identity"
import { FencingEpochGenerator } from "@/daemon/protocol/fencing-epoch"
import type { ProjectWorkerDescriptor } from "@/daemon/worker/worker-descriptor"
import { WorkerSupervisor } from "@/daemon/worker/worker-supervisor"
import { ToolchainCellRegistry } from "@/daemon/worker/toolchain-cell-registry"
import { ToolchainCellActivationRouter } from "@/daemon/worker/toolchain-cell-activation-router"
import { LaneController } from "@/daemon/worker/lane-controller"
import { RecoveryCoordinator } from "@/daemon/worker/recovery-coordinator"
import { WorkerID } from "@/daemon/identity/ids"
import { evaluateWorkerReclamation } from "@/daemon/worker/worker-resource-limits"
import { createLocalTransportAdapter } from "@/daemon/transport/local-transport-adapter"
import {
  configurePublicListener,
  disablePublicListener,
  registerPublicListenerController,
  resetPublicListenerControllerForTests,
} from "@/server/public-listener"

class MemoryLeaseRegistry {
  private readonly map = new Map<string, ProjectWorkerDescriptor>()

  async get(runtimeKey: string) {
    return this.map.get(runtimeKey)
  }

  async put(worker: ProjectWorkerDescriptor) {
    this.map.set(worker.runtime.runtimeKey, worker)
  }

  async delete(runtimeKey: string) {
    this.map.delete(runtimeKey)
  }

  async list() {
    return [...this.map.values()]
  }
}

const cleanup: string[] = []

async function tempDir(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  cleanup.push(dir)
  return dir
}

function runtime(worktree: string, project = "project-scenario", toolchainLanguage = "typescript") {
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
        language: toolchainLanguage,
        runtime: toolchainLanguage === "go" ? "go" : "bun",
        env: {},
      },
    },
  })
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
  await disablePublicListener()
  await resetPublicListenerControllerForTests()
})

describe("daemon scenario matrix (A-G)", () => {
  test("Scenario A: four projects/four clients allocate isolated workers", async () => {
    const root = await tempDir("opencode-scenario-a-")
    const leaseRegistry = new MemoryLeaseRegistry()
    let nextPID = 61000

    const supervisor = new WorkerSupervisor({
      leaseRegistry,
      identityResolver: {
        async resolve(input) {
          const worktree = String(input.directory)
          const project = worktree.split("/").slice(-1)[0] || "project-a"
          return {
            directory: worktree,
            sandboxRoot: worktree,
            worktreeRoot: worktree,
            repository: resolveProjectRepositoryIdentity({
              projectID: ProjectID.make(project),
              repoRoot: worktree,
              vcs: "git",
            }),
            runtime: runtime(worktree, project),
          }
        },
      },
      spawner: {
        spawn() {
          nextPID += 1
          return {
            pid: nextPID,
            command: ["opencode", "daemon", "worker"],
          }
        },
      },
      isProcessAlive: () => true,
      now: () => 1_710_010_000_000,
    })

    const dirs = ["rust-1", "rust-2", "ts", "go"].map((name) => path.join(root, name))
    await Promise.all(dirs.map((directory) => supervisor.ensureWorker({ namespaceID: "local", directory })))

    const entries = await leaseRegistry.list()
    expect(entries).toHaveLength(4)
    expect(new Set(entries.map((entry) => entry.runtime.runtimeKey)).size).toBe(4)
  })

  test("Scenario B: same project multi-clients attach the same worker", async () => {
    const root = await tempDir("opencode-scenario-b-")
    const worktree = path.join(root, "shared")
    const leaseRegistry = new MemoryLeaseRegistry()
    let spawnCount = 0
    const sharedRuntime = runtime(worktree, "project-b")

    const supervisor = new WorkerSupervisor({
      leaseRegistry,
      identityResolver: {
        async resolve() {
          return {
            directory: worktree,
            sandboxRoot: worktree,
            worktreeRoot: worktree,
            repository: sharedRuntime.repository,
            runtime: sharedRuntime,
          }
        },
      },
      spawner: {
        spawn() {
          spawnCount += 1
          return {
            pid: 62000 + spawnCount,
            command: ["opencode", "daemon", "worker"],
          }
        },
      },
      isProcessAlive: () => true,
      now: () => 1_710_010_100_000,
    })

    const first = await supervisor.ensureWorker({ namespaceID: "local", directory: worktree })
    const second = await supervisor.ensureWorker({ namespaceID: "local", directory: worktree })

    expect(first.mode).toBe("spawned")
    expect(second.mode).toBe("attached")
    expect(spawnCount).toBe(1)
    expect(second.descriptor.runtime.runtimeKey).toBe(first.descriptor.runtime.runtimeKey)
  })

  test("Scenario C: single project multi-language routes to separate toolchain cells", async () => {
    const root = await tempDir("opencode-scenario-c-")
    const worktree = path.join(root, "project")
    const registry = new ToolchainCellRegistry(path.join(root, "daemon", "cells.json"), () => 1_710_010_200_000)
    const router = new ToolchainCellActivationRouter(registry)
    const rt = runtime(worktree, "project-c")

    const ts = await router.activateLSP({
      workerID: WorkerID.make("worker.scenario.c"),
      runtimeKey: rt.runtimeKey,
      laneID: "lane.scenario.c.ts",
      directory: worktree,
      profile: {
        language: "typescript",
        runtime: "bun",
        env: {},
      },
    })

    const go = await router.activateLSP({
      workerID: WorkerID.make("worker.scenario.c"),
      runtimeKey: rt.runtimeKey,
      laneID: "lane.scenario.c.go",
      directory: worktree,
      profile: {
        language: "go",
        runtime: "go",
        env: {},
      },
    })

    expect(ts.cell.cellID).not.toBe(go.cell.cellID)
  })

  test("Scenario D: same repo multiple worktrees keep worker isolation", async () => {
    const root = await tempDir("opencode-scenario-d-")
    const leaseRegistry = new MemoryLeaseRegistry()
    const epochs = new FencingEpochGenerator(63000)

    const rtA = runtime(path.join(root, "worktree-a"), "project-d")
    const rtB = runtime(path.join(root, "worktree-b"), "project-d")

    expect(rtA.runtimeKey).not.toBe(rtB.runtimeKey)

    await leaseRegistry.put({
      workerID: "worker.scenario.d.a",
      runtime: rtA,
      state: "hot",
      pid: 63001,
      startupEpoch: epochs.next(1_710_010_200_000),
      startedAt: 1_710_010_200_000,
      lastActiveAt: 1_710_010_200_000,
      laneCount: 1,
      toolchainCellCount: 1,
    })

    await leaseRegistry.put({
      workerID: "worker.scenario.d.b",
      runtime: rtB,
      state: "hot",
      pid: 63002,
      startupEpoch: epochs.next(1_710_010_200_001),
      startedAt: 1_710_010_200_000,
      lastActiveAt: 1_710_010_200_000,
      laneCount: 1,
      toolchainCellCount: 1,
    })

    const entries = await leaseRegistry.list()
    expect(entries).toHaveLength(2)
    expect(new Set(entries.map((entry) => entry.runtime.runtimeKey)).size).toBe(2)
  })

  test("Scenario E: lane interruption can be recovered", async () => {
    const root = await tempDir("opencode-scenario-e-")
    const worktree = path.join(root, "project")
    const laneController = new LaneController(path.join(root, "daemon", "lanes.json"), () => 1_710_010_300_000)
    const recovery = new RecoveryCoordinator({ laneController })
    const rt = runtime(worktree, "project-e")

    const lane = await laneController.acquire({
      workerID: WorkerID.make("worker.scenario.e"),
      runtimeKey: rt.runtimeKey,
      sessionID: "session-scenario-e",
      directory: worktree,
    })

    await laneController.cancel({
      laneID: lane.laneID,
      reason: "transport-drop",
      requestID: "req-scenario-e",
    })

    const result = await recovery.recover()
    expect(result.recovered.length).toBeGreaterThanOrEqual(1)
    expect(result.recovered[0]?.state).toBe("active")
  })

  test("Scenario F: memory pressure reclaims idle workers first", () => {
    const epochs = new FencingEpochGenerator(64000)
    const rtHot = runtime("/tmp/scenario-f-hot", "project-f-hot")
    const rtIdle = runtime("/tmp/scenario-f-idle", "project-f-idle")

    const candidates = evaluateWorkerReclamation({
      now: 1_710_010_500_000,
      limits: {
        maxWorkers: 1,
        maxWarmIdleWorkers: 0,
        maxIdleMs: 10_000,
      },
      workers: [
        {
          workerID: WorkerID.make("worker.scenario.f.hot"),
          runtime: rtHot,
          state: "hot",
          pid: 64001,
          startupEpoch: epochs.next(1_710_010_400_000),
          startedAt: 1_710_010_400_000,
          lastActiveAt: 1_710_010_499_900,
          laneCount: 1,
          toolchainCellCount: 1,
        },
        {
          workerID: WorkerID.make("worker.scenario.f.idle"),
          runtime: rtIdle,
          state: "warm-idle",
          pid: 64002,
          startupEpoch: epochs.next(1_710_010_300_000),
          startedAt: 1_710_010_300_000,
          lastActiveAt: 1_710_010_300_000,
          laneCount: 0,
          toolchainCellCount: 1,
        },
      ],
    })

    expect(candidates.length).toBeGreaterThanOrEqual(1)
    expect(candidates.some((candidate) => candidate.workerID === "worker.scenario.f.idle")).toBe(true)
  })

  test("Scenario G: local control path coexists with public listener", async () => {
    registerPublicListenerController((opts) => ({
      hostname: opts.hostname,
      port: opts.port,
      url: new URL(`http://${opts.hostname}:${opts.port}`),
      stop: async () => 0,
    }))

    const adapter = createLocalTransportAdapter({
      dispatch: async () => Response.json({ healthy: true, channel: "local" }),
      internalOrigin: "http://opencode.internal",
      rejectExternal: true,
    })

    const configured = await configurePublicListener({
      hostname: "127.0.0.1",
      port: 6500,
    })

    const health = await adapter("/global/health", { method: "GET" })
    const payload = (await health.json()) as { healthy: boolean; channel: string }

    expect(configured.active).toBe(true)
    expect(payload.healthy).toBe(true)
    expect(payload.channel).toBe("local")
  })
})
