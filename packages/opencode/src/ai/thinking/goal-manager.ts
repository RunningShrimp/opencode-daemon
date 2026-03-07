import { z } from "zod"

export enum GoalStatus {
  PENDING = "pending",
  ACTIVE = "active",
  IN_PROGRESS = "in_progress",
  COMPLETED = "completed",
  BLOCKED = "blocked",
  CANCELLED = "cancelled",
  FAILED = "failed",
}

export enum GoalPriority {
  CRITICAL = 4,
  HIGH = 3,
  MEDIUM = 2,
  LOW = 1,
}

export const Goal = z.object({
  id: z.string(),
  title: z.string(),
  description: z.string(),
  status: z.nativeEnum(GoalStatus),
  priority: z.nativeEnum(GoalPriority),
  parentGoalId: z.string().optional(),
  subGoals: z.array(z.string()),
  createdAt: z.number(),
  updatedAt: z.number(),
  deadline: z.number().optional(),
  estimatedSteps: z.number().optional(),
  completedSteps: z.number().default(0),
  progress: z.number().min(0).max(1).default(0),
  blockers: z.array(z.string()),
  dependencies: z.array(z.string()),
  successCriteria: z.array(z.string()),
  metrics: z.record(z.string(), z.number()),
  context: z.record(z.string(), z.unknown()).optional(),
})

export type Goal = z.infer<typeof Goal>

export interface GoalDecomposition {
  mainGoals: Goal[]
  taskDependencies: Map<string, string[]>
  criticalPath: string[]
  estimatedTotalSteps: number
  parallelizable: string[][]
}

export interface GoalAdaptation {
  type: "refine" | "split" | "merge" | "reprioritize" | "abandon"
  reason: string
  affectedGoals: string[]
  newGoals: Goal[]
  impact: string
}

export class GoalManager {
  private goals: Map<string, Goal> = new Map()
  private goalHierarchy: Map<string, string[]> = new Map()
  private completedGoals: Goal[] = []
  private failedGoals: Goal[] = []

  createGoal(params: {
    title: string
    description: string
    priority?: GoalPriority
    deadline?: number
    estimatedSteps?: number
    parentGoalId?: string
    successCriteria?: string[]
  }): Goal {
    const now = Date.now()
    const goal: Goal = {
      id: `goal-${now}-${Math.random().toString(36).substr(2, 9)}`,
      title: params.title,
      description: params.description,
      status: GoalStatus.PENDING,
      priority: params.priority ?? GoalPriority.MEDIUM,
      parentGoalId: params.parentGoalId,
      subGoals: [],
      createdAt: now,
      updatedAt: now,
      deadline: params.deadline,
      estimatedSteps: params.estimatedSteps,
      completedSteps: 0,
      progress: 0,
      blockers: [],
      dependencies: [],
      successCriteria: params.successCriteria ?? [],
      metrics: {},
    }

    this.goals.set(goal.id, goal)

    if (params.parentGoalId) {
      const parent = this.goals.get(params.parentGoalId)
      if (parent) {
        parent.subGoals.push(goal.id)
        this.updateHierarchy(params.parentGoalId, goal.id)
      }
    }

    return goal
  }

  private updateHierarchy(parentId: string, childId: string): void {
    const existing = this.goalHierarchy.get(parentId) ?? []
    existing.push(childId)
    this.goalHierarchy.set(parentId, existing)
  }

  decomposeGoal(goalId: string, taskDescriptions: string[]): GoalDecomposition {
    const mainGoal = this.goals.get(goalId)
    if (!mainGoal) {
      throw new Error(`Goal ${goalId} not found`)
    }

    const subGoals = taskDescriptions.map((desc, index) =>
      this.createGoal({
        title: `Sub-goal ${index + 1}: ${desc.split(" ")[0]}`,
        description: desc,
        priority: (mainGoal.priority - 1) as GoalPriority,
        parentGoalId: goalId,
        estimatedSteps: Math.ceil((mainGoal.estimatedSteps ?? 5) / taskDescriptions.length),
      }),
    )

    mainGoal.subGoals = subGoals.map((g) => g.id)
    mainGoal.status = GoalStatus.ACTIVE

    const dependencies = this.analyzeDependencies(subGoals)
    const criticalPath = this.identifyCriticalPath(subGoals, dependencies)
    const parallelizable = this.findParallelizableTasks(subGoals, dependencies)

    return {
      mainGoals: subGoals,
      taskDependencies: dependencies,
      criticalPath,
      estimatedTotalSteps: subGoals.reduce((sum, g) => sum + (g.estimatedSteps ?? 5), 0),
      parallelizable,
    }
  }

