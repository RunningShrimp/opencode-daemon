import type { FencingEpoch } from "./fencing-epoch"
import { compareFencingEpoch } from "./fencing-epoch"

export type OrphanAdoptionAction = "adopt" | "reap" | "reap-and-respawn"
export type OrphanAdoptionReason =
  | "worker-epoch-newer"
  | "worker-stale-epoch"
  | "worker-unresponsive"
  | "worker-state-incomplete"
  | "worker-not-recoverable"
  | "worker-safe-to-adopt"

export const ORPHAN_ADOPTION_RULESET_VERSION = "orphan-adoption-v1" as const

export interface OrphanWorkerHealth {
  responsive: boolean
  stateComplete: boolean
  hasRecoverableState: boolean
}

export interface OrphanAdoptionDecisionInput {
  masterEpoch: FencingEpoch
  workerEpoch: FencingEpoch
  health: OrphanWorkerHealth
}

export interface OrphanAdoptionDecision {
  action: OrphanAdoptionAction
  reason: OrphanAdoptionReason
}

export interface OrphanAdoptionDecisionLog {
  rulesetVersion: typeof ORPHAN_ADOPTION_RULESET_VERSION
  observedAt: number
  runtimeKey: string
  workerID: string
  workerPID?: number
  masterEpoch: FencingEpoch
  workerEpoch: FencingEpoch
  health: OrphanWorkerHealth
  action: OrphanAdoptionAction
  reason: OrphanAdoptionReason
}

export interface OrphanAdoptionDecisionLogInput {
  observedAt: number
  runtimeKey: string
  workerID: string
  workerPID?: number
  masterEpoch: FencingEpoch
  workerEpoch: FencingEpoch
  health: OrphanWorkerHealth
  decision: OrphanAdoptionDecision
}

export function createOrphanAdoptionDecisionLog(input: OrphanAdoptionDecisionLogInput): OrphanAdoptionDecisionLog {
  return {
    rulesetVersion: ORPHAN_ADOPTION_RULESET_VERSION,
    observedAt: input.observedAt,
    runtimeKey: input.runtimeKey,
    workerID: input.workerID,
    workerPID: input.workerPID,
    masterEpoch: input.masterEpoch,
    workerEpoch: input.workerEpoch,
    health: input.health,
    action: input.decision.action,
    reason: input.decision.reason,
  }
}

export const OrphanAdoptionProtocol = {
  decide(input: OrphanAdoptionDecisionInput): OrphanAdoptionDecision {
    const epochCompare = compareFencingEpoch(input.workerEpoch, input.masterEpoch)

    if (!input.health.responsive) {
      return {
        action: "reap-and-respawn",
        reason: "worker-unresponsive",
      }
    }

    if (epochCompare < 0) {
      return {
        action: "reap-and-respawn",
        reason: "worker-stale-epoch",
      }
    }

    if (epochCompare > 0) {
      return {
        action: "reap",
        reason: "worker-epoch-newer",
      }
    }

    if (!input.health.stateComplete) {
      return {
        action: "reap-and-respawn",
        reason: "worker-state-incomplete",
      }
    }

    if (!input.health.hasRecoverableState) {
      return {
        action: "reap-and-respawn",
        reason: "worker-not-recoverable",
      }
    }

    return {
      action: "adopt",
      reason: "worker-safe-to-adopt",
    }
  },
}
