/**
 * ACE: Agentic Context Engineering - Evolving Contexts
 *
 * This module implements the ACE approach from 2025 Microsoft Research:
 * - Treats contexts as evolving playbooks
 * - Accumulates and refines strategies through generation, reflection, and curation
 * - Prevents context collapse while optimizing prompts
 *
 * Reference: Microsoft Research - Agentic Context Engineering
 */

import { Log } from "@/util/log"

const log = Log.create({ service: "ace-context" })

/**
 * Strategy entry in the playbook
 */
export interface StrategyEntry {
  id: string
  prompt: string
  outcome: "success" | "failure" | "partial"
  score: number
  context: Record<string, unknown>
  feedback: string
  usageCount: number
  lastUsed: number
  timeCreated: number
}

/**
 * Strategy category
 */
export type StrategyCategory =
  | "planning"
  | "debugging"
  | "refactoring"
  | "exploration"
  | "implementation"
  | "review"
  | "general"

/**
 * Playbook entry
 */
export interface PlaybookEntry {
  category: StrategyCategory
  strategies: StrategyEntry[]
  timeUpdated: number
}

/**
 * ACE configuration
 */
export interface ACEConfig {
  /** Maximum strategies per category */
  maxStrategiesPerCategory: number
  /** Minimum score to keep strategy */
  minScoreThreshold: number
  /** Score decay factor */
  decayFactor: number
  /** Enable auto-curation */
  autoCuration: boolean
  /** Reflection interval */
  reflectionInterval: number
}

/**
 * Default configuration
 */
const DEFAULT_CONFIG: ACEConfig = {
  maxStrategiesPerCategory: 20,
  minScoreThreshold: 0.3,
  decayFactor: 0.95,
  autoCuration: true,
  reflectionInterval: 5,
}

/**
 * ACE - Agentic Context Engineering
 *
 * Maintains a playbook of effective strategies that evolve over time:
 * 1. Generation: Try new prompt strategies
 * 2. Reflection: Evaluate outcomes
 * 3. Curation: Keep effective strategies, discard failures
 */
export class ACEContext {
  private config: ACEConfig
  private playbook: Map<StrategyCategory, StrategyEntry[]> = new Map()
  private sessionStrategies: StrategyEntry[] = []
  private reflectionCounter: number = 0
  private initialized: boolean = false

  constructor(config: Partial<ACEConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }

    // Initialize all categories
    const categories: StrategyCategory[] = [
      "planning",
      "debugging",
      "refactoring",
      "exploration",
      "implementation",
      "review",
      "general",
    ]

