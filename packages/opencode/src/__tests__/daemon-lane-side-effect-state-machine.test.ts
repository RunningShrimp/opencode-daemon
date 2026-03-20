import { describe, expect, test } from "bun:test"
import {
  isTerminalLaneSideEffectState,
  transitionLaneSideEffectState,
} from "@/daemon/worker/lane-side-effect-state-machine"

describe("lane side-effect state machine", () => {
  test("supports happy path transition to completed", () => {
    let state = transitionLaneSideEffectState("pending", "accepted")
    state = transitionLaneSideEffectState(state, "start")
    state = transitionLaneSideEffectState(state, "complete")
    expect(state).toBe("completed")
    expect(isTerminalLaneSideEffectState(state)).toBe(true)
  })

  test("supports partially-applied and unknown terminal states", () => {
    expect(transitionLaneSideEffectState("pending", "mark-partially-applied")).toBe("partially-applied")
    expect(transitionLaneSideEffectState("accepted", "mark-unknown")).toBe("unknown")
  })

  test("throws on invalid transitions", () => {
    expect(() => transitionLaneSideEffectState("pending", "start")).toThrow("Invalid lane side-effect transition")
    expect(() => transitionLaneSideEffectState("completed", "complete")).toThrow("Invalid lane side-effect transition")
  })
})