  private analyzeDependencies(goals: Goal[]): Map<string, string[]> {
    const dependencies = new Map<string, string[]>()

    goals.forEach((goal) => {
      const deps: string[] = []

      goals.forEach((other) => {
        if (goal.id !== other.id) {
          if (this.hasDependency(goal.description, other.description)) {
            deps.push(other.id)
          }
        }
      })

      dependencies.set(goal.id, deps)
    })

    return dependencies
  }

  private hasDependency(taskA: string, taskB: string): boolean {
    const keywords = ["before", "after", "depend", "based on", "requires", "need"]
    const combined = `${taskA} ${taskB}`.toLowerCase()
    return keywords.some((k) => combined.includes(k))
  }

  private identifyCriticalPath(goals: Goal[], dependencies: Map<string, string[]>): string[] {
    const inDegree = new Map<string, number>()
    const adjList = new Map<string, string[]>()

    goals.forEach((g) => {
      inDegree.set(g.id, 0)
      adjList.set(g.id, [])
    })

    dependencies.forEach((deps, goalId) => {
      deps.forEach((depId) => {
        const neighbors = adjList.get(depId) ?? []
        neighbors.push(goalId)
        adjList.set(depId, neighbors)
        inDegree.set(goalId, (inDegree.get(goalId) ?? 0) + 1)
      })
    })

    const criticalPath: string[] = []
    const queue: string[] = []

    inDegree.forEach((degree, id) => {
      if (degree === 0) queue.push(id)
    })

    while (queue.length > 0) {
      const current = queue.shift()!
      criticalPath.push(current)

      const neighbors = adjList.get(current) ?? []
      neighbors.forEach((neighbor) => {
        const newDegree = (inDegree.get(neighbor) ?? 1) - 1
        inDegree.set(neighbor, newDegree)
        if (newDegree === 0) queue.push(neighbor)
      })
    }

    return criticalPath
  }

  private findParallelizableTasks(goals: Goal[], dependencies: Map<string, string[]>): string[][] {
    const levels: string[][] = []
    const assigned = new Set<string>()
    const inDegree = new Map<string, number>()

    goals.forEach((g) => {
      inDegree.set(g.id, (dependencies.get(g.id) ?? []).length)
    })

    while (assigned.size < goals.length) {
      const currentLevel: string[] = []

      inDegree.forEach((degree, id) => {
        if (degree === 0 && !assigned.has(id)) {
          currentLevel.push(id)
        }
      })

      if (currentLevel.length === 0) break

      levels.push(currentLevel)
      currentLevel.forEach((id) => {
        assigned.add(id)
        const neighbors = goals.find((g) => g.id === id)?.subGoals ?? []
        neighbors.forEach((neighborId) => {
          inDegree.set(neighborId, (inDegree.get(neighborId) ?? 1) - 1)
        })
      })
    }

    return levels
  }

  activateGoal(goalId: string): void {
    const goal = this.goals.get(goalId)
    if (goal && goal.status === GoalStatus.PENDING) {
      goal.status = GoalStatus.ACTIVE
      goal.updatedAt = Date.now()
    }
  }

  startGoal(goalId: string): void {
    const goal = this.goals.get(goalId)
    if (goal && goal.status === GoalStatus.ACTIVE) {
      goal.status = GoalStatus.IN_PROGRESS
      goal.updatedAt = Date.now()
    }
  }

