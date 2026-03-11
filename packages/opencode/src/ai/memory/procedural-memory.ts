import { Log } from "@/util/log"

const log = Log.create({ service: "procedural-memory" })

export type MemoryUnitType = "step" | "workflow" | "pattern" | "heuristic" | "context"

export interface MemoryUnit {
  id: string
  type: MemoryUnitType
  content: string
  metadata: Record<string, unknown>
  success: boolean
  usageCount: number
  successRate: number
  avgDuration: number
  timeCreated: number
  lastUsed: number
  tags: string[]
  parentId?: string
}

export interface TaskTrajectory {
  id: string
  taskType: string
  steps: TrajectoryStep[]
  success: boolean
  duration: number
  timeCreated: number
  tags: string[]
}

export interface TrajectoryStep {
  order: number
  action: string
  tool?: string
  input?: Record<string, unknown>
  output?: string
  success: boolean
  duration: number
  memoryUnitId?: string
}

export interface WorkflowPattern {
  id: string
  name: string
  description: string
  steps: WorkflowStep[]
  successRate: number
  usageCount: number
  applicableTasks: string[]
  timeCreated: number
  lastUsed: number
}

export interface WorkflowStep {
  order: number
  action: string
  tool?: string
  conditions?: string[]
  expectedOutcome?: string
}

export interface ProceduralMemoryConfig {
  maxUnits: number
  minSuccessRate: number
  patternThreshold: number
  autoExtract: boolean
  decayFactor: number
}

const DEFAULT_CONFIG: ProceduralMemoryConfig = {
  maxUnits: 1000,
  minSuccessRate: 0.3,
  patternThreshold: 3,
  autoExtract: true,
  decayFactor: 0.95,
}

export class ProceduralMemory {
  private config: ProceduralMemoryConfig
  private memoryUnits: Map<string, MemoryUnit> = new Map()
  private trajectories: TaskTrajectory[] = []
  private workflowPatterns: Map<string, WorkflowPattern> = new Map()
  private currentTrajectory: TaskTrajectory | null = null

