import { describe, expect, test } from "bun:test"
import { validatePlan } from "../ai/thinking/planning"
import { buildStructuredTaskPlan } from "../ai/thinking/task-planner"

describe("buildStructuredTaskPlan", () => {
  test("builds a task graph with dependencies, fallback, and verification steps", () => {
    const plan = buildStructuredTaskPlan({
      sessionID: "planner-session",
      prompt: "Inspect src/auth.ts, patch the failing token refresh path, then verify with tests. Do not change the public API.",
      intent: {
        type: "implementation",
        description: "Patch token refresh path",
        complexity: "moderate",
      },
    })

    expect(plan.constraints.some((item) => item.kind === "prohibition")).toBe(true)
    expect(plan.taskGraph.length).toBeGreaterThanOrEqual(3)
    expect(plan.taskGraph.some((task) => task.phase === "verify")).toBe(true)
    expect(plan.fallbackPlan.length).toBeGreaterThan(0)
    expect(plan.taskGraph.some((task) => task.dependencies.length > 0)).toBe(true)
    expect(validatePlan(plan.plan).valid).toBe(true)
  })

  test("emits clarification questions for underspecified tasks", () => {
    const plan = buildStructuredTaskPlan({
      sessionID: "planner-clarify",
      prompt: "Fix it",
      intent: {
        type: "implementation",
        description: "Fix it",
        complexity: "simple",
      },
    })

    expect(plan.clarificationQuestions.length).toBeGreaterThan(0)
  })

  test("falls back to intent-derived goal when prompt text is empty", () => {
    const plan = buildStructuredTaskPlan({
      sessionID: "planner-empty-goal",
      prompt: "   ",
      intent: {
        type: "implementation",
        description: "Handle image-only turn planning",
        complexity: "moderate",
      },
    })

    expect(plan.goal).toBe("Handle image-only turn planning")
    expect(plan.plan.goal).toBe("Handle image-only turn planning")
    expect(validatePlan(plan.plan).valid).toBe(true)
  })
})