    for (const cat of categories) {
      this.playbook.set(cat, [])
    }
  }

  /**
   * Get playbook entry for a category
   */
  getPlaybook(category: StrategyCategory): StrategyEntry[] {
    return this.playbook.get(category) || []
  }

  /**
   * Add a new strategy to the playbook
   */
  addStrategy(
    category: StrategyCategory,
    prompt: string,
    outcome: "success" | "failure" | "partial",
    score: number,
    context: Record<string, unknown> = {},
    feedback: string = "",
  ): StrategyEntry {
    const entry: StrategyEntry = {
      id: `${category}-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`,
      prompt,
      outcome,
      score,
      context,
      feedback,
      usageCount: 0,
      lastUsed: Date.now(),
      timeCreated: Date.now(),
    }

    // Add to category playbook
    const categoryStrategies = this.playbook.get(category) || []
    categoryStrategies.push(entry)

    // Add to session strategies
    this.sessionStrategies.push(entry)

    // Auto-curation if enabled
    if (this.config.autoCuration) {
      this.curateCategory(category)
    }

    log.debug("strategy added", { category, outcome, score, id: entry.id })

    return entry
  }

  /**
   * Get best strategy for a category and task
   */
  getBestStrategy(category: StrategyCategory, taskContext: Record<string, unknown> = {}): StrategyEntry | null {
    const strategies = this.playbook.get(category) || []
    if (strategies.length === 0) {
      return null
    }

    // Score strategies based on:
    // - Historical score
    // - Recency (prefer recently used)
    // - Usage count (prefer tested strategies)
    const scored = strategies.map((s) => {
      let score = s.score

      // Boost recently used strategies
      const hoursSinceUse = (Date.now() - s.lastUsed) / (1000 * 60 * 60)
      if (hoursSinceUse < 1) {
        score *= 1.2
      } else if (hoursSinceUse > 24) {
        score *= this.config.decayFactor
      }

      // Boost strategies with more usage (proven effectiveness)
      score *= Math.min(1.5, 1 + Math.log(s.usageCount + 1) * 0.1)

      return { strategy: s, effectiveScore: score }
    })

    // Sort by effective score
    scored.sort((a, b) => b.effectiveScore - a.effectiveScore)

    // Update usage count
    const selected = scored[0].strategy
    selected.usageCount++
    selected.lastUsed = Date.now()

    log.debug("best strategy selected", {
      category,
      id: selected.id,
      score: selected.score,
      effectiveScore: scored[0].effectiveScore,
    })

    return selected
  }

  /**
   * Generate context from playbook
   */
  generateContext(category: StrategyCategory, taskContext: Record<string, unknown> = {}): string {
    const bestStrategy = this.getBestStrategy(category, taskContext)

    if (!bestStrategy) {
      return ""
    }

    const parts: string[] = []

    // Add strategy prompt
    parts.push(`## Strategy from Playbook (${category})`)
    parts.push("")
    parts.push(bestStrategy.prompt)

    // Add success feedback if available
    if (bestStrategy.feedback && bestStrategy.outcome === "success") {
      parts.push("")
      parts.push(`### Previous Success Feedback`)
      parts.push(bestStrategy.feedback)
    }

    // Add usage info
    parts.push("")
    parts.push(`*This strategy has been used ${bestStrategy.usageCount} times*`)

    return parts.join("\n")
  }

  /**
   * Curate strategies for a category
   */
  private curateCategory(category: StrategyCategory): void {
    const strategies = this.playbook.get(category) || []

    // Remove strategies below threshold
    const kept = strategies.filter((s) => s.score >= this.config.minScoreThreshold)

    // Sort by score and keep top N
    kept.sort((a, b) => b.score - a.score)
    const truncated = kept.slice(0, this.config.maxStrategiesPerCategory)

    this.playbook.set(category, truncated)

    if (truncated.length < strategies.length) {
      log.info("playbook curated", {
        category,
        before: strategies.length,
        after: truncated.length,
      })
    }
  }

  /**
   * Trigger reflection
   */
  async reflect(
    recentOutcomes: Array<{
      category: StrategyCategory
      prompt: string
      outcome: "success" | "failure" | "partial"
      feedback?: string
    }>,
  ): Promise<string> {
    this.reflectionCounter++

    const reflections: string[] = []
    reflections.push(`## Reflection #${this.reflectionCounter}`)

    // Analyze recent outcomes
    const categoryStats = new Map<StrategyCategory, { success: number; failure: number; partial: number }>()

    for (const outcome of recentOutcomes) {
      const stats = categoryStats.get(outcome.category) || {
        success: 0,
        failure: 0,
        partial: 0,
      }

      if (outcome.outcome === "success") stats.success++
      else if (outcome.outcome === "failure") stats.failure++
      else stats.partial++

      categoryStats.set(outcome.category, stats)

      // Update strategy scores
      this.updateStrategyScores(outcome.category, outcome.prompt, outcome.outcome)
    }

    // Generate insights
    reflections.push("")
    reflections.push("### Category Performance")

    for (const [category, stats] of categoryStats) {
      const total = stats.success + stats.failure + stats.partial
      const successRate = total > 0 ? (stats.success / total) * 100 : 0

      reflections.push(
        `- **${category}**: ${stats.success} success, ${stats.failure} failure, ${stats.partial} partial (${successRate.toFixed(0)}% success rate)`,
      )
    }

    // Identify patterns
    const patterns = this.identifyPatterns(recentOutcomes)
    if (patterns.length > 0) {
      reflections.push("")
      reflections.push("### Patterns Identified")
      for (const pattern of patterns) {
        reflections.push(`- ${pattern}`)
      }
    }

    // Recommendations
    const recommendations = this.generateRecommendations(categoryStats)
    if (recommendations.length > 0) {
      reflections.push("")
      reflections.push("### Recommendations")
      for (const rec of recommendations) {
        reflections.push(`- ${rec}`)
      }
    }

    log.info("reflection complete", {
      reflectionNumber: this.reflectionCounter,
      categoriesAnalyzed: categoryStats.size,
    })

    return reflections.join("\n")
  }

  /**
   * Update strategy scores based on outcomes
   */
  private updateStrategyScores(
    category: StrategyCategory,
    prompt: string,
    outcome: "success" | "failure" | "partial",
  ): void {
    const strategies = this.playbook.get(category) || []

    // Find matching strategy
    const match = strategies.find((s) => s.prompt === prompt || s.prompt.includes(prompt.slice(0, 50)))

    if (match) {
      // Update score based on outcome
      if (outcome === "success") {
        match.score = Math.min(1, match.score * 1.1 + 0.1)
      } else if (outcome === "failure") {
        match.score = Math.max(0, match.score * 0.8 - 0.1)
      } else {
        match.score = match.score * 0.95
      }

      log.debug("strategy score updated", {
        id: match.id,
        outcome,
        newScore: match.score,
      })
    }
  }

  /**
   * Identify patterns in recent outcomes
   */
  private identifyPatterns(outcomes: Array<{ category: StrategyCategory; prompt: string; outcome: string }>): string[] {
    const patterns: string[] = []

    // Check for success patterns
    const successPrompts = outcomes.filter((o) => o.outcome === "success").map((o) => o.prompt)

    if (successPrompts.length >= 2) {
      // Look for common elements
      const commonWords = this.findCommonWords(successPrompts)
      if (commonWords.length > 0) {
        patterns.push(`Successful tasks often include: ${commonWords.slice(0, 5).join(", ")}`)
      }
    }

    // Check for failure patterns
    const failurePrompts = outcomes.filter((o) => o.outcome === "failure").map((o) => o.prompt)

    if (failurePrompts.length >= 2) {
      patterns.push(`Consider breaking down complex tasks into smaller steps`)
    }

    // Category-specific patterns
    const categoryOutcomes = new Map<StrategyCategory, string[]>()
    for (const outcome of outcomes) {
      const existing = categoryOutcomes.get(outcome.category) || []
      existing.push(outcome.outcome)
      categoryOutcomes.set(outcome.category, existing)
    }

    for (const [category, outs] of categoryOutcomes) {
      const failRate = outs.filter((o) => o === "failure").length / outs.length
      if (failRate > 0.5) {
        patterns.push(`${category} tasks have high failure rate - consider more planning`)
      }
    }

    return patterns
  }

  /**
   * Find common words in prompts
   */
  private findCommonWords(prompts: string[]): string[] {
    const wordCounts = new Map<string, number>()

    for (const prompt of prompts) {
      const words = prompt.toLowerCase().split(/\s+/)
      const unique = new Set(words)
      for (const word of unique) {
        if (word.length > 4) {
          wordCounts.set(word, (wordCounts.get(word) || 0) + 1)
        }
      }
    }

    // Sort by count
    const sorted = Array.from(wordCounts.entries()).sort((a, b) => b[1] - a[1])

    return sorted.slice(0, 10).map(([word]) => word)
  }

  /**
   * Generate recommendations based on category stats
   */
  private generateRecommendations(
    stats: Map<StrategyCategory, { success: number; failure: number; partial: number }>,
  ): string[] {
    const recommendations: string[] = []

    for (const [category, stat] of stats) {
      const total = stat.success + stat.failure + stat.partial
      if (total < 2) continue

      const successRate = stat.success / total

      if (successRate < 0.3) {
        recommendations.push(
          `Consider improving ${category} strategy - only ${(successRate * 100).toFixed(0)}% success rate`,
        )
      } else if (successRate > 0.8) {
        recommendations.push(
          `${category} strategy is performing well - consider applying similar approaches to other categories`,
        )
      }
    }

    return recommendations
  }

  /**
   * Export playbook
   */
  exportPlaybook(): Record<StrategyCategory, StrategyEntry[]> {
    const exportData: Record<StrategyCategory, StrategyEntry[]> = {} as Record<StrategyCategory, StrategyEntry[]>

    for (const [category, strategies] of this.playbook) {
      exportData[category] = [...strategies]
    }

    return exportData
  }

  /**
   * Import playbook
   */
  importPlaybook(data: Record<StrategyCategory, StrategyEntry[]>): void {
    for (const [category, strategies] of Object.entries(data)) {
      this.playbook.set(category as StrategyCategory, strategies)
    }

    log.info("playbook imported", { categories: Object.keys(data).length })
  }

  /**
   * Clear all strategies
   */
  clear(): void {
    for (const category of this.playbook.keys()) {
      this.playbook.set(category, [])
    }
    this.sessionStrategies = []
    this.reflectionCounter = 0

    log.info("playbook cleared")
  }

  /**
   * Get statistics
   */
  getStats(): {
    totalStrategies: number
    categoryCounts: Record<StrategyCategory, number>
    reflectionCount: number
  } {
    let total = 0
    const counts: Record<StrategyCategory, number> = {} as Record<StrategyCategory, number>

    for (const [category, strategies] of this.playbook) {
      counts[category] = strategies.length
      total += strategies.length
    }

    return {
      totalStrategies: total,
      categoryCounts: counts,
      reflectionCount: this.reflectionCounter,
    }
  }
}

/**
 * Global ACE instance
 */
export const globalACE = new ACEContext()

/**
 * Create new ACE instance
 */
export function createACE(config?: Partial<ACEConfig>): ACEContext {
  return new ACEContext(config)
}
