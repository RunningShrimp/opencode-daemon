import { z } from "zod"

export const PlanningTask = z.object({
  id: z.string(),
  description: z.string(),
  status: z.enum(["pending", "in_progress", "completed", "failed", "cancelled"]),
  priority: z.enum(["low", "medium", "high", "critical"]),
  dependencies: z.array(z.string()),
  evidence: z.array(z.string()),
  createdAt: z.number(),
  updatedAt: z.number(),
  completedAt: z.number().optional(),
})

export type PlanningTask = z.infer<typeof PlanningTask>

export const PlanningStep = z.object({
  id: z.string(),
  stepNumber: z.number(),
  description: z.string(),
  expectedOutcome: z.string(),
  tasks: z.array(PlanningTask),
  status: z.enum(["pending", "in_progress", "completed", "skipped"]),
  completedAt: z.number().optional(),
})

export type PlanningStep = z.infer<typeof PlanningStep>

export const Plan = z.object({
  id: z.string(),
  sessionId: z.string(),
  goal: z.string(),
  steps: z.array(PlanningStep),
  status: z.enum(["draft", "active", "completed", "cancelled"]),
  createdAt: z.number(),
  updatedAt: z.number(),
  completedAt: z.number().optional(),
})

export type Plan = z.infer<typeof Plan>

export function createPlanningTask(
  description: string,
  priority: PlanningTask["priority"] = "medium",
  dependencies: string[] = [],
): PlanningTask {
  const now = Date.now()
  return PlanningTask.parse({
    id: crypto.randomUUID(),
    description,
    status: "pending",
    priority,
    dependencies,
    evidence: [],
    createdAt: now,
    updatedAt: now,
  })
}

export function createPlanningStep(
  stepNumber: number,
  description: string,
  expectedOutcome: string,
  tasks: PlanningTask[] = [],
): PlanningStep {
  return PlanningStep.parse({
    id: crypto.randomUUID(),
    stepNumber,
    description,
    expectedOutcome,
    tasks,
    status: "pending",
  })
}

export function createPlan(sessionId: string, goal: string, steps: PlanningStep[] = []): Plan {
  const now = Date.now()
  return Plan.parse({
    id: crypto.randomUUID(),
    sessionId,
    goal,
    steps,
    status: "draft",
    createdAt: now,
    updatedAt: now,
  })
}

export function validatePlan(plan: Plan): { valid: boolean; errors: string[] } {
  const errors: string[] = []

  if (!plan.goal.trim()) {
    errors.push("Plan goal cannot be empty")
  }

  if (plan.steps.length === 0) {
    errors.push("Plan must have at least one step")
  }

  const stepNumbers = new Set<number>()
  for (const step of plan.steps) {
    if (stepNumbers.has(step.stepNumber)) {
      errors.push(`Duplicate step number: ${step.stepNumber}`)
    }
    stepNumbers.add(step.stepNumber)

    for (const task of step.tasks) {
      for (const depId of task.dependencies) {
        const depExists = plan.steps.some((s) => s.tasks.some((t) => t.id === depId))
        if (!depExists) {
          errors.push(`Task ${task.id} has invalid dependency: ${depId}`)
        }
      }
    }
  }

  return { valid: errors.length === 0, errors }
}

export function updateTaskStatus(plan: Plan, taskId: string, status: PlanningTask["status"]): Plan {
  const now = Date.now()
  const newSteps = plan.steps.map((step) => ({
    ...step,
    tasks: step.tasks.map((task) => {
      if (task.id !== taskId) return task
      return {
        ...task,
        status,
        updatedAt: now,
        completedAt: status === "completed" ? now : undefined,
      }
    }),
  }))

  return { ...plan, steps: newSteps, updatedAt: now }
}

export function calculateProgress(plan: Plan): number {
  const allTasks = plan.steps.flatMap((s) => s.tasks)
  if (allTasks.length === 0) return 0

  const completedTasks = allTasks.filter((t) => t.status === "completed").length
  return Math.round((completedTasks / allTasks.length) * 100)
}

export function getNextPendingTasks(plan: Plan): PlanningTask[] {
  const allTasks = plan.steps.flatMap((s) => s.tasks)
  return allTasks.filter((task) => {
    if (task.status !== "pending") return false
    return task.dependencies.every((depId) => {
      const depTask = allTasks.find((t) => t.id === depId)
      return depTask?.status === "completed"
    })
  })
}

export function activatePlan(plan: Plan): Plan {
  return { ...plan, status: "active", updatedAt: Date.now() }
}

export function completePlan(plan: Plan): Plan {
  const now = Date.now()
  return { ...plan, status: "completed", updatedAt: now, completedAt: now }
}

export function cancelPlan(plan: Plan): Plan {
  return { ...plan, status: "cancelled", updatedAt: Date.now() }
}
