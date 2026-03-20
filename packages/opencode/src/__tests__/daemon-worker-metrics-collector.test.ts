import { describe, expect, test } from "bun:test"
import { WorkerMetricsCollector } from "@/daemon/master/worker-metrics"
import { ProjectID } from "@/project/schema"
import { resolveProjectRepositoryIdentity, resolveProjectRuntimeIdentity } from "@/daemon/identity/project-identity"
import { FencingEpochGenerator } from "@/daemon/protocol/fencing-epoch"

function runtime(worktree: string) {
  const repository = resolveProjectRepositoryIdentity({
    projectID: ProjectID.make("project-metrics"),
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

describe("worker metrics collector", () => {
  test("collects worker/lane/cell snapshot and reclamation candidates", async () => {
    const rt = runtime("/tmp/metrics-a")
    const epochGenerator = new FencingEpochGenerator(321)
    const collector = new WorkerMetricsCollector({
      leaseRegistry: {
        async list() {
          return [
            {
              workerID: "worker.metrics.1",
              runtime: rt,
              state: "warm-idle",
              pid: 101,
              startupEpoch: epochGenerator.next(1_700_000_000_001),
              startedAt: 0,
              lastActiveAt: 100,
              laneCount: 0,
              toolchainCellCount: 1,
            },
            {
              workerID: "worker.metrics.2",
              runtime: rt,
              state: "hot",
              pid: 102,
              startupEpoch: epochGenerator.next(1_700_000_000_002),
              startedAt: 1_000,
              lastActiveAt: 1_900,
              laneCount: 1,
              toolchainCellCount: 1,
            },
          ]
        },
      },
      laneController: {
        async list() {
          return [
            {
              laneID: "lane.metrics.active",
              workerID: "worker.metrics.2",
              runtimeKey: rt.runtimeKey,
              sessionID: "session-active",
              directory: "/tmp/metrics-a",
              state: "active",
              acquiredAt: 1_000,
              lastHeartbeatAt: 1_900,
            },
            {
              laneID: "lane.metrics.cancelled",
              workerID: "worker.metrics.1",
              runtimeKey: rt.runtimeKey,
              sessionID: "session-cancelled",
              directory: "/tmp/metrics-a",
              state: "cancelled",
              acquiredAt: 900,
              lastHeartbeatAt: 1_200,
              cancelledAt: 1_200,
              cancelReason: "drop",
              cancelRequestID: "req-1",
              resumeToken: "resume.metrics.token",
            },
          ]
        },
      },
      cellRegistry: {
        async list() {
          return [
            {
              cellID: "cell.metrics.idle",
              workerID: "worker.metrics.1",
              runtimeKey: rt.runtimeKey,
              profile: {
                language: "typescript",
                runtime: "bun",
                env: {},
                envFingerprint: rt.envFingerprint,
              },
              state: "active",
              createdAt: 0,
              lastUsedAt: 100,
              boundLaneIDs: [],
            },
            {
              cellID: "cell.metrics.bound",
              workerID: "worker.metrics.2",
              runtimeKey: rt.runtimeKey,
              profile: {
                language: "typescript",
                runtime: "bun",
                env: {},
                envFingerprint: rt.envFingerprint,
              },
              state: "active",
              createdAt: 0,
              lastUsedAt: 1_900,
              boundLaneIDs: ["lane.metrics.active"],
            },
          ]
        },
      },
      now: () => 2_000,
      cellIdleMs: 500,
      limits: {
        maxWarmIdleWorkers: 0,
        maxIdleMs: 9_999,
      },
    })

    const snapshot = await collector.collect()

    expect(snapshot.workers.total).toBe(2)
    expect(snapshot.workers.byState["warm-idle"]).toBe(1)
    expect(snapshot.workers.reclaimCandidates).toHaveLength(1)
    expect(snapshot.workers.reclaimCandidates[0]?.reason).toBe("warm-idle-budget-exceeded")

    expect(snapshot.lanes.total).toBe(2)
    expect(snapshot.lanes.byState.active).toBe(1)
    expect(snapshot.lanes.byState.cancelled).toBe(1)
    expect(snapshot.lanes.resumableTokenCount).toBe(1)

    expect(snapshot.cells.total).toBe(2)
    expect(snapshot.cells.idleCount).toBe(1)
    expect(snapshot.cells.recyclableCount).toBe(1)
  })
})
