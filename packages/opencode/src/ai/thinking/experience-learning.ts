import { z } from "zod"

export enum ExperienceCategory {
  SUCCESS = "success",
  FAILURE = "failure",
  PATTERN = "pattern",
  INSIGHT = "insight",
  ADAPTATION = "adaptation",
}

export const Experience = z.object({
  id: z.string(),
  category: z.nativeEnum(ExperienceCategory),
  situation: z.string(),
  action: z.string(),
  outcome: z.string(),
  context: z.record(z.string(), z.unknown()),
  timestamp: z.number(),
  success: z.boolean(),
  tags: z.array(z.string()),
  lessons: z.array(z.string()),
  applicableTo: z.array(z.string()),
  effectiveness: z.number().min(0).max(1),
  timesApplied: z.number().default(0),
  timesSucceeded: z.number().default(0),
})

export type Experience = z.infer<typeof Experience>

export interface LearnedPattern {
  id: string
  trigger: string
  action: string
  expectedOutcome: string
  successRate: number
  frequency: number
  lastUsed: number
  context: string[]
  conditions: string[]
  timesApplied: number
  timesSucceeded: number
}

export interface ContextualLearning {
  projectType?: string
  language?: string
  framework?: string
  taskType?: string
  complexity?: "simple" | "moderate" | "complex"
}

const MAX_EXPERIENCES = 1000
const PATTERN_THRESHOLD = 3
const SUCCESS_RATE_THRESHOLD = 0.7

export class ExperienceLearning {
  private experiences: Experience[] = []
  private patterns: Map<string, LearnedPattern> = new Map()
  private contextIndex: Map<string, Experience[]> = new Map()
  private tagIndex: Map<string, Experience[]> = new Map()

