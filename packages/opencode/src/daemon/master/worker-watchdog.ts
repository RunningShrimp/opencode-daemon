import type { FencingEpoch } from "@/daemon/protocol/fencing-epoch"
import type { OrphanAdoptionCoordinator, OrphanReconcileResult } from "@/daemon/worker/orphan-adoption-coordinator"
import type { LaneController } from "@/daemon/worker/lane-controller"
import type { ProjectWorkerLeaseRegistry } from "@/daemon/worker/project-worker-lease-registry"
import type { ToolchainCellRegistry } from "@/daemon/worker/toolchain-cell-registry"
import {
  WorkerResourceLimitsPolicy,
  type WorkerReclaimCandidate,
  type WorkerReclaimReason,
  type WorkerResourceLimits,
} from "@/daemon/worker/worker-resource-limits"

type OrphanAction = "adopt" | "reap" | "reap-and-respawn"

function defaultProcessAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function defaultReapProcess(pid: number) {
  process.kill(pid, "SIGTERM")
}

function createReasonCounter(): Record<WorkerReclaimReason, number> {
  return {
    "idle-timeout-exceeded": 0,
    "warm-idle-budget-exceeded": 0,
    "over-max-workers": 0,
  }
}

function createOrphanActionCounter(): Record<OrphanAction, number> {
  return {
    adopt: 0,
    reap: 0,
    "reap-and-respawn": 0,
  }
}

export interface WorkerWatchdogTelemetry {
  ticks: number
  reclaimedWorkers: number
  reclaimedByReason: Record<WorkerReclaimReason, number>
  recycledCells: number
  orphanScans: number
  orphanEntriesScanned: number
  orphanActions: Record<OrphanAction, number>
  lastTickAt?: number
}

export interface WorkerWatchdogTickReport {
  tickAt: number
  reclaimedWorkers: WorkerReclaimCandidate[]
  recycledCellIDs: string[]
  orphanScan?: {
    scanned: number
    actions: Record<OrphanAction, number>
  }
}

export interface WorkerWatchdogOptions {
  leaseRegistry: Pick<ProjectWorkerLeaseRegistry, "list" | "delete">
  laneController: Pick<LaneController, "list">
  cellRegistry: Pick<ToolchainCellRegistry, "list" | "recycle">
  orphanCoordinator?: Pick<OrphanAdoptionCoordinator, "reconcile">
  masterEpoch?: FencingEpoch | (() => FencingEpoch | undefined)
  now?: () => number
  isProcessAlive?: (pid: number) => boolean
  reapProcess?: (pid: number) => Promise<void> | void
  limits?: Partial<WorkerResourceLimits>
  cellIdleMs?: number
}

export class WorkerWatchdog {
  private readonly leaseRegistry: Pick<ProjectWorkerLeaseRegistry, "list" | "delete">
  private readonly laneController: Pick<LaneController, "list">
  private readonly cellRegistry: Pick<ToolchainCellRegistry, "list" | "recycle">
  private readonly orphanCoordinator?: Pick<OrphanAdoptionCoordinator, "reconcile">
  private readonly masterEpoch?: FencingEpoch | (() => FencingEpoch | undefined)
  private readonly now: () => number
  private readonly isProcessAlive: (pid: number) => boolean
  private readonly reapProcess: (pid: number) => Promise<void> | void
  private readonly limits?: Partial<WorkerResourceLimits>
  private readonly cellIdleMs: number
  private timer: ReturnType<typeof setInterval> | undefined
  private activeTick: Promise<WorkerWatchdogTickReport> | undefined
  private readonly state: WorkerWatchdogTelemetry = {
    ticks: 0,
    reclaimedWorkers: 0,
    reclaimedByReason: createReasonCounter(),
    recycledCells: 0,
    orphanScans: 0,
    orphanEntriesScanned: 0,
    orphanActions: createOrphanActionCounter(),
  }

  constructor(options: WorkerWatchdogOptions) {
    this.leaseRegistry = options.leaseRegistry
    this.laneController = options.laneController
    this.cellRegistry = options.cellRegistry
    this.orphanCoordinator = options.orphanCoordinator
    this.masterEpoch = options.masterEpoch
    this.now = options.now ?? (() => Date.now())
    this.isProcessAlive = options.isProcessAlive ?? defaultProcessAlive
    this.reapProcess = options.reapProcess ?? defaultReapProcess
    this.limits = options.limits
    this.cellIdleMs = Math.max(1, Math.floor(options.cellIdleMs ?? 10 * 60 * 1000))
  }