  completeGoal(goalId: string): void {
    const goal = this.goals.get(goalId)
    if (goal) {
      goal.status = GoalStatus.COMPLETED
      goal.progress = 1
      goal.updatedAt = Date.now()
      this.completedGoals.push(goal)

      if (goal.parentGoalId) {
        this.checkParentCompletion(goal.parentGoalId)
      }
    }
  }

  private checkParentCompletion(parentId: string): void {
    const parent = this.goals.get(parentId)
    if (!parent) return

    const allSubGoalsCompleted = parent.subGoals.every((subId) => {
      const sub = this.goals.get(subId)
      return sub?.status === GoalStatus.COMPLETED
    })

    if (allSubGoalsCompleted) {
      parent.status = GoalStatus.COMPLETED
      parent.progress = 1
      this.completedGoals.push(parent)
    } else {
      const completed = parent.subGoals.filter((subId) => {
        const sub = this.goals.get(subId)
        return sub?.status === GoalStatus.COMPLETED
      }).length
      parent.progress = completed / parent.subGoals.length
    }

    parent.updatedAt = Date.now()
  }

  failGoal(goalId: string, reason: string): void {
    const goal = this.goals.get(goalId)
    if (goal) {
      goal.status = GoalStatus.FAILED
      goal.blockers.push(reason)
      goal.updatedAt = Date.now()
      this.failedGoals.push(goal)

      if (goal.parentGoalId) {
        this.propagateFailure(goal.parentGoalId, reason)
      }
    }
  }

  private propagateFailure(parentId: string, reason: string): void {
    const parent = this.goals.get(parentId)
    if (!parent) return

    parent.blockers.push(`Sub-goal failed: ${reason}`)

    const hasBlockingFailure = parent.subGoals.some((subId) => {
      const sub = this.goals.get(subId)
      return sub?.status === GoalStatus.FAILED
    })

    if (hasBlockingFailure) {
      parent.status = GoalStatus.BLOCKED
      parent.updatedAt = Date.now()
    }
  }

  addBlocker(goalId: string, blocker: string): void {
    const goal = this.goals.get(goalId)
    if (goal) {
      goal.blockers.push(blocker)
      if (goal.status === GoalStatus.IN_PROGRESS || goal.status === GoalStatus.ACTIVE) {
        goal.status = GoalStatus.BLOCKED
      }
      goal.updatedAt = Date.now()
    }
  }

  removeBlocker(goalId: string, blocker: string): void {
    const goal = this.goals.get(goalId)
    if (goal) {
      goal.blockers = goal.blockers.filter((b) => b !== blocker)
      if (goal.blockers.length === 0 && goal.status === GoalStatus.BLOCKED) {
        goal.status = GoalStatus.IN_PROGRESS
      }
      goal.updatedAt = Date.now()
    }
  }

  updateProgress(goalId: string, progress: number): void {
    const goal = this.goals.get(goalId)
    if (goal) {
      goal.progress = Math.max(0, Math.min(1, progress))
      goal.updatedAt = Date.now()
    }
  }

  incrementStep(goalId: string): void {
    const goal = this.goals.get(goalId)
    if (goal && goal.estimatedSteps) {
      goal.completedSteps = Math.min(goal.estimatedSteps, goal.completedSteps + 1)
      goal.progress = goal.completedSteps / goal.estimatedSteps
      goal.updatedAt = Date.now()
    }
  }

  adaptGoals(reason: string): GoalAdaptation[] {
    const adaptations: GoalAdaptation[] = []

    this.goals.forEach((goal) => {
      if (goal.status === GoalStatus.FAILED) {
        adaptations.push({
          type: "abandon",
          reason,
          affectedGoals: [goal.id],
          newGoals: [],
          impact: "Abandoning failed goal",
        })
      }

      if (goal.status === GoalStatus.BLOCKED && goal.blockers.length > 3) {
        const parts = this.splitGoal(goal)
        adaptations.push({
          type: "split",
          reason: "Goal blocked, splitting into smaller sub-goals",
          affectedGoals: [goal.id],
          newGoals: parts,
          impact: "Splitting goal to overcome blockers",
        })
      }

      if (goal.status === GoalStatus.IN_PROGRESS && goal.progress < 0.1 && goal.completedSteps > 5) {
        const refined = this.refineGoal(goal)
        adaptations.push({
          type: "refine",
          reason: "Insufficient progress, redefining goal",
          affectedGoals: [goal.id],
          newGoals: [refined],
          impact: "Adjusting goal for better achievability",
        })
      }
    })

    return adaptations
  }

