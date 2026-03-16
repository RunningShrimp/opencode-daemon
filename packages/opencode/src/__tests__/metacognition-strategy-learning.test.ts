import { describe, expect, test } from "bun:test"
import { MetacognitionEngine, ReasoningStrategy } from "../ai/thinking/metacognition"
import { SelfMonitor } from "../ai/thinking/self-monitor"

describe("Metacognition strategy learning", () => {
  test("recordStrategySuccess updates mapped strategy patterns", () => {
    const engine = new MetacognitionEngine(new SelfMonitor())

    const before = engine.getCognitivePatterns().find((p) => p.id === "pattern-5")
    expect(before).toBeDefined()
    const beforeEffectiveness = before!.effectiveness

    engine.recordStrategySuccess(ReasoningStrategy.HYPOTHETICAL)

    const after = engine.getCognitivePatterns().find((p) => p.id === "pattern-5")
    expect(after).toBeDefined()
    expect(after!.effectiveness).toBeGreaterThan(beforeEffectiveness)
  })

  test("recordStrategyFailure updates mapped strategy patterns", () => {
    const engine = new MetacognitionEngine(new SelfMonitor())

    const before = engine.getCognitivePatterns().find((p) => p.id === "pattern-4")
    expect(before).toBeDefined()
    const beforeEffectiveness = before!.effectiveness

    engine.recordStrategyFailure(ReasoningStrategy.ANALOGICAL)

    const after = engine.getCognitivePatterns().find((p) => p.id === "pattern-4")
    expect(after).toBeDefined()
    expect(after!.effectiveness).toBeLessThan(beforeEffectiveness)
  })
})