  recordExperience(params: {
    situation: string
    action: string
    outcome: string
    context: Record<string, unknown>
    success: boolean
    tags?: string[]
    lessons?: string[]
    applicableTo?: string[]
  }): Experience {
    const experience: Experience = {
      id: `exp-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      category: params.success ? ExperienceCategory.SUCCESS : ExperienceCategory.FAILURE,
      situation: params.situation,
      action: params.action,
      outcome: params.outcome,
      context: params.context,
      timestamp: Date.now(),
      success: params.success,
      tags: params.tags ?? [],
      lessons: params.lessons ?? [],
      applicableTo: params.applicableTo ?? [],
      effectiveness: params.success ? 1 : 0,
      timesApplied: 0,
      timesSucceeded: 0,
    }

    this.experiences.push(experience)
    this.indexExperience(experience)

    if (this.experiences.length > MAX_EXPERIENCES) {
      this.pruneOldExperiences()
    }

    this.detectAndCreatePattern(experience)

    return experience
  }

  private indexExperience(experience: Experience): void {
    const contextKey = this.getContextKey(experience.context)
    if (contextKey) {
      const existing = this.contextIndex.get(contextKey) ?? []
      existing.push(experience)
      this.contextIndex.set(contextKey, existing)
    }

    experience.tags.forEach((tag) => {
      const existing = this.tagIndex.get(tag) ?? []
      existing.push(experience)
      this.tagIndex.set(tag, existing)
    })
  }

  private getContextKey(context: Record<string, unknown> | ContextualLearning): string {
    const parts: string[] = []
    if ("projectType" in context && context.projectType) parts.push(`pt:${context.projectType}`)
    if ("language" in context && context.language) parts.push(`lang:${context.language}`)
    if ("framework" in context && context.framework) parts.push(`fw:${context.framework}`)
    if ("taskType" in context && context.taskType) parts.push(`task:${context.taskType}`)
    return parts.join("|")
  }

  private pruneOldExperiences(): void {
    const sorted = [...this.experiences].sort((a, b) => b.effectiveness - a.effectiveness)
    this.experiences = sorted.slice(0, MAX_EXPERIENCES)
  }

  private detectAndCreatePattern(experience: Experience): void {
    const similar = this.findSimilarExperiences(experience, 3)

    if (similar.length >= PATTERN_THRESHOLD) {
      const successes = similar.filter((e) => e.success).length
      const successRate = successes / similar.length

      if (successRate >= SUCCESS_RATE_THRESHOLD) {
        const existingPattern = this.findExistingPattern(experience.action)

        if (existingPattern) {
          existingPattern.frequency++
          existingPattern.timesSucceeded += experience.success ? 1 : 0
          existingPattern.successRate =
            (existingPattern.successRate * (existingPattern.frequency - 1) + (experience.success ? 1 : 0)) /
            existingPattern.frequency
          existingPattern.lastUsed = Date.now()
        } else {
          const pattern: LearnedPattern = {
            id: `pattern-${Date.now()}`,
            trigger: experience.situation,
            action: experience.action,
            expectedOutcome: experience.outcome,
            successRate,
            frequency: similar.length,
            lastUsed: Date.now(),
            context: Object.keys(experience.context),
            conditions: this.extractConditions(experience),
            timesApplied: 0,
            timesSucceeded: 0,
          }
          this.patterns.set(pattern.id, pattern)
        }
      }
    }
  }

  private findSimilarExperiences(experience: Experience, limit: number): Experience[] {
    return this.experiences
      .filter((e) => e.id !== experience.id)
      .filter((e) => {
        const situationSimilarity = this.stringSimilarity(e.situation, experience.situation)
        const actionSimilarity = this.stringSimilarity(e.action, experience.action)
        return situationSimilarity > 0.5 || actionSimilarity > 0.5
      })
      .sort((a, b) => b.timestamp - a.timestamp)
      .slice(0, limit)
  }

  private stringSimilarity(a: string, b: string): number {
    const aSet = new Set(a.toLowerCase().split(" "))
    const bSet = new Set(b.toLowerCase().split(" "))
    const intersection = new Set([...aSet].filter((x) => bSet.has(x)))
    const union = new Set([...aSet, ...bSet])
    return union.size > 0 ? intersection.size / union.size : 0
  }

  private findExistingPattern(action: string): LearnedPattern | undefined {
    return Array.from(this.patterns.values()).find((p) => p.action.toLowerCase() === action.toLowerCase())
  }

  private extractConditions(experience: Experience): string[] {
    const conditions: string[] = []
    if (experience.context.taskType) conditions.push(`taskType:${experience.context.taskType}`)
    if (experience.context.complexity) conditions.push(`complexity:${experience.context.complexity}`)
    return conditions
  }

  applyPattern(patternId: string): Experience | null {
    const pattern = this.patterns.get(patternId)
    if (!pattern) return null

    pattern.timesApplied++

    return this.recordExperience({
      situation: pattern.trigger,
      action: pattern.action,
      outcome: pattern.expectedOutcome,
      context: Object.fromEntries(pattern.context.map((c) => [c, true] as [string, unknown])),
      success: true,
      tags: ["pattern-application"],
      lessons: [`Applied learned pattern: ${pattern.action}`],
      applicableTo: pattern.context,
    })
  }

  getRelevantPatterns(context: ContextualLearning): LearnedPattern[] {
    const relevant: { pattern: LearnedPattern; score: number }[] = []

    this.patterns.forEach((pattern) => {
      let score = 0

      pattern.context.forEach((ctx) => {
        if (ctx === `taskType:${context.taskType}`) score += 3
        if (ctx === `language:${context.language}`) score += 2
        if (ctx === `framework:${context.framework}`) score += 2
        if (ctx === `complexity:${context.complexity}`) score += 1
      })

      score += pattern.successRate * 2

      if (score > 0) {
        relevant.push({ pattern, score })
      }
    })

    return relevant
      .sort((a, b) => b.score - a.score)
      .slice(0, 10)
      .map((r) => r.pattern)
  }

  getApplicableInsights(context: ContextualLearning): Experience[] {
    const contextKey = this.getContextKey(context)
    let relevant = this.contextIndex.get(contextKey) ?? []

    if (context.taskType) {
      const taskRelevant = this.tagIndex.get(context.taskType) ?? []
      relevant = [...new Set([...relevant, ...taskRelevant])]
    }

    return relevant
      .filter((e) => e.effectiveness >= 0.7)
      .sort((a, b) => {
        const aScore = (a.success ? 1 : 0) * (a.timesApplied > 0 ? 1.5 : 1)
        const bScore = (b.success ? 1 : 0) * (b.timesApplied > 0 ? 1.5 : 1)
        return bScore - aScore
      })
      .slice(0, 5)
  }

  learnFromReflection(
    reflection: {
      insights: string[]
      strategyAdjustments: string[]
      newHypotheses: string[]
    },
    context: Record<string, unknown>,
  ): void {
    reflection.strategyAdjustments.forEach((adjustment) => {
      this.recordExperience({
        situation: "Metacognitive reflection triggered strategy adjustment",
        action: adjustment,
        outcome: "Strategy adjusted",
        context,
        success: true,
        tags: ["reflection", "strategy-adjustment"],
        lessons: reflection.insights,
        applicableTo: ["strategy"],
      })
    })
  }

  getSuccessfulStrategies(taskType: string): { strategy: string; successRate: number }[] {
    const relevant = this.tagIndex.get(taskType) ?? []

    const strategyMap = new Map<string, { total: number; success: number }>()

    relevant.forEach((exp) => {
      exp.lessons.forEach((lesson) => {
        const existing = strategyMap.get(lesson) ?? { total: 0, success: 0 }
        existing.total++
        if (exp.success) existing.success++
        strategyMap.set(lesson, existing)
      })
    })

    return Array.from(strategyMap.entries())
      .map(([strategy, stats]) => ({
        strategy,
        successRate: stats.total > 0 ? stats.success / stats.total : 0,
      }))
      .filter((s) => s.successRate >= 0.5)
      .sort((a, b) => b.successRate - a.successRate)
  }

  getExperienceReport(context?: ContextualLearning): string {
    const relevant = context ? this.getApplicableInsights(context) : this.experiences
    const patterns = context ? this.getRelevantPatterns(context) : Array.from(this.patterns.values())

    return `
## Experience Learning Report

### Overall Statistics
- Total Experiences: ${this.experiences.length}
- Identified Patterns: ${this.patterns.size}
- Success Rate: ${(this.getOverallSuccessRate() * 100).toFixed(1)}%

### Recent Successful Experiences
${
  this.experiences
    .filter((e) => e.success)
    .slice(-5)
    .reverse()
    .map((e) => `- ${e.action}: ${e.outcome}`)
    .join("\n") || "None"
}

### Recent Failed Experiences
${
  this.experiences
    .filter((e) => !e.success)
    .slice(-5)
    .reverse()
    .map((e) => `- ${e.action}: ${e.outcome}`)
    .join("\n") || "None"
}

### Recommended Patterns (${context ? "Current Context" : "All"})
${
  patterns
    .slice(0, 5)
    .map((p) => `- ${p.action}: Success ${(p.successRate * 100).toFixed(0)}%, Used ${p.frequency} times`)
    .join("\n") || "None"
}
`
  }

  private getOverallSuccessRate(): number {
    if (this.experiences.length === 0) return 0
    return this.experiences.filter((e) => e.success).length / this.experiences.length
  }

  getExperiencesByCategory(category: ExperienceCategory): Experience[] {
    return this.experiences.filter((e) => e.category === category)
  }

  getPatterns(): LearnedPattern[] {
    return Array.from(this.patterns.values())
  }

  getAllTags(): string[] {
    return Array.from(this.tagIndex.keys())
  }

  mergeExperiences(other: ExperienceLearning): void {
    other.experiences.forEach((exp) => {
      if (!this.experiences.find((e) => e.id === exp.id)) {
        this.experiences.push(exp)
        this.indexExperience(exp)
      }
    })

    other.patterns.forEach((pattern) => {
      if (!this.findExistingPattern(pattern.action)) {
        this.patterns.set(pattern.id, pattern)
      }
    })
  }
}
