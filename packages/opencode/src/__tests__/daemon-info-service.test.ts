import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { DaemonInfoService } from "@/daemon/master/daemon-info"
import { WorkerMetricsCollector } from "@/daemon/master/worker-metrics"
import { ServerRegistryStore } from "@/daemon/bootstrap/registry"
import { ProjectWorkerLeaseRegistry } from "@/daemon/worker/project-worker-lease-registry"
import { LaneController } from "@/daemon/worker/lane-controller"
import { ToolchainCellRegistry } from "@/daemon/worker/toolchain-cell-registry"
import { ProjectID } from "@/project/schema"
import { resolveProjectRepositoryIdentity, resolveProjectRuntimeIdentity } from "@/daemon/identity/project-identity"
import { WorkerID } from "@/daemon/identity/ids"
import { FencingEpochGenerator } from "@/daemon/protocol/fencing-epoch"

const cleanup: string[] = []

async function tempDir(prefix: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), prefix))
  cleanup.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

function runtime(worktree: string) {
  const repository = resolveProjectRepositoryIdentity({
    projectID: ProjectID.make("project-daemon-info"),
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

describe("daemon info service", () => {
  test("collects diagnostics snapshot for D-Gate style assertions", async () => {
    const dir = await tempDir("opencode-daemon-info-")
    const registry = new ServerRegistryStore(path.join(dir, "daemon", "master-registry.json"))
    const leaseRegistry = new ProjectWorkerLeaseRegistry(path.join(dir, "daemon", "project-worker-registry.json"))
    const laneController = new LaneController(path.join(dir, "daemon", "lane-registry.json"), () => 1_000)
    const cellRegistry = new ToolchainCellRegistry(path.join(dir, "daemon", "toolchain-cell-registry.json"), () => 500)

    const epoch = new FencingEpochGenerator(777).next(1_717_171_717_000)
    await registry.upsert({
      namespaceID: "local",
      endpoint: "http://127.0.0.1:7777",
      pid: process.pid,
      epoch,
      startedAt: 1_500,
      updatedAt: 1_900,
    })

    const rt = runtime("/tmp/daemon-info-a")
    const rtSecondary = runtime("/tmp/daemon-info-b")
    await leaseRegistry.put({
      workerID: WorkerID.make("worker.daemon-info.1"),
      runtime: rt,
      state: "hot",
      pid: 30001,
      startupEpoch: epoch,
      startedAt: 100,
      lastActiveAt: 900,
      laneCount: 1,
      toolchainCellCount: 1,
    })
    await leaseRegistry.put({
      workerID: WorkerID.make("worker.daemon-info.2"),
      runtime: rtSecondary,
      state: "warm-idle",
      pid: 30002,
      startupEpoch: epoch,
      startedAt: 100,
      lastActiveAt: 100,
      laneCount: 0,
      toolchainCellCount: 1,
    })

    const lane = await laneController.acquire({
      workerID: "worker.daemon-info.1",
      runtimeKey: rt.runtimeKey,
      sessionID: "session-daemon-info",
      directory: "/tmp/daemon-info-a",
    })
    await laneController.cancel({
      laneID: lane.laneID,
      reason: "network-drop",
      requestID: "req-daemon-info",
    })

    await cellRegistry.ensure({
      workerID: "worker.daemon-info.1",
      runtimeKey: rt.runtimeKey,
      laneID: lane.laneID,
      profile: {
        language: "typescript",
        runtime: "bun",
        env: {},
      },
    })
    await cellRegistry.ensure({
      workerID: "worker.daemon-info.2",
      runtimeKey: rtSecondary.runtimeKey,
      profile: {
        language: "go",
        runtime: "go",
        env: {},
      },
    })

    const metricsCollector = new WorkerMetricsCollector({
      leaseRegistry,
      laneController,
      cellRegistry,
      now: () => 3_000,
      limits: {
        maxWarmIdleWorkers: 0,
        maxIdleMs: 10_000,
      },
      cellIdleMs: 1_000,
    })

    const service = new DaemonInfoService({
      registry,
      metricsCollector,
      now: () => 3_000,
      publicListenerProvider: () => ({
        active: true,
        url: "http://0.0.0.0:7777",
        hostname: "0.0.0.0",
        port: 7777,
      }),
      watchdogTelemetryProvider: () => ({
        ticks: 12,
        reclaimedWorkers: 5,
        reclaimedByReason: {
          "idle-timeout-exceeded": 1,
          "warm-idle-budget-exceeded": 3,
          "over-max-workers": 1,
        },
        recycledCells: 7,
        orphanScans: 4,
        orphanEntriesScanned: 9,
        orphanActions: {
          adopt: 2,
          reap: 4,
          "reap-and-respawn": 3,
        },
        lastTickAt: 2_900,
      }),
    })

    const snapshot = await service.collect("local")

    expect(snapshot.master.active).toBe(true)
    expect(snapshot.master.pid).toBe(process.pid)
    expect(snapshot.publicListener?.active).toBe(true)

    expect(snapshot.metrics.workers.total).toBe(2)
    expect(snapshot.metrics.workers.byState.hot).toBe(1)
    expect(snapshot.metrics.workers.byState["warm-idle"]).toBe(1)
    expect(snapshot.metrics.workers.reclaimCandidates).toHaveLength(1)
    expect(snapshot.metrics.workers.reclaimCandidates[0]?.reason).toBe("warm-idle-budget-exceeded")

    expect(snapshot.metrics.lanes.total).toBe(1)
    expect(snapshot.metrics.lanes.byState.cancelled).toBe(1)
    expect(snapshot.metrics.lanes.resumableTokenCount).toBe(1)

    expect(snapshot.metrics.cells.total).toBe(2)
    expect(snapshot.metrics.cells.idleCount).toBeGreaterThanOrEqual(1)
    expect(snapshot.metrics.cells.recyclableCount).toBeGreaterThanOrEqual(1)

    expect(snapshot.watchdog?.orphanScans).toBe(4)
    expect(snapshot.watchdog?.orphanActions.reap).toBe(4)
  })
})