  private splitGoal(goal: Goal): Goal[] {
    const parts = goal.description.split(/[,，;；]/).filter((p) => p.trim())
    return parts.map((desc) =>
      this.createGoal({
        title: `${goal.title} - ${desc.trim()}`,
        description: desc.trim(),
        priority: goal.priority,
        estimatedSteps: Math.ceil((goal.estimatedSteps ?? 5) / parts.length),
      }),
    )
  }

  private refineGoal(goal: Goal): Goal {
    goal.description += " (adjusted)"
    goal.updatedAt = Date.now()
    return goal
  }

  reprioritizeGoals(): void {
    const activeGoals = Array.from(this.goals.values()).filter(
      (g) => g.status === GoalStatus.ACTIVE || g.status === GoalStatus.IN_PROGRESS,
    )

    activeGoals.sort((a, b) => {
      if (a.priority !== b.priority) return b.priority - a.priority
      return a.createdAt - b.createdAt
    })
  }

  getActiveGoals(): Goal[] {
    return Array.from(this.goals.values()).filter(
      (g) => g.status === GoalStatus.ACTIVE || g.status === GoalStatus.IN_PROGRESS,
    )
  }

  getGoal(goalId: string): Goal | undefined {
    return this.goals.get(goalId)
  }

  getAllGoals(): Goal[] {
    return Array.from(this.goals.values())
  }

  getGoalHierarchy(goalId: string): Goal[] {
    const hierarchy: Goal[] = []
    const goal = this.goals.get(goalId)
    if (!goal) return hierarchy

    const collect = (id: string) => {
      const g = this.goals.get(id)
      if (g) {
        hierarchy.push(g)
        g.subGoals.forEach(collect)
      }
    }

    collect(goalId)
    return hierarchy
  }

  getCompletionRate(): number {
    const all = Array.from(this.goals.values())
    if (all.length === 0) return 0

    const completed = all.filter((g) => g.status === GoalStatus.COMPLETED).length
    return completed / all.length
  }

  getNextExecutableGoal(): Goal | undefined {
    const active = this.getActiveGoals()

    const inProgress = active.find((g) => g.status === GoalStatus.IN_PROGRESS)
    if (inProgress) return inProgress

    return active
      .filter((g) => {
        const deps = g.dependencies ?? []
        return deps.every((depId) => {
          const dep = this.goals.get(depId)
          return dep?.status === GoalStatus.COMPLETED
        })
      })
      .sort((a, b) => b.priority - a.priority)[0]
  }

  getGoalStatusReport(): string {
    const all = Array.from(this.goals.values())
    const byStatus = Object.values(GoalStatus).map((status) => ({
      status,
      goals: all.filter((g) => g.status === status),
    }))

    return `
## Goal Status Report

### Overall Completion Rate: ${(this.getCompletionRate() * 100).toFixed(1)}%

### By Status
${byStatus.map((s) => `- ${s.status}: ${s.goals.length} goals`).join("\n")}

### Active Goals (by priority)
${this.getActiveGoals()
  .sort((a, b) => b.priority - a.priority)
  .slice(0, 5)
  .map((g) => `[${GoalPriority[g.priority]}] ${g.title} - Progress ${(g.progress * 100).toFixed(0)}%`)
  .join("\n")}

### Blocked Goals
${
  all
    .filter((g) => g.status === GoalStatus.BLOCKED)
    .map((g) => `- ${g.title}: ${g.blockers.join(", ")}`)
    .join("\n") || "None"
}

### Failed Goals
${this.failedGoals.map((g) => `- ${g.title}: ${g.blockers[g.blockers.length - 1]}`).join("\n") || "None"}
`
  }
}
