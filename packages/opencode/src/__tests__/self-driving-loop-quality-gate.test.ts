import { describe, expect, test } from "bun:test"
import { AgentState } from "../ai/thinking/self-monitor"
import { ReasoningStrategy } from "../ai/thinking/metacognition"

describe("SelfDrivingLoop quality gate and strategy switching", () => {
  test("detectRemainingWork() ignores default completion-only criteria", async () => {
    const { SelfDrivingLoop } = await import("../ai/thinking/self-driving-loop")
    const loop = new SelfDrivingLoop()

    await loop.initialize("Test task", {
      type: "implementation",
      description: "Test",
      complexity: "simple",
    })

    const remaining = loop.detectRemainingWork()

    expect(remaining.hasRemaining).toBe(false)
    expect(remaining.items).toEqual([])
    expect(remaining.suggestedActions).toEqual([])
  })

  test("detectRemainingWork() keeps actionable criteria while dropping generic completion summaries", async () => {
    const { SelfDrivingLoop } = await import("../ai/thinking/self-driving-loop")
    const loop = new SelfDrivingLoop()

    await loop.initialize("Test task", {
      type: "implementation",
      description: "Test",
      complexity: "simple",
    })

    ;(loop as any).loopState.currentGoal.successCriteria = [
      "Fix dependency injection compile errors",
      "All requirements met",
    ]

    const remaining = loop.detectRemainingWork()

    expect(remaining.hasRemaining).toBe(true)
    expect(remaining.items).toEqual(["Fix dependency injection compile errors"])
    expect(remaining.suggestedActions).toEqual(["Address: Fix dependency injection compile errors"])
  })

  test("getProgress() recognizes completion semantics beyond complete/done", async () => {
    const { SelfDrivingLoop } = await import("../ai/thinking/self-driving-loop")
    const loop = new SelfDrivingLoop()

    await loop.initialize("Test task", {
      type: "implementation",
      description: "Test",
      complexity: "simple",
    })

    ;(loop as any).monitor.state.confidence = 0.9
    ;(loop as any).loopState.currentGoal.successCriteria = ["All requirements met"]

    expect(loop.getProgress()).toBe(1)
  })

  test("adapt() switches to HYPOTHETICAL strategy when quality gate fails due to low progress", async () => {
    const { SelfDrivingLoop } = await import("../ai/thinking/self-driving-loop")
    const loop = new SelfDrivingLoop()
    // Simulate > 10 steps with no progress (getProgress() defaults to 0)
    ;(loop as any).stepCount = 15
    await loop.adapt()
    // Quality gate should fail (completenessScore ≈ 0), switching strategy
    expect((loop as any).loopState.context["activeStrategy"]).toBe(ReasoningStrategy.HYPOTHETICAL)
  })

  test("adapt() requests user input when a critical finding is detected", async () => {
    const { SelfDrivingLoop } = await import("../ai/thinking/self-driving-loop")
    const loop = new SelfDrivingLoop()
    ;(loop as any).stepCount = 15
    await loop.adapt()
    // The monitor should transition to WAITING_FOR_INPUT because of the "critical" finding
    // (Low progress after many steps is classified as severity "critical")
    const monitorState = (loop as any).monitor.getState()
    expect(monitorState.currentState).toBe(AgentState.WAITING_FOR_INPUT)
  })

  test("adapt() records gateDecision in loop context", async () => {
    const { SelfDrivingLoop } = await import("../ai/thinking/self-driving-loop")
    const loop = new SelfDrivingLoop()
    await loop.adapt()
    const gate = (loop as any).loopState.context["gateDecision"]
    expect(gate).toBeDefined()
    expect(typeof gate.pass).toBe("boolean")
  })

  test("adapt() does NOT switch strategy if already HYPOTHETICAL", async () => {
    const { SelfDrivingLoop } = await import("../ai/thinking/self-driving-loop")
    const loop = new SelfDrivingLoop()
    ;(loop as any).stepCount = 15
    ;(loop as any).loopState.context["activeStrategy"] = ReasoningStrategy.HYPOTHETICAL
    await loop.adapt()
    // Still HYPOTHETICAL — cannot double-switch
    expect((loop as any).loopState.context["activeStrategy"]).toBe(ReasoningStrategy.HYPOTHETICAL)
  })

  test("reflect() updates activeStrategy context when metacognition suggests a change", async () => {
    const { SelfDrivingLoop } = await import("../ai/thinking/self-driving-loop")
    const loop = new SelfDrivingLoop()
    // Inject a fake strategy adjustment via the metacognition stub
    const mc = (loop as any).metacognition
    const recordFailureCalls: string[] = []
    const recordSuccessCalls: string[] = []
    const originalReflect = mc.reflect.bind(mc)
    mc.reflect = async () => {
      const real = await originalReflect("test")
      return {
        ...real,
        strategyAdjustments: [
          { previousStrategy: ReasoningStrategy.DEDUCTIVE, newStrategy: ReasoningStrategy.INDUCTIVE, reason: "stalled" },
        ],
      }
    }
    mc.recordStrategyFailure = (s: string) => recordFailureCalls.push(s)
    mc.recordStrategySuccess = (s: string) => recordSuccessCalls.push(s)

    await loop.reflect()

    const active = (loop as any).loopState.context["activeStrategy"]
    expect(active).toBe(ReasoningStrategy.INDUCTIVE)
    expect(recordFailureCalls).toContain(ReasoningStrategy.DEDUCTIVE)
    expect(recordSuccessCalls).toContain(ReasoningStrategy.INDUCTIVE)
  })

  test("reflect() does NOT record failure/success when strategy is unchanged", async () => {
    const { SelfDrivingLoop } = await import("../ai/thinking/self-driving-loop")
    const loop = new SelfDrivingLoop()
    const failureCalls: string[] = []
    const successCalls: string[] = []
    const mc = (loop as any).metacognition
    mc.reflect = async () => ({
      insights: [],
      strategyAdjustments: [
        { previousStrategy: ReasoningStrategy.DEDUCTIVE, newStrategy: ReasoningStrategy.DEDUCTIVE, reason: "unchanged" },
      ],
      newHypotheses: [],
    })
    mc.recordStrategyFailure = (s: string) => failureCalls.push(s)
    mc.recordStrategySuccess = (s: string) => successCalls.push(s)

    await loop.reflect()

    expect(failureCalls).toHaveLength(0)
    expect(successCalls).toHaveLength(0)
  })
})
