export type LaneSideEffectState =
  | "pending"
  | "accepted"
  | "running"
  | "completed"
  | "cancelled"
  | "failed"
  | "unknown"
  | "partially-applied"

export type LaneSideEffectEvent =
  | "accepted"
  | "start"
  | "complete"
  | "cancel"
  | "fail"
  | "mark-unknown"
  | "mark-partially-applied"

const TERMINAL_STATES = new Set<LaneSideEffectState>([
  "completed",
  "cancelled",
  "failed",
  "unknown",
  "partially-applied",
])

export function isTerminalLaneSideEffectState(state: LaneSideEffectState): boolean {
  return TERMINAL_STATES.has(state)
}

export function transitionLaneSideEffectState(
  state: LaneSideEffectState,
  event: LaneSideEffectEvent,
): LaneSideEffectState {
  if (TERMINAL_STATES.has(state)) {
    if (event === "mark-unknown" && state !== "unknown") return "unknown"
    throw new Error(`Invalid lane side-effect transition: ${state} -> ${event}`)
  }

  switch (state) {
    case "pending": {
      if (event === "accepted") return "accepted"
      if (event === "mark-unknown") return "unknown"
      if (event === "mark-partially-applied") return "partially-applied"
      break
    }
    case "accepted": {
      if (event === "start") return "running"
      if (event === "complete") return "completed"
      if (event === "cancel") return "cancelled"
      if (event === "mark-unknown") return "unknown"
      if (event === "mark-partially-applied") return "partially-applied"
      break
    }
    case "running": {
      if (event === "complete") return "completed"
      if (event === "cancel") return "cancelled"
      if (event === "fail") return "failed"
      if (event === "mark-unknown") return "unknown"
      if (event === "mark-partially-applied") return "partially-applied"
      break
    }
  }

  throw new Error(`Invalid lane side-effect transition: ${state} -> ${event}`)
}
