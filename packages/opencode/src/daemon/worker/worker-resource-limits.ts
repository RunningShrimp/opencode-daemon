import type { ProjectRuntimeKey } from "@/daemon/identity/runtime-key"
import type { ProjectWorkerDescriptor } from "@/daemon/worker/worker-descriptor"

export type WorkerReclaimReason = "idle-timeout-exceeded" | "warm-idle-budget-exceeded" | "over-max-workers"

export interface WorkerResourceLimits {
  maxWorkers: number
  maxWarmIdleWorkers: number
  maxIdleMs: number
}

export interface WorkerReclaimCandidate {
  runtimeKey: ProjectRuntimeKey
  workerID: string
  pid?: number
  reason: WorkerReclaimReason
  idleForMs: number
}

export interface EvaluateWorkerReclamationInput {
  workers: ProjectWorkerDescriptor[]
  now?: number
  limits?: Partial<WorkerResourceLimits>
}

const DEFAULT_LIMITS: WorkerResourceLimits = {
  maxWorkers: 8,
  maxWarmIdleWorkers: 2,
  maxIdleMs: 10 * 60 * 1000,
}

function resolveLimits(input?: Partial<WorkerResourceLimits>): WorkerResourceLimits {
  return {
    maxWorkers: Math.max(1, Math.floor(input?.maxWorkers ?? DEFAULT_LIMITS.maxWorkers)),
    maxWarmIdleWorkers: Math.max(0, Math.floor(input?.maxWarmIdleWorkers ?? DEFAULT_LIMITS.maxWarmIdleWorkers)),
    maxIdleMs: Math.max(1, Math.floor(input?.maxIdleMs ?? DEFAULT_LIMITS.maxIdleMs)),
  }
}

function isIdleWorker(worker: ProjectWorkerDescriptor): boolean {
  if (worker.state === "terminated" || worker.state === "draining") return false
  if (worker.laneCount > 0) return false
  return worker.state === "warm-idle" || worker.state === "cold"
}

function idleTimestamp(worker: ProjectWorkerDescriptor): number {
  return worker.lastActiveAt ?? worker.startedAt ?? 0
}

function idleDuration(worker: ProjectWorkerDescriptor, now: number): number {
  return Math.max(0, now - idleTimestamp(worker))
}

function uniqueByWorkerID(candidates: WorkerReclaimCandidate[]): WorkerReclaimCandidate[] {
  const seen = new Set<string>()
  const result: WorkerReclaimCandidate[] = []
  for (const candidate of candidates) {
    if (seen.has(candidate.workerID)) continue
    seen.add(candidate.workerID)
    result.push(candidate)
  }
  return result
}

export function evaluateWorkerReclamation(input: EvaluateWorkerReclamationInput): WorkerReclaimCandidate[] {
  const now = input.now ?? Date.now()
  const limits = resolveLimits(input.limits)
  const idleWorkers = input.workers.filter((worker) => isIdleWorker(worker))
  const oldestIdleFirst = [...idleWorkers].sort((left, right) => idleTimestamp(left) - idleTimestamp(right))

  const candidates: WorkerReclaimCandidate[] = []

  for (const worker of oldestIdleFirst) {
    const idleForMs = idleDuration(worker, now)
    if (idleForMs < limits.maxIdleMs) continue
    candidates.push({
      runtimeKey: worker.runtime.runtimeKey,
      workerID: worker.workerID,
      pid: worker.pid,
      reason: "idle-timeout-exceeded",
      idleForMs,
    })
  }

  const warmIdleWorkers = oldestIdleFirst.filter((worker) => worker.state === "warm-idle")
  if (warmIdleWorkers.length > limits.maxWarmIdleWorkers) {
    const reclaimCount = warmIdleWorkers.length - limits.maxWarmIdleWorkers
    for (const worker of warmIdleWorkers.slice(0, reclaimCount)) {
      candidates.push({
        runtimeKey: worker.runtime.runtimeKey,
        workerID: worker.workerID,
        pid: worker.pid,
        reason: "warm-idle-budget-exceeded",
        idleForMs: idleDuration(worker, now),
      })
    }
  }

  const overflow = input.workers.length - limits.maxWorkers
  if (overflow > 0) {
    const notAlreadySelected = oldestIdleFirst.filter((worker) => !candidates.some((x) => x.workerID === worker.workerID))
    for (const worker of notAlreadySelected.slice(0, overflow)) {
      candidates.push({
        runtimeKey: worker.runtime.runtimeKey,
        workerID: worker.workerID,
        pid: worker.pid,
        reason: "over-max-workers",
        idleForMs: idleDuration(worker, now),
      })
    }
  }

  return uniqueByWorkerID(candidates)
}

export const WorkerResourceLimitsPolicy = {
  defaults(): WorkerResourceLimits {
    return { ...DEFAULT_LIMITS }
  },
  evaluate: evaluateWorkerReclamation,
}