  constructor(config: Partial<ProceduralMemoryConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  startTrajectory(taskType: string, tags: string[] = []): string {
    const id = `traj-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`

    this.currentTrajectory = {
      id,
      taskType,
      steps: [],
      success: false,
      duration: 0,
      timeCreated: Date.now(),
      tags,
    }

    log.debug("trajectory started", { id, taskType })

    return id
  }

  addStep(
    action: string,
    tool: string | undefined,
    input: Record<string, unknown> | undefined,
    output: string | undefined,
    success: boolean,
    duration: number,
  ): string {
    if (!this.currentTrajectory) {
      throw new Error("No active trajectory")
    }

    const step: TrajectoryStep = {
      order: this.currentTrajectory.steps.length,
      action,
      tool,
      input,
      output,
      success,
      duration,
    }

    this.currentTrajectory.steps.push(step)

    if (this.config.autoExtract && success) {
      this.extractMemoryUnit(action, tool, input, output)
    }

    log.debug("step added", { order: step.order, action, success })

    return step.order.toString()
  }

  endTrajectory(success: boolean): TaskTrajectory | null {
    if (!this.currentTrajectory) {
      return null
    }

    this.currentTrajectory.success = success
    this.currentTrajectory.duration = Date.now() - this.currentTrajectory.timeCreated

    this.trajectories.push(this.currentTrajectory)

    if (success && this.currentTrajectory.steps.length >= this.config.patternThreshold) {
      this.extractWorkflowPattern(this.currentTrajectory)
    }

    const finished = this.currentTrajectory
    this.currentTrajectory = null

    log.debug("trajectory ended", {
      id: finished.id,
      success,
      steps: finished.steps.length,
    })

    return finished
  }

  private extractMemoryUnit(
    action: string,
    tool: string | undefined,
    input: Record<string, unknown> | undefined,
    output: string | undefined,
  ): string {
    const id = `mem-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`

    const unit: MemoryUnit = {
      id,
      type: "step",
      content: `${action}${tool ? ` [${tool}]` : ""}`,
      metadata: {
        action,
        tool,
        input: input ? JSON.stringify(input).slice(0, 200) : undefined,
        output: output ? output.slice(0, 200) : undefined,
      },
      success: true,
      usageCount: 0,
      successRate: 1.0,
      avgDuration: 0,
      timeCreated: Date.now(),
      lastUsed: Date.now(),
      tags: [action, tool || "unknown"].filter(Boolean),
    }

    this.memoryUnits.set(id, unit)

    return id
  }

  private extractWorkflowPattern(trajectory: TaskTrajectory): void {
    const existing = this.findSimilarPattern(trajectory)

    if (existing) {
      existing.usageCount++
      existing.lastUsed = Date.now()
      existing.successRate =
        (existing.successRate * (existing.usageCount - 1) + (trajectory.success ? 1 : 0)) / existing.usageCount
    } else {
      const id = `pattern-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`

      const pattern: WorkflowPattern = {
        id,
        name: `${trajectory.taskType} workflow`,
        description: this.generatePatternDescription(trajectory),
        steps: trajectory.steps.map((s) => ({
          order: s.order,
          action: s.action,
          tool: s.tool,
          conditions: [],
          expectedOutcome: s.output?.slice(0, 100),
        })),
        successRate: trajectory.success ? 1.0 : 0.0,
        usageCount: 1,
        applicableTasks: [trajectory.taskType],
        timeCreated: Date.now(),
        lastUsed: Date.now(),
      }

      this.workflowPatterns.set(id, pattern)

      log.info("workflow pattern extracted", {
        id,
        taskType: trajectory.taskType,
        steps: pattern.steps.length,
      })
    }
  }

  private findSimilarPattern(trajectory: TaskTrajectory): WorkflowPattern | null {
    for (const pattern of this.workflowPatterns.values()) {
      if (!pattern.applicableTasks.includes(trajectory.taskType)) {
        continue
      }

      const stepDiff = Math.abs(pattern.steps.length - trajectory.steps.length)
      if (stepDiff <= 1) {
        return pattern
      }
    }

    return null
  }

  private generatePatternDescription(trajectory: TaskTrajectory): string {
    const stepSummary = trajectory.steps
      .slice(0, 3)
      .map((s) => s.action)
      .join(" -> ")

    return `${trajectory.taskType}: ${stepSummary}${trajectory.steps.length > 3 ? " -> ..." : ""}`
  }

  getRelevantMemory(taskType: string): MemoryUnit[] {
    const relevant: MemoryUnit[] = []

    for (const pattern of this.workflowPatterns.values()) {
      if (pattern.applicableTasks.includes(taskType) && pattern.successRate >= this.config.minSuccessRate) {
        for (const step of pattern.steps) {
          const units = Array.from(this.memoryUnits.values()).filter(
            (u) => u.tags.includes(step.action) || (step.tool && u.tags.includes(step.tool)),
          )
          relevant.push(...units)
        }
      }
    }

    relevant.sort((a, b) => {
      const scoreA = a.successRate * (1 + Math.log(a.usageCount + 1) * 0.1)
      const scoreB = b.successRate * (1 + Math.log(b.usageCount + 1) * 0.1)
      return scoreB - scoreA
    })

    return relevant.slice(0, 20)
  }

  getWorkflowPatterns(taskType?: string): WorkflowPattern[] {
    let patterns = Array.from(this.workflowPatterns.values())

    if (taskType) {
      patterns = patterns.filter((p) => p.applicableTasks.includes(taskType))
    }

    patterns.sort((a, b) => {
      const scoreA = a.successRate * a.usageCount
      const scoreB = b.successRate * b.usageCount
      return scoreB - scoreA
    })

    return patterns
  }

  getBestPattern(taskType: string): WorkflowPattern | null {
    const patterns = this.getWorkflowPatterns(taskType)
    return patterns.length > 0 ? patterns[0] : null
  }

  suggestNextStep(taskType: string, currentStep: number): string | null {
    const pattern = this.getBestPattern(taskType)
    return pattern?.steps[currentStep]?.action || null
  }

  getStats(): {
    totalMemoryUnits: number
    totalTrajectories: number
    totalPatterns: number
    averageSuccessRate: number
    mostUsedPattern: WorkflowPattern | null
  } {
    const units = Array.from(this.memoryUnits.values())
    const patterns = Array.from(this.workflowPatterns.values())

    const avgSuccessRate = units.length > 0 ? units.reduce((sum, u) => sum + u.successRate, 0) / units.length : 0

    const mostUsed = patterns.length > 0 ? patterns.sort((a, b) => b.usageCount - a.usageCount)[0] : null

    return {
      totalMemoryUnits: units.length,
      totalTrajectories: this.trajectories.length,
      totalPatterns: patterns.length,
      averageSuccessRate: avgSuccessRate,
      mostUsedPattern: mostUsed,
    }
  }

  clear(): void {
    this.memoryUnits.clear()
    this.trajectories = []
    this.workflowPatterns.clear()
    this.currentTrajectory = null
    log.info("procedural memory cleared")
  }
}

export const globalProceduralMemory = new ProceduralMemory()

export function createProceduralMemory(config?: Partial<ProceduralMemoryConfig>): ProceduralMemory {
  return new ProceduralMemory(config)
}
