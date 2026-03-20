import { WorkerResourceLimitsPolicy, type WorkerReclaimCandidate, type WorkerResourceLimits } from "@/daemon/worker/worker-resource-limits"
import type { ProjectWorkerLeaseRegistry } from "@/daemon/worker/project-worker-lease-registry"
import type { LaneController } from "@/daemon/worker/lane-controller"
import type { ToolchainCellRegistry } from "@/daemon/worker/toolchain-cell-registry"
import type { ProjectWorkerDescriptor, WorkerState } from "@/daemon/worker/worker-descriptor"
import type { ClientLaneDescriptor, LaneState } from "@/daemon/worker/client-lane-descriptor"
import type { ToolchainCellDescriptor, ToolchainCellState } from "@/daemon/worker/toolchain-cell-descriptor"

const WORKER_STATES: WorkerState[] = ["cold", "starting", "hot", "warm-idle", "draining", "terminated"]
const LANE_STATES: LaneState[] = ["active", "released", "cancelled", "rebuilding"]
const CELL_STATES: ToolchainCellState[] = ["active", "suspended", "recycled"]

function countByState<TState extends string>(states: TState[], items: Array<{ state: TState }>): Record<TState, number> {
  const counts = Object.fromEntries(states.map((state) => [state, 0])) as Record<TState, number>
  for (const item of items) {
    counts[item.state] = (counts[item.state] ?? 0) + 1
  }
  return counts
}

function hasActiveLaneBinding(cell: ToolchainCellDescriptor, activeLaneIDs: Set<string>) {
  if (cell.boundLaneIDs.length === 0) return false
  return cell.boundLaneIDs.some((laneID) => activeLaneIDs.has(laneID))
}

export interface WorkerMetricsSnapshot {
  capturedAt: number
  workers: {
    total: number
    byState: Record<WorkerState, number>
    warmIdleCount: number
    reclaimCandidates: WorkerReclaimCandidate[]
  }
  lanes: {
    total: number
    byState: Record<LaneState, number>
    resumableTokenCount: number
  }
  cells: {
    total: number
    byState: Record<ToolchainCellState, number>
    idleCount: number
    recyclableCount: number
  }
}

export interface WorkerMetricsCollectorOptions {
  leaseRegistry?: Pick<ProjectWorkerLeaseRegistry, "list">
  laneController?: Pick<LaneController, "list">
  cellRegistry?: Pick<ToolchainCellRegistry, "list">
  now?: () => number
  limits?: Partial<WorkerResourceLimits>
  cellIdleMs?: number
}

export class WorkerMetricsCollector {
  private readonly leaseRegistry: Pick<ProjectWorkerLeaseRegistry, "list">
  private readonly laneController: Pick<LaneController, "list">
  private readonly cellRegistry: Pick<ToolchainCellRegistry, "list">
  private readonly now: () => number
  private readonly limits?: Partial<WorkerResourceLimits>
  private readonly cellIdleMs: number

  constructor(options: WorkerMetricsCollectorOptions) {
    if (!options.leaseRegistry) throw new Error("leaseRegistry is required")
    if (!options.laneController) throw new Error("laneController is required")
    if (!options.cellRegistry) throw new Error("cellRegistry is required")

    this.leaseRegistry = options.leaseRegistry
    this.laneController = options.laneController
    this.cellRegistry = options.cellRegistry
    this.now = options.now ?? (() => Date.now())
    this.limits = options.limits
    this.cellIdleMs = Math.max(1, Math.floor(options.cellIdleMs ?? 10 * 60 * 1000))
  }

  async collect(): Promise<WorkerMetricsSnapshot> {
    const capturedAt = this.now()

    const [workers, lanes, cells] = await Promise.all([
      this.leaseRegistry.list(),
      this.laneController.list(),
      this.cellRegistry.list(),
    ])

    const reclaimCandidates = WorkerResourceLimitsPolicy.evaluate({
      workers,
      now: capturedAt,
      limits: this.limits,
    })

    const activeLaneIDs = new Set(lanes.filter((lane) => lane.state === "active").map((lane) => lane.laneID))
    const idleCells = cells.filter((cell) => {
      if (cell.state === "recycled") return false
      if (hasActiveLaneBinding(cell, activeLaneIDs)) return false
      return true
    })
    const recyclableCells = idleCells.filter((cell) => capturedAt - (cell.lastUsedAt ?? cell.createdAt) >= this.cellIdleMs)

    return {
      capturedAt,
      workers: {
        total: workers.length,
        byState: countByState(WORKER_STATES, workers as Array<{ state: WorkerState }>),
        warmIdleCount: workers.filter((worker) => worker.state === "warm-idle").length,
        reclaimCandidates,
      },
      lanes: {
        total: lanes.length,
        byState: countByState(LANE_STATES, lanes as Array<{ state: LaneState }>),
        resumableTokenCount: this.resumableTokenCount(lanes),
      },
      cells: {
        total: cells.length,
        byState: countByState(CELL_STATES, cells as Array<{ state: ToolchainCellState }>),
        idleCount: idleCells.length,
        recyclableCount: recyclableCells.length,
      },
    }
  }

  private resumableTokenCount(lanes: ClientLaneDescriptor[]) {
    const activeTokens = new Set(lanes.filter((lane) => lane.state === "active" && lane.resumeToken).map((lane) => lane.resumeToken as string))
    const resumableTokens = new Set<string>()

    for (const lane of lanes) {
      if (!lane.resumeToken) continue
      if (lane.state !== "cancelled" && lane.state !== "rebuilding") continue
      if (activeTokens.has(lane.resumeToken)) continue
      resumableTokens.add(lane.resumeToken)
    }

    return resumableTokens.size
  }
}

export function createWorkerMetricsCollector(options: WorkerMetricsCollectorOptions) {
  return new WorkerMetricsCollector(options)
}