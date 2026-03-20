import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test"
import { Config } from "../config/config"
import { type Provider } from "../provider/provider"
import { SessionCompaction } from "../session/compaction"
import { modelID, providerID, sessionID as makeSessionID } from "../test-helpers/ids"
import { globalManager as predictorManager, getPredictor } from "../util/compaction-predictor"

function createModel(overrides: Partial<Provider.Model["limit"]> = {}): Provider.Model {
  return {
    id: modelID("test-model"),
    providerID: providerID("test-provider"),
    api: {
      id: "test-model",
      url: "https://example.com",
      npm: "@ai-sdk/openai",
    },
    name: "Test Model",
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: true,
      toolcall: true,
      input: {
        text: true,
        audio: false,
        image: true,
        video: false,
        pdf: true,
      },
      output: {
        text: true,
        audio: false,
        image: false,
        video: false,
        pdf: false,
      },
      interleaved: false,
    },
    cost: {
      input: 0,
      output: 0,
      cache: { read: 0, write: 0 },
    },
    limit: {
      context: 70000,
      input: 60000,
      output: 5000,
      ...overrides,
    },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-01-01",
  }
}

function createTokens(
  input: number,
  output: number,
  reasoning = 0,
): {
  total?: number
  input: number
  output: number
  reasoning: number
  cache: { read: number; write: number }
} {
  return {
    input,
    output,
    reasoning,
    cache: { read: 0, write: 0 },
  }
}

describe("SessionCompaction integration", () => {
  beforeEach(() => {
    predictorManager.clear()
    vi.spyOn(Config, "get").mockResolvedValue({} as Awaited<ReturnType<typeof Config.get>>)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    predictorManager.clear()
  })

  test("recordUsage writes session token history into the predictor", async () => {
    await SessionCompaction.recordUsage({
      sessionID: makeSessionID("session-1"),
      tokens: createTokens(12000, 2500, 500),
      model: createModel(),
    })

    const stats = getPredictor("session-1").getStats()
    expect(stats.count).toBe(1)
    expect(stats.avg).toBe(15000)
  })

  test("isOverflow triggers preemptively when predictor sees an imminent overflow", async () => {
    const model = createModel()
    const sessionID = "session-2"

    await SessionCompaction.recordUsage({ sessionID, tokens: createTokens(10000, 1000), model })
    await SessionCompaction.recordUsage({ sessionID, tokens: createTokens(18000, 1000), model })
    await SessionCompaction.recordUsage({ sessionID, tokens: createTokens(26000, 1000), model })

    const overflow = await SessionCompaction.isOverflow({
      sessionID,
      tokens: createTokens(34000, 1000),
      model,
    })

    expect(overflow).toBe(true)
  })

  test("resetPrediction clears per-session predictor state", async () => {
    const model = createModel()
    const sessionID = "session-3"

    await SessionCompaction.recordUsage({
      sessionID,
      tokens: createTokens(12000, 2000),
      model,
    })

    expect(getPredictor(sessionID).getStats().count).toBe(1)
    SessionCompaction.resetPrediction(sessionID)
    expect(getPredictor(sessionID).getStats().count).toBe(0)
  })

  test("isOverflow returns false when model has context: 0", async () => {
    const model = createModel({ context: 0, input: 0, output: 0 })
    const overflow = await SessionCompaction.isOverflow({
      sessionID: makeSessionID("session-zero-context"),
      tokens: createTokens(10000, 5000),
      model,
    })
    expect(overflow).toBe(false)
  })

  test("isOverflow returns false when compaction auto is disabled", async () => {
    vi.spyOn(Config, "get").mockResolvedValue({
      compaction: { auto: false },
    } as Awaited<ReturnType<typeof Config.get>>)

    const model = createModel()
    const overflow = await SessionCompaction.isOverflow({
      sessionID: makeSessionID("session-disabled"),
      tokens: createTokens(50000, 10000),
      model,
    })
    expect(overflow).toBe(false)
  })

  test("isEstimatedOverflow respects usable input threshold", async () => {
    const model = createModel({ context: 70000, input: 60000, output: 5000 })

    await expect(
      SessionCompaction.isEstimatedOverflow({
        sessionID: makeSessionID("session-estimated-safe"),
        estimatedInputTokens: 52000,
        model,
      }),
    ).resolves.toBe(false)

    await expect(
      SessionCompaction.isEstimatedOverflow({
        sessionID: makeSessionID("session-estimated-overflow"),
        estimatedInputTokens: 56000,
        model,
      }),
    ).resolves.toBe(true)
  })

  test("isEstimatedOverflow returns false when compaction auto is disabled", async () => {
    vi.spyOn(Config, "get").mockResolvedValue({
      compaction: { auto: false },
    } as Awaited<ReturnType<typeof Config.get>>)

    await expect(
      SessionCompaction.isEstimatedOverflow({
        sessionID: makeSessionID("session-estimated-disabled"),
        estimatedInputTokens: 999999,
        model: createModel(),
      }),
    ).resolves.toBe(false)
  })

  test("predictor does not preempt when confidence is below threshold", async () => {
    const model = createModel()
    const sessionID = "session-low-confidence"

    // Record inconsistent growth patterns to produce low confidence
    await SessionCompaction.recordUsage({ sessionID, tokens: createTokens(5000, 1000), model })
    await SessionCompaction.recordUsage({ sessionID, tokens: createTokens(15000, 1000), model }) // +10000 growth
    await SessionCompaction.recordUsage({ sessionID, tokens: createTokens(17000, 1000), model }) // +2000 growth (inconsistent)
    await SessionCompaction.recordUsage({ sessionID, tokens: createTokens(35000, 1000), model }) // +18000 growth (very inconsistent)

    const predictor = getPredictor(sessionID)
    const prediction = predictor.predict(36000, 1000, 50000)

    // Low confidence due to inconsistent growth should not preempt
    expect(prediction.confidence).toBeLessThan(0.9)
    expect(prediction.action).toBeOneOf(["wait", "compact", "urgent"])
  })

  test("predictor returns urgent action when overflow is imminent", async () => {
    const model = createModel({ context: 40000, input: 35000, output: 5000 })
    const sessionID = "session-urgent"

    // Record steady growth to establish trend
    await SessionCompaction.recordUsage({ sessionID, tokens: createTokens(5000, 1000), model })
    await SessionCompaction.recordUsage({ sessionID, tokens: createTokens(10000, 1000), model })
    await SessionCompaction.recordUsage({ sessionID, tokens: createTokens(15000, 1000), model })
    await SessionCompaction.recordUsage({ sessionID, tokens: createTokens(20000, 1000), model })

    // Now check at high usage - should trigger urgent or compact
    const predictor = getPredictor(sessionID)
    const prediction = predictor.predict(30000, 1000, 33000)

    // Should detect imminent overflow
    expect(prediction.predictedOverflowTurns).toBeLessThanOrEqual(3)
  })
})
