import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { CompactionPredictor, getPredictor, globalManager, DEFAULT_CONFIG } from "../util/compaction-predictor"

describe("CompactionPredictor", () => {
  let predictor: CompactionPredictor

  beforeEach(() => {
    predictor = new CompactionPredictor()
    predictor.initialize()
  })

  afterEach(() => {
    predictor.reset()
  })

  describe("initialization", () => {
    test("initializes with default config", () => {
      const p = new CompactionPredictor()
      p.initialize()
      const stats = p.getStats()
      expect(stats.count).toBe(0)
      expect(stats.avg).toBe(0)
      expect(stats.trend).toBe(0)
    })

    test("initializes with custom config", () => {
      const p = new CompactionPredictor({
        enabled: true,
        predictionAhead: 20000,
        triggerThreshold: 0.8,
        historySize: 15,
        minConfidence: 0.7,
      })
      p.initialize()
      expect(p).toBeDefined()
    })
  })

  describe("record", () => {
    test("records token usage", () => {
      predictor.record(1000, 500, 100000)
      const stats = predictor.getStats()
      expect(stats.count).toBe(1)
    })

    test("maintains history size limit", () => {
      for (let i = 0; i < 15; i++) {
        predictor.record(1000 + i * 100, 500, 100000)
      }
      const stats = predictor.getStats()
      expect(stats.count).toBe(DEFAULT_CONFIG.historySize)
    })

    test("does not record when disabled", () => {
      const p = new CompactionPredictor({ enabled: false })
      p.initialize()
      p.record(1000, 500, 100000)
      const stats = p.getStats()
      expect(stats.count).toBe(0)
    })
  })

  describe("predict", () => {
    test("returns wait when not enough history", () => {
      predictor.record(1000, 500, 100000)
      const result = predictor.predict(1000, 500, 100000)
      expect(result.shouldPreempt).toBe(false)
      expect(result.action).toBe("wait")
      expect(result.reason).toBe("not ready")
    })

    test("returns urgent when at threshold", () => {
      for (let i = 0; i < 5; i++) {
        predictor.record(15000 + i * 1000, 5000, 100000)
      }
      const result = predictor.predict(75000, 5000, 100000)
      expect(result.shouldPreempt).toBe(true)
      expect(result.action).toBe("urgent")
      expect(result.confidence).toBe(0.95)
    })

    test("predicts overflow with growth trend", () => {
      for (let i = 0; i < 5; i++) {
        predictor.record(10000 + i * 5000, 2000, 100000)
      }
      const result = predictor.predict(30000, 2000, 100000)
      expect(result.predictedOverflowTurns).toBeGreaterThan(0)
    })

    test("returns wait when no growth trend", () => {
      for (let i = 0; i < 5; i++) {
        predictor.record(10000, 2000, 100000)
      }
      const result = predictor.predict(10000, 2000, 100000)
      expect(result.shouldPreempt).toBe(false)
      expect(result.action).toBe("wait")
    })
  })

  describe("getStats", () => {
    test("returns correct statistics", () => {
      predictor.record(1000, 500, 100000)
      predictor.record(2000, 600, 100000)
      predictor.record(3000, 700, 100000)

      const stats = predictor.getStats()
      expect(stats.count).toBe(3)
      expect(stats.avg).toBeGreaterThan(0)
    })
  })

  describe("reset", () => {
    test("clears all state", () => {
      predictor.record(1000, 500, 100000)
      predictor.record(2000, 600, 100000)
      predictor.reset()

      const stats = predictor.getStats()
      expect(stats.count).toBe(0)
    })
  })
})

describe("Global Manager", () => {
  beforeEach(() => {
    globalManager.clear()
  })

  test("getOrCreate returns same predictor for same session", () => {
    const p1 = getPredictor("session-1")
    const p2 = getPredictor("session-1")
    expect(p1).toBe(p2)
  })

  test("getOrCreate returns different predictors for different sessions", () => {
    const p1 = getPredictor("session-1")
    const p2 = getPredictor("session-2")
    expect(p1).not.toBe(p2)
  })

  test("remove clears specific predictor", () => {
    getPredictor("session-1")
    getPredictor("session-2")
    globalManager.remove("session-1")

    const p = getPredictor("session-1")
    const stats = p.getStats()
    expect(stats.count).toBe(0)
  })

  test("clear removes all predictors", () => {
    getPredictor("session-1")
    getPredictor("session-2")
    globalManager.clear()

    const p1 = getPredictor("session-1")
    const p2 = getPredictor("session-2")
    expect(p1.getStats().count).toBe(0)
    expect(p2.getStats().count).toBe(0)
  })
})
