import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { WorkerWatchdog } from "@/daemon/master/worker-watchdog"
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
    projectID: ProjectID.make("project-watchdog"),
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

describe("worker watchdog", () => {
  test("reclaims warm-idle workers, recycles idle cells, and tracks orphan telemetry", async () => {
    const dir = await tempDir("opencode-watchdog-")
    const leaseRegistry = new ProjectWorkerLeaseRegistry(path.join(dir, "daemon", "workers.json"))
    const laneController = new LaneController(path.join(dir, "daemon", "lanes.json"), () => 10)
    const cellRegistry = new ToolchainCellRegistry(path.join(dir, "daemon", "cells.json"), () => 0)

    const rt = runtime("/tmp/watchdog-a")
    const epoch = new FencingEpochGenerator(999).next(1_700_000_000_000)

    await leaseRegistry.put({
      workerID: WorkerID.make("worker.watchdog.1"),
      runtime: rt,
      state: "warm-idle",
      pid: 4242,
      startupEpoch: epoch,
      startedAt: 0,
      lastActiveAt: 0,
      laneCount: 0,
      toolchainCellCount: 1,
    })

    const cell = await cellRegistry.ensure({
      workerID: "worker.watchdog.1",
      runtimeKey: rt.runtimeKey,
      profile: {
        language: "typescript",
        runtime: "bun",
        env: {},
      },
    })

    const killedPIDs: number[] = []
    const watchdog = new WorkerWatchdog({
      leaseRegistry,
      laneController,
      cellRegistry,
      limits: {
        maxWarmIdleWorkers: 0,
        maxIdleMs: 60_000,
      },
      now: () => 2_000,
      cellIdleMs: 1_000,
      isProcessAlive: (pid) => pid === 4242,
      reapProcess: async (pid) => {
        killedPIDs.push(pid)
      },
      orphanCoordinator: {
        async reconcile() {
          return {
            entries: [
              {
                runtimeKey: rt.runtimeKey,
                workerID: "worker.orphan.1",
                action: "reap",
                reason: "worker-unresponsive",
                decisionLog: {
                  rulesetVersion: "orphan-adoption-v1",
                  observedAt: 2_000,
                  runtimeKey: rt.runtimeKey,
                  workerID: "worker.orphan.1",
                  workerPID: 5151,
                  masterEpoch: epoch,
                  workerEpoch: epoch,
                  health: {
                    responsive: false,
                    stateComplete: false,
                    hasRecoverableState: false,
                  },
                  action: "reap",
                  reason: "worker-unresponsive",
                },
              },
            ],
          }
        },
      },
      masterEpoch: epoch,
    })

    const report = await watchdog.tick()

    expect(report.reclaimedWorkers).toHaveLength(1)
    expect(report.reclaimedWorkers[0]?.reason).toBe("warm-idle-budget-exceeded")
    expect(killedPIDs).toEqual([4242])

    expect(report.recycledCellIDs).toContain(cell.cellID)
    expect(report.orphanScan?.scanned).toBe(1)
    expect(report.orphanScan?.actions.reap).toBe(1)

    const telemetry = watchdog.telemetry()
    expect(telemetry.ticks).toBe(1)
    expect(telemetry.reclaimedWorkers).toBe(1)
    expect(telemetry.recycledCells).toBe(1)
    expect(telemetry.orphanScans).toBe(1)
    expect(telemetry.orphanEntriesScanned).toBe(1)
    expect(telemetry.orphanActions.reap).toBe(1)

    const remaining = await leaseRegistry.get(rt.runtimeKey)
    expect(remaining).toBeUndefined()
  })
})
