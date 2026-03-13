import { describe, expect, test } from "bun:test"
import { SessionPrompt } from "../session/prompt"

function createTokens(total: number) {
  return {
    total,
    input: total,
    output: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  }
}

describe("SessionPrompt.getLoopBoundary", () => {
  test("uses max step limit when turn control is not active", () => {
    const result = SessionPrompt.getLoopBoundary({
      turnControlReady: false,
      turnController: {
        shouldContinue() {
          throw new Error("should not be called")
        },
      },
      step: 3,
      maxSteps: 3,
    })

    expect(result.turnDecision).toBeUndefined()
    expect(result.shouldWrapUp).toBe(false)
    expect(result.isLastStep).toBe(true)
  })

  test("does not call turn control without finished token usage", () => {
    const result = SessionPrompt.getLoopBoundary({
      turnControlReady: true,
      turnController: {
        shouldContinue() {
          throw new Error("should not be called")
        },
      },
      step: 1,
      maxSteps: 5,
    })

    expect(result.turnDecision).toBeUndefined()
    expect(result.shouldWrapUp).toBe(false)
    expect(result.isLastStep).toBe(false)
  })

  test("forces wrap-up when turn controller says to stop", () => {
    const result = SessionPrompt.getLoopBoundary({
      turnControlReady: true,
      lastFinished: {
        tokens: createTokens(42000),
      },
      turnController: {
        shouldContinue(current) {
          expect(current).toBe(42000)
          return {
            shouldContinue: false,
            reason: "budget exceeded",
          }
        },
      },
      step: 1,
      maxSteps: 8,
    })

    expect(result.turnDecision).toEqual({
      shouldContinue: false,
      reason: "budget exceeded",
    })
    expect(result.shouldWrapUp).toBe(true)
    expect(result.isLastStep).toBe(true)
  })

  test("does not force wrap-up when turn controller says to continue", () => {
    const result = SessionPrompt.getLoopBoundary({
      turnControlReady: true,
      lastFinished: { tokens: createTokens(30000) },
      turnController: {
        shouldContinue() {
          return { shouldContinue: true, reason: "within budget" }
        },
      },
      step: 2,
      maxSteps: 10,
    })
    expect(result.turnDecision).toEqual({ shouldContinue: true, reason: "within budget" })
    expect(result.shouldWrapUp).toBe(false)
  })

  test("respects maxSteps even when turn controller allows continuation", () => {
    const result = SessionPrompt.getLoopBoundary({
      turnControlReady: true,
      lastFinished: { tokens: createTokens(10000) },
      turnController: {
        shouldContinue() {
          return { shouldContinue: true, reason: "ok" }
        },
      },
      step: 5,
      maxSteps: 5,
    })
    expect(result.isLastStep).toBe(true)
  })
})
