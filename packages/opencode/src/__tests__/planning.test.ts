import { describe, expect, test } from "bun:test"
import { analyzePlanExecution, createPlan, createPlanningStep, createPlanningTask, validatePlan } from "../ai/thinking/planning"

describe("planning", () => {
  test("validatePlan rejects dependency cycles", () => {
    const taskA = { ...createPlanningTask("task A"), id: "task-a", dependencies: ["task-b"] }
    const taskB = { ...createPlanningTask("task B"), id: "task-b", dependencies: ["task-a"] }
    const plan = createPlan("session-cycle", "Resolve work", [
      createPlanningStep(1, "Execute", "Finish the work", [taskA, taskB]),
    ])

    const validation = validatePlan(plan)
    expect(validation.valid).toBe(false)
    expect(validation.errors.some((error) => error.includes("Dependency cycle detected"))).toBe(true)
  })

  test("analyzePlanExecution reports stalled plans when pending tasks are cyclic", () => {
    const taskA = { ...createPlanningTask("task A"), id: "task-a", dependencies: ["task-b"] }
    const taskB = { ...createPlanningTask("task B"), id: "task-b", dependencies: ["task-a"] }
    const plan = createPlan("session-stalled", "Resolve work", [
      createPlanningStep(1, "Execute", "Finish the work", [taskA, taskB]),
    ])

    const analysis = analyzePlanExecution(plan)
    expect(analysis.readyTasks).toHaveLength(0)
    expect(analysis.stalled).toBe(true)
    expect(analysis.reasons.some((reason) => reason.includes("Dependency cycle detected"))).toBe(true)
  })

  test("analyzePlanExecution reports failed dependency blockers", () => {
    const taskA = { ...createPlanningTask("task A"), id: "task-a", status: "failed" as const }
    const taskB = { ...createPlanningTask("task B"), id: "task-b", dependencies: ["task-a"] }
    const plan = createPlan("session-failed", "Resolve work", [
      createPlanningStep(1, "Execute", "Finish the work", [taskA, taskB]),
    ])

    const analysis = analyzePlanExecution(plan)
    expect(analysis.readyTasks).toHaveLength(0)
    expect(analysis.stalled).toBe(true)
    expect(analysis.reasons).toContain("Task task-b is blocked by failed dependencies: task-a")
  })
})