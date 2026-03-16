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

export interface ExperienceLearningSnapshot {
  version: 1
  experiences: Experience[]
  patterns: LearnedPattern[]
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
    const signature = this.experienceSignature({
      situation: params.situation,
      action: params.action,
      context: params.context,
      success: params.success,
    })
    const existing = this.experiences.find((experience) => this.experienceSignature(experience) === signature)
    if (existing) {
      existing.timestamp = Date.now()
      existing.outcome = summarizeOutcome(existing.outcome, params.outcome)
      existing.tags = [...new Set([...existing.tags, ...(params.tags ?? [])])]
      existing.lessons = [...new Set([...existing.lessons, ...(params.lessons ?? [])])]
      existing.applicableTo = [...new Set([...existing.applicableTo, ...(params.applicableTo ?? [])])]
      existing.timesApplied = Math.max(1, existing.timesApplied) + 1
      existing.timesSucceeded = (existing.timesSucceeded ?? (existing.success ? 1 : 0)) + (params.success ? 1 : 0)
      existing.effectiveness = existing.timesSucceeded / Math.max(1, existing.timesApplied)
      this.rebuildIndexes()
      this.detectAndCreatePattern(existing)
      return existing
    }

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
      timesApplied: 1,
      timesSucceeded: params.success ? 1 : 0,
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
    const contextKeys = this.getContextKeys(experience.context)
    for (const contextKey of contextKeys) {
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

  private getContextKeys(context: Record<string, unknown> | ContextualLearning): string[] {
    const tokens = this.contextTokens(context)
    if (tokens.length === 0) return []
    return [...tokens, tokens.join("|")]
  }

  private contextTokens(context: Record<string, unknown> | ContextualLearning): string[] {
    const parts: string[] = []
    if ("projectType" in context && context.projectType) parts.push(`pt:${String(context.projectType)}`)
    if ("language" in context && context.language) parts.push(`lang:${String(context.language)}`)
    if ("framework" in context && context.framework) parts.push(`fw:${String(context.framework)}`)
    if ("taskType" in context && context.taskType) parts.push(`task:${String(context.taskType)}`)
    if ("complexity" in context && context.complexity) parts.push(`cx:${String(context.complexity)}`)
    return parts
  }

  private pruneOldExperiences(): void {
    const now = Date.now()
    const sorted = [...this.experiences].sort((a, b) => scoreExperienceRetention(b, now) - scoreExperienceRetention(a, now))
    this.experiences = sorted.slice(0, MAX_EXPERIENCES)
    this.rebuildIndexes()
  }

  /**
   * Remove experiences whose computed success rate falls below `minSuccessRate`
   * AND that have not been applied within the last `maxAgeDays` days.
   * Returns the number of entries evicted.
   */
  evictByTimeAndRate(minSuccessRate: number, maxAgeDays: number): number {
    const cutoff = Date.now() - maxAgeDays * 24 * 60 * 60 * 1000
    const before = this.experiences.length
    this.experiences = this.experiences.filter((exp) => {
      const rate = exp.timesApplied > 0 ? exp.timesSucceeded / exp.timesApplied : (exp.success ? 1 : 0)
      const isStaleByRate = rate < minSuccessRate
      const isStaleByTime = exp.timestamp < cutoff
      // Keep unless both conditions are met
      return !(isStaleByRate && isStaleByTime)
    })
    if (this.experiences.length < before) this.rebuildIndexes()
    return before - this.experiences.length
  }

  private rebuildIndexes(): void {
    this.contextIndex.clear()
    this.tagIndex.clear()
    for (const experience of this.experiences) {
      this.indexExperience(experience)
    }
  }

  private experienceSignature(input: {
    situation: string
    action: string
    context: Record<string, unknown>
    success: boolean
  }) {
    return [
      input.success ? "success" : "failure",
      normalizeExperienceText(input.situation),
      normalizeExperienceText(input.action),
      this.contextTokens(input.context).sort().join("|"),
    ].join("::")
  }

  private detectAndCreatePattern(experience: Experience): void {
    const similar = this.findSimilarExperiences(experience, 3)
    const totalObservations = similar.length + Math.max(1, experience.timesApplied)
    const successes = similar.filter((e) => e.success).length + experience.timesSucceeded
    const successRate = successes / Math.max(1, totalObservations)

    if (totalObservations >= PATTERN_THRESHOLD && successRate >= SUCCESS_RATE_THRESHOLD) {
      const existingPattern = this.findExistingPattern(experience.action)

      if (existingPattern) {
        existingPattern.frequency = Math.max(existingPattern.frequency, totalObservations)
        existingPattern.timesSucceeded = Math.max(existingPattern.timesSucceeded, successes)
        existingPattern.successRate = successRate
        existingPattern.lastUsed = Date.now()
      } else {
        const pattern: LearnedPattern = {
          id: `pattern-${Date.now()}`,
          trigger: experience.situation,
          action: experience.action,
          expectedOutcome: experience.outcome,
          successRate,
          frequency: totalObservations,
          lastUsed: Date.now(),
          context: this.contextTokens(experience.context),
          conditions: this.extractConditions(experience),
          timesApplied: experience.timesApplied,
          timesSucceeded: experience.timesSucceeded,
        }
        this.patterns.set(pattern.id, pattern)
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
    return this.contextTokens(experience.context)
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
    const tokens = this.contextTokens(context)

    this.patterns.forEach((pattern) => {
      let score = 0

      pattern.conditions.forEach((condition) => {
        if (condition === `task:${context.taskType}`) score += 4
        if (condition === `lang:${context.language}`) score += 3
        if (condition === `fw:${context.framework}`) score += 3
        if (condition === `pt:${context.projectType}`) score += 2
        if (condition === `cx:${context.complexity}`) score += 2
      })

      tokens.forEach((token) => {
        if (pattern.context.includes(token)) score += 1.5
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
    const relevant = new Set<Experience>()

    this.getContextKeys(context).forEach((contextKey) => {
      for (const item of this.contextIndex.get(contextKey) ?? []) {
        relevant.add(item)
      }
    })

    if (context.taskType) {
      const taskRelevant = this.tagIndex.get(context.taskType) ?? []
      taskRelevant.forEach((item) => relevant.add(item))
    }

    return [...relevant]
      .filter((e) => e.effectiveness >= 0.7)
      .sort((a, b) => {
        const aScore = this.scoreExperienceForContext(a, context)
        const bScore = this.scoreExperienceForContext(b, context)
        return bScore - aScore
      })
      .slice(0, 5)
  }

  private scoreExperienceForContext(experience: Experience, context: ContextualLearning): number {
    const wanted = new Set(this.contextTokens(context))
    let score = experience.success ? 1 : 0
    for (const token of this.contextTokens(experience.context)) {
      if (!wanted.has(token)) continue
      if (token.startsWith("task:")) score += 4
      else if (token.startsWith("cx:")) score += 2
      else score += 3
    }
    if (experience.timesApplied > 0) score += 1.5
    return score
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

  snapshot(): ExperienceLearningSnapshot {
    return {
      version: 1,
      experiences: structuredClone(this.experiences),
      patterns: Array.from(this.patterns.values()).map((pattern) => structuredClone(pattern)),
    }
  }

  restore(snapshot: ExperienceLearningSnapshot): void {
    this.experiences = []
    this.patterns.clear()
    this.contextIndex.clear()
    this.tagIndex.clear()

    for (const experience of snapshot.experiences ?? []) {
      this.experiences.push(experience)
      this.indexExperience(experience)
    }

    for (const pattern of snapshot.patterns ?? []) {
      this.patterns.set(pattern.id, pattern)
    }
  }
}

function scoreExperienceRetention(experience: Experience, now: number) {
  const ageDays = Math.max(0, now - experience.timestamp) / (24 * 60 * 60 * 1000)
  const recency = Math.max(0.15, 1 - ageDays / 30)
  const usage = Math.min(1.5, (experience.timesApplied + experience.timesSucceeded) / 6)
  const contextRichness = Math.min(0.5, Object.keys(experience.context).length * 0.08)
  return experience.effectiveness * 2 + usage + recency + contextRichness + (experience.success ? 0.3 : 0)
}

function normalizeExperienceText(text: string) {
  return text.toLowerCase().replace(/\s+/g, " ").trim()
}

function summarizeOutcome(existing: string, incoming: string) {
  const next = incoming.replace(/\s+/g, " ").trim()
  if (!next) return existing
  if (!existing) return next
  if (existing === next) return existing
  return next.length >= existing.length ? next : existing
}
