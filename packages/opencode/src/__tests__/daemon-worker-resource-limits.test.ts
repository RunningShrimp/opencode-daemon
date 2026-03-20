import { describe, expect, test } from "bun:test"
import { ProjectID } from "@/project/schema"
import { resolveProjectRepositoryIdentity, resolveProjectRuntimeIdentity } from "@/daemon/identity/project-identity"
import { FencingEpochGenerator } from "@/daemon/protocol/fencing-epoch"
import { WorkerID } from "@/daemon/identity/ids"
import type { ProjectWorkerDescriptor } from "@/daemon/worker/worker-descriptor"
import { evaluateWorkerReclamation, WorkerResourceLimitsPolicy } from "@/daemon/worker/worker-resource-limits"

function worker(input: {
  id: string
  projectID: string
  worktree: string
  state: ProjectWorkerDescriptor["state"]
  laneCount: number
  startedAt: number
  lastActiveAt?: number
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
    workerID: WorkerID.make(input.id),
    runtime,
    state: input.state,
    pid: input.pid,
    startupEpoch: new FencingEpochGenerator(input.pid).next(input.startedAt),
    startedAt: input.startedAt,
    lastActiveAt: input.lastActiveAt,
    laneCount: input.laneCount,
    toolchainCellCount: 1,
  }
}

describe("worker resource limits policy", () => {
  test("exposes sane defaults", () => {
    const defaults = WorkerResourceLimitsPolicy.defaults()
    expect(defaults.maxWorkers).toBeGreaterThan(0)
    expect(defaults.maxWarmIdleWorkers).toBeGreaterThanOrEqual(0)
    expect(defaults.maxIdleMs).toBeGreaterThan(0)
  })

  test("reclaims workers idle longer than maxIdleMs", () => {
    const now = 1_700_000_500_000
    const candidates = evaluateWorkerReclamation({
      now,
      limits: {
        maxIdleMs: 1000,
      },
      workers: [
        worker({
          id: "worker.idle.old",
          projectID: "project-a",
          worktree: "/tmp/a",
          state: "warm-idle",
          laneCount: 0,
          startedAt: now - 10_000,
          lastActiveAt: now - 5_000,
          pid: 70001,
        }),
        worker({
          id: "worker.idle.fresh",
          projectID: "project-b",
          worktree: "/tmp/b",
          state: "warm-idle",
          laneCount: 0,
          startedAt: now - 1_000,
          lastActiveAt: now - 200,
          pid: 70002,
        }),
      ],
    })

    expect(candidates.some((x) => x.workerID === "worker.idle.old" && x.reason === "idle-timeout-exceeded")).toBe(true)
    expect(candidates.some((x) => x.workerID === "worker.idle.fresh")).toBe(false)
  })

  test("reclaims oldest warm-idle workers when warm idle budget is exceeded", () => {
    const now = 1_700_000_500_000
    const candidates = evaluateWorkerReclamation({
      now,
      limits: {
        maxWarmIdleWorkers: 1,
        maxIdleMs: 999_999_999,
      },
      workers: [
        worker({
          id: "worker.warm.oldest",
          projectID: "project-c1",
          worktree: "/tmp/c1",
          state: "warm-idle",
          laneCount: 0,
          startedAt: now - 10_000,
          lastActiveAt: now - 9_000,
          pid: 70003,
        }),
        worker({
          id: "worker.warm.newer",
          projectID: "project-c2",
          worktree: "/tmp/c2",
          state: "warm-idle",
          laneCount: 0,
          startedAt: now - 8_000,
          lastActiveAt: now - 7_000,
          pid: 70004,
        }),
      ],
    })

    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.workerID).toBe("worker.warm.oldest")
    expect(candidates[0]?.reason).toBe("warm-idle-budget-exceeded")
  })

  test("when total workers exceed maxWorkers, reclaims oldest idle workers first", () => {
    const now = 1_700_000_500_000
    const candidates = evaluateWorkerReclamation({
      now,
      limits: {
        maxWorkers: 2,
        maxWarmIdleWorkers: 10,
        maxIdleMs: 999_999_999,
      },
      workers: [
        worker({
          id: "worker.active",
          projectID: "project-d1",
          worktree: "/tmp/d1",
          state: "hot",
          laneCount: 2,
          startedAt: now - 20_000,
          lastActiveAt: now - 100,
          pid: 70005,
        }),
        worker({
          id: "worker.idle.old",
          projectID: "project-d2",
          worktree: "/tmp/d2",
          state: "warm-idle",
          laneCount: 0,
          startedAt: now - 15_000,
          lastActiveAt: now - 14_000,
          pid: 70006,
        }),
        worker({
          id: "worker.idle.new",
          projectID: "project-d3",
          worktree: "/tmp/d3",
          state: "cold",
          laneCount: 0,
          startedAt: now - 12_000,
          lastActiveAt: now - 11_000,
          pid: 70007,
        }),
      ],
    })

    expect(candidates).toHaveLength(1)
    expect(candidates[0]?.workerID).toBe("worker.idle.old")
    expect(candidates[0]?.reason).toBe("over-max-workers")
  })
})