  telemetry(): WorkerWatchdogTelemetry {
    return {
      ...this.state,
      reclaimedByReason: { ...this.state.reclaimedByReason },
      orphanActions: { ...this.state.orphanActions },
    }
  }

  start(intervalMs = 5_000) {
    if (this.timer) return
    const normalized = Math.max(250, Math.floor(intervalMs))
    this.timer = setInterval(() => {
      void this.tick().catch(() => {
        // Keep watchdog alive across transient failures.
      })
    }, normalized)
  }

  stop() {
    if (!this.timer) return
    clearInterval(this.timer)
    this.timer = undefined
  }

  async tick(): Promise<WorkerWatchdogTickReport> {
    if (this.activeTick) return this.activeTick

    this.activeTick = this.executeTick().finally(() => {
      this.activeTick = undefined
    })
    return this.activeTick
  }

  private async executeTick(): Promise<WorkerWatchdogTickReport> {
    const tickAt = this.now()
    const workers = await this.leaseRegistry.list()
    const reclaimedWorkers = await this.reclaimWorkers(workers, tickAt)
    const recycledCellIDs = await this.recycleIdleCells(tickAt)
    const orphanScan = await this.scanOrphans()

    this.state.ticks += 1
    this.state.reclaimedWorkers += reclaimedWorkers.length
    for (const candidate of reclaimedWorkers) {
      this.state.reclaimedByReason[candidate.reason] += 1
    }
    this.state.recycledCells += recycledCellIDs.length
    this.state.lastTickAt = tickAt

    if (orphanScan) {
      this.state.orphanScans += 1
      this.state.orphanEntriesScanned += orphanScan.scanned
      for (const action of Object.keys(orphanScan.actions) as OrphanAction[]) {
        this.state.orphanActions[action] += orphanScan.actions[action]
      }
    }

    return {
      tickAt,
      reclaimedWorkers,
      recycledCellIDs,
      orphanScan,
    }
  }

  private async reclaimWorkers(workers: Awaited<ReturnType<ProjectWorkerLeaseRegistry["list"]>>, now: number) {
    const candidates = WorkerResourceLimitsPolicy.evaluate({
      workers,
      now,
      limits: this.limits,
    })

    const reclaimed: WorkerReclaimCandidate[] = []
    for (const candidate of candidates) {
      if (candidate.pid && this.isProcessAlive(candidate.pid)) {
        await this.reapProcess(candidate.pid)
      }
      await this.leaseRegistry.delete(candidate.runtimeKey)
      reclaimed.push(candidate)
    }
    return reclaimed
  }

  private async recycleIdleCells(now: number): Promise<string[]> {
    const [cells, lanes] = await Promise.all([this.cellRegistry.list(), this.laneController.list()])
    const activeLaneIDs = new Set(lanes.filter((lane) => lane.state === "active").map((lane) => lane.laneID))

    const recycledCellIDs: string[] = []
    for (const cell of cells) {
      if (cell.state === "recycled") continue
      if (cell.boundLaneIDs.some((laneID) => activeLaneIDs.has(laneID))) continue
      const idleFor = now - (cell.lastUsedAt ?? cell.createdAt)
      if (idleFor < this.cellIdleMs) continue
      const recycled = await this.cellRegistry.recycle({
        cellID: cell.cellID,
        reason: "watchdog-idle-recycle",
      })
      if (recycled) recycledCellIDs.push(recycled.cellID)
    }

    return recycledCellIDs
  }

  private async scanOrphans(): Promise<WorkerWatchdogTickReport["orphanScan"]> {
    if (!this.orphanCoordinator) return
    const masterEpoch = typeof this.masterEpoch === "function" ? this.masterEpoch() : this.masterEpoch
    if (!masterEpoch) return

    const result = await this.orphanCoordinator.reconcile({ masterEpoch })
    return summarizeOrphanResult(result)
  }
}

function summarizeOrphanResult(result: OrphanReconcileResult) {
  const actions = createOrphanActionCounter()
  for (const entry of result.entries) {
    actions[entry.action] += 1
  }
  return {
    scanned: result.entries.length,
    actions,
  }
}