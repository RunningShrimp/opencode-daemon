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

export interface PlanExecutionAnalysis {
  readyTasks: PlanningTask[]
  stalled: boolean
  reasons: string[]
}

function allTasks(plan: Plan) {
  return plan.steps.flatMap((step) => step.tasks)
}

function taskMap(plan: Plan) {
  return new Map(allTasks(plan).map((task) => [task.id, task]))
}

function findDependencyCycles(tasks: Map<string, PlanningTask>) {
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const stack: string[] = []
  const cycles = new Set<string>()

  const visit = (taskID: string) => {
    if (visited.has(taskID)) return
    if (visiting.has(taskID)) {
      const cycleStart = stack.indexOf(taskID)
      if (cycleStart >= 0) {
        const cycle = [...stack.slice(cycleStart), taskID]
        cycles.add(cycle.join(" -> "))
      }
      return
    }

    const task = tasks.get(taskID)
    if (!task) return

    visiting.add(taskID)
    stack.push(taskID)
    for (const depID of task.dependencies) {
      if (!tasks.has(depID)) continue
      visit(depID)
    }
    stack.pop()
    visiting.delete(taskID)
    visited.add(taskID)
  }

  for (const taskID of tasks.keys()) {
    visit(taskID)
  }

  return [...cycles]
}

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
  const tasks = taskMap(plan)

  if (!plan.goal.trim()) {
    errors.push("Plan goal cannot be empty")
  }

  if (plan.steps.length === 0) {
    errors.push("Plan must have at least one step")
  }

  const stepNumbers = new Set<number>()
  const taskIDs = new Set<string>()
  for (const step of plan.steps) {
    if (stepNumbers.has(step.stepNumber)) {
      errors.push(`Duplicate step number: ${step.stepNumber}`)
    }
    stepNumbers.add(step.stepNumber)

    for (const task of step.tasks) {
      if (taskIDs.has(task.id)) {
        errors.push(`Duplicate task id: ${task.id}`)
      }
      taskIDs.add(task.id)

      if (task.dependencies.includes(task.id)) {
        errors.push(`Task ${task.id} cannot depend on itself`)
      }

      for (const depId of task.dependencies) {
        const depExists = tasks.has(depId)
        if (!depExists) {
          errors.push(`Task ${task.id} has invalid dependency: ${depId}`)
        }
      }
    }
  }

  for (const cycle of findDependencyCycles(tasks)) {
    errors.push(`Dependency cycle detected: ${cycle}`)
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
  const tasks = allTasks(plan)
  if (tasks.length === 0) return 0

  const completedTasks = tasks.filter((t) => t.status === "completed").length
  return Math.round((completedTasks / tasks.length) * 100)
}

export function analyzePlanExecution(plan: Plan): PlanExecutionAnalysis {
  const tasks = allTasks(plan)
  const taskIndex = new Map(tasks.map((task) => [task.id, task]))
  const readyTasks = tasks.filter((task) => {
    if (task.status !== "pending") return false
    return task.dependencies.every((depId) => {
      const depTask = taskIndex.get(depId)
      return depTask?.status === "completed"
    })
  })

  const pendingTasks = tasks.filter((task) => task.status === "pending")
  const inProgressTasks = tasks.filter((task) => task.status === "in_progress")
  const stalled = readyTasks.length === 0 && pendingTasks.length > 0 && inProgressTasks.length === 0
  const reasons: string[] = []

  if (stalled) {
    const validation = validatePlan(plan)
    reasons.push(...validation.errors)

    for (const task of pendingTasks) {
      const failedDeps = task.dependencies.filter((depId) => {
        const depTask = taskIndex.get(depId)
        return depTask?.status === "failed" || depTask?.status === "cancelled"
      })
      if (failedDeps.length > 0) {
        reasons.push(`Task ${task.id} is blocked by failed dependencies: ${failedDeps.join(", ")}`)
      }
    }

    if (reasons.length === 0) {
      reasons.push("Pending tasks are blocked by unresolved dependencies with no ready task to execute")
    }
  }

  return {
    readyTasks,
    stalled,
    reasons: [...new Set(reasons)],
  }
}

export function getNextPendingTasks(plan: Plan): PlanningTask[] {
  return analyzePlanExecution(plan).readyTasks
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
