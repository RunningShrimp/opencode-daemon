import type { ProjectRuntimeKey } from "@/daemon/identity/runtime-key"
import type { FencingEpoch } from "@/daemon/protocol/fencing-epoch"
import {
  createOrphanAdoptionDecisionLog,
  type OrphanAdoptionAction,
  OrphanAdoptionProtocol,
  type OrphanAdoptionReason,
  type OrphanAdoptionDecisionLog,
  type OrphanWorkerHealth,
} from "@/daemon/protocol/orphan-adoption"
import type { ProjectWorkerLeaseRegistry } from "@/daemon/worker/project-worker-lease-registry"
import type { ProjectWorkerDescriptor } from "@/daemon/worker/worker-descriptor"
import type { WorkerSupervisor, EnsureWorkerResult } from "@/daemon/worker/worker-supervisor"

export interface OrphanReconcileInput {
  masterEpoch: FencingEpoch
  runtimeKeys?: ProjectRuntimeKey[]
}

export interface OrphanReconcileEntry {
  runtimeKey: ProjectRuntimeKey
  workerID: string
  action: OrphanAdoptionAction
  reason: OrphanAdoptionReason
  pid?: number
  replacementWorkerID?: string
  decisionLog: OrphanAdoptionDecisionLog
}

export interface OrphanReconcileResult {
  entries: OrphanReconcileEntry[]
}

export interface OrphanAdoptionCoordinatorOptions {
  leaseRegistry: Pick<ProjectWorkerLeaseRegistry, "list" | "delete">
  workerSupervisor: Pick<WorkerSupervisor, "ensureWorker">
  probeHealth?: (worker: ProjectWorkerDescriptor) => Promise<OrphanWorkerHealth> | OrphanWorkerHealth
  isProcessAlive?: (pid: number) => boolean
  reapProcess?: (pid: number) => Promise<void> | void
  now?: () => number
}

function defaultProcessAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function defaultReapProcess(pid: number) {
  process.kill(pid, "SIGTERM")
}

function defaultHealthProbe(worker: ProjectWorkerDescriptor, isProcessAlive: (pid: number) => boolean): OrphanWorkerHealth {
  const responsive = worker.pid ? isProcessAlive(worker.pid) : false
  const stateComplete = worker.state !== "terminated"
  const hasRecoverableState = worker.state !== "terminated"
  return {
    responsive,
    stateComplete,
    hasRecoverableState,
  }
}

export class OrphanAdoptionCoordinator {
  private readonly leaseRegistry: Pick<ProjectWorkerLeaseRegistry, "list" | "delete">
  private readonly workerSupervisor: Pick<WorkerSupervisor, "ensureWorker">
  private readonly isProcessAlive: (pid: number) => boolean
  private readonly reapProcess: (pid: number) => Promise<void> | void
  private readonly probeHealth: (worker: ProjectWorkerDescriptor) => Promise<OrphanWorkerHealth> | OrphanWorkerHealth
  private readonly now: () => number

  constructor(options: OrphanAdoptionCoordinatorOptions) {
    this.leaseRegistry = options.leaseRegistry
    this.workerSupervisor = options.workerSupervisor
    this.isProcessAlive = options.isProcessAlive ?? defaultProcessAlive
    this.reapProcess = options.reapProcess ?? defaultReapProcess
    this.now = options.now ?? (() => Date.now())
    this.probeHealth =
      options.probeHealth ??
      ((worker) => {
        return defaultHealthProbe(worker, this.isProcessAlive)
      })
  }

  async reconcile(input: OrphanReconcileInput): Promise<OrphanReconcileResult> {
    const runtimeFilter = input.runtimeKeys ? new Set(input.runtimeKeys) : undefined
    const entries = (await this.leaseRegistry.list()).filter((entry) =>
      runtimeFilter ? runtimeFilter.has(entry.runtime.runtimeKey) : true,
    )

    const decisions: OrphanReconcileEntry[] = []

    for (const entry of entries) {
      const health = await this.probeHealth(entry)
      const observedAt = this.now()
      const decision = OrphanAdoptionProtocol.decide({
        masterEpoch: input.masterEpoch,
        workerEpoch: entry.startupEpoch,
        health,
      })
      const decisionLog = createOrphanAdoptionDecisionLog({
        observedAt,
        runtimeKey: entry.runtime.runtimeKey,
        workerID: entry.workerID,
        workerPID: entry.pid,
        masterEpoch: input.masterEpoch,
        workerEpoch: entry.startupEpoch,
        health,
        decision,
      })

      let ensureResult: EnsureWorkerResult | undefined

      if (decision.action === "reap" || decision.action === "reap-and-respawn") {
        if (entry.pid && this.isProcessAlive(entry.pid)) {
          await this.reapProcess(entry.pid)
        }
        await this.leaseRegistry.delete(entry.runtime.runtimeKey)
      }

      if (decision.action === "reap-and-respawn") {
        ensureResult = await this.workerSupervisor.ensureWorker({
          namespaceID: entry.runtime.namespaceID,
          directory: entry.runtime.worktree,
          forceRestart: true,
          detached: true,
        })
      }

      decisions.push({
        runtimeKey: entry.runtime.runtimeKey,
        workerID: entry.workerID,
        action: decision.action,
        reason: decision.reason,
        pid: entry.pid,
        replacementWorkerID: ensureResult?.descriptor.workerID,
        decisionLog,
      })
    }

    return {
      entries: decisions,
    }
  }
}
