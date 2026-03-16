import { describe, expect, test } from "bun:test"
import { IntentDetection } from "../ai/thinking/intent"
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

describe("SessionPrompt.getVerificationRevisionKey", () => {
  test("pins verification retries to the original turn user id", () => {
    expect(
      SessionPrompt.getVerificationRevisionKey({
        turnUserID: "user_original",
        lastUserID: "user_synthetic_retry",
      }),
    ).toBe("user_original")
  })

  test("falls back to the current user id when the turn id is unavailable", () => {
    expect(
      SessionPrompt.getVerificationRevisionKey({
        lastUserID: "user_current",
      }),
    ).toBe("user_current")
  })
})

describe("SessionPrompt.shouldRunAnswerVerification", () => {
  test("skips answer verification for direct question turns", () => {
    expect(
      SessionPrompt.shouldRunAnswerVerification({
        intent: { type: "exploration", query: "What does this repo do?", mode: "question" },
      }),
    ).toBe(false)
  })

  test("keeps verification enabled for non-question work", () => {
    expect(
      SessionPrompt.shouldRunAnswerVerification({
        intent: { type: "implementation", description: "patch auth", complexity: "simple" },
      }),
    ).toBe(true)
  })

  test("skips verification for arithmetic prompts after intent detection", () => {
    expect(
      SessionPrompt.shouldRunAnswerVerification({
        intent: IntentDetection.detect("Calculate 123 + 456. Reply with the number only."),
      }),
    ).toBe(false)
  })
})

describe("SessionPrompt.resolveVerificationIntent", () => {
  test("falls back to detecting intent from the current user input", () => {
    const resolved = SessionPrompt.resolveVerificationIntent({
      userInput: "Calculate 123 + 456. Reply with the number only.",
    })
    expect(resolved?.type).toBe("exploration")
    if (resolved?.type === "exploration") {
      expect(resolved.mode).toBe("question")
    }
  })

  test("prefers the cached intent when it is available", () => {
    const resolved = SessionPrompt.resolveVerificationIntent({
      intent: { type: "implementation", description: "patch auth", complexity: "simple" },
      userInput: "Calculate 123 + 456. Reply with the number only.",
    })
    expect(resolved).toEqual({ type: "implementation", description: "patch auth", complexity: "simple" })
  })
})

describe("SessionPrompt.resolveTurnUserContext", () => {
  test("skips synthetic follow-up user messages when recovering the active turn", () => {
    const resolved = SessionPrompt.resolveTurnUserContext({
      history: [
        {
          info: { id: "user_real", role: "user" },
          parts: [{ type: "text", text: "Calculate 123 + 456. Reply with the number only." }],
        },
        {
          info: { id: "assistant_1", role: "assistant" },
          parts: [{ type: "text", text: "579" }],
        },
        {
          info: { id: "user_synthetic", role: "user" },
          parts: [{ type: "text", text: "Please revise after verification.", synthetic: true }],
        },
      ] as any,
    })

    expect(resolved?.userID).toBe("user_real")
    expect(resolved?.userInput).toBe("Calculate 123 + 456. Reply with the number only.")
  })

  test("filters synthetic reminder parts out of the active user text", () => {
    const resolved = SessionPrompt.resolveTurnUserContext({
      history: [
        {
          info: { id: "user_real", role: "user" },
          parts: [
            { type: "text", text: "123 + 456" },
            { type: "text", text: "Please address this message and continue with your tasks.", synthetic: true },
          ],
        },
      ] as any,
    })

    expect(resolved?.userID).toBe("user_real")
    expect(resolved?.userInput).toBe("123 + 456")
  })
})
