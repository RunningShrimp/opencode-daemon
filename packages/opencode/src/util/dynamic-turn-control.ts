/**
 * Dynamic Turn Control - Adjusts turn limits based on task complexity
 *
 * Implements turn-control strategies for cost optimization:
 * - Fixed turn limits (75th percentile)
 * - Dynamic adjustment based on success rate prediction
 * - Early termination for low-probability tasks
 *
 * Reference: arXiv:2510.16786 - "More with Less: An Empirical Study of Turn-Control Strategies"
 */

import { Log } from "@/util/log"

const log = Log.create({ service: "dynamic-turn-control" })

export interface Config {
  enabled: boolean
  maxTurns: number
  adaptiveThreshold: number
  budgetMultiplier: number
  enableDynamic: boolean
  minTurns: number
  earlyTermThreshold: number
}

export const DEFAULT_CONFIG: Config = {
  enabled: true,
  maxTurns: 30,
  adaptiveThreshold: 0.5,
  budgetMultiplier: 1.5,
  enableDynamic: true,
  minTurns: 5,
  earlyTermThreshold: 0.3,
}

interface ComplexityConfig {
  simple: number
  moderate: number
  complex: number
}

const COMPLEXITY: ComplexityConfig = {
  simple: 10,
  moderate: 20,
  complex: 35,
}

interface Usage {
  input: number
  output: number
  total: number
}

interface State {
  turn: number
  budget: number
  successHistory: number[]
  usageHistory: Usage[]
  start: number
  complexity: "simple" | "moderate" | "complex"
  maxTurns: number
}

export interface Result {
  shouldContinue: boolean
  reason: string
  confidence: number
  remaining: number
}

export type Complexity = "simple" | "moderate" | "complex"

export class DynamicTurnController {
  private config: Config
  private state: State
  private ready: boolean = false

  constructor(cfg: Partial<Config> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...cfg }

    this.state = {
      turn: 0,
      budget: 0,
      successHistory: [],
      usageHistory: [],
      start: 0,
      complexity: "moderate",
      maxTurns: 30,
    }
  }

  async initialize(complexity: Complexity = "moderate", estimated: number = 0): Promise<void> {
    this.state.complexity = complexity
    this.state.maxTurns = COMPLEXITY[complexity]

    if (estimated > 0) {
      this.state.budget = estimated * this.config.budgetMultiplier
    } else {
      this.state.budget = 75000
    }

    this.state.turn = 0
    this.state.successHistory = []
    this.state.usageHistory = []
    this.state.start = Date.now()

    this.ready = true

    log.info("initialized", {
      complexity,
      maxTurns: this.state.maxTurns,
      budget: this.state.budget,
    })
  }

  record(success: boolean, usage?: Usage): void {
    if (!this.ready || !this.config.enabled) return

    this.state.turn++
    this.state.successHistory.push(success ? 1 : 0)

    if (this.state.successHistory.length > 10) {
      this.state.successHistory.shift()
    }

    if (usage) {
      this.state.usageHistory.push(usage)
      if (this.state.usageHistory.length > 20) {
        this.state.usageHistory.shift()
      }
    }
  }

  shouldContinue(current: number): Result {
    if (!this.ready || !this.config.enabled) {
      return {
        shouldContinue: true,
        reason: "disabled",
        confidence: 1.0,
        remaining: this.config.maxTurns,
      }
    }

    const { turn, budget, successHistory } = this.state

    // Hard limit
    if (turn >= this.config.maxTurns) {
      return {
        shouldContinue: false,
        reason: `max turns (${this.config.maxTurns})`,
        confidence: 0.95,
        remaining: 0,
      }
    }

    // Budget check (priority over min turns for safety)
    const ratio = current / budget
    if (ratio > 1) {
      return {
        shouldContinue: false,
        reason: `budget exceeded (${(ratio * 100).toFixed(0)}%)`,
        confidence: 0.9,
        remaining: 0,
      }
    }

    // Minimum protection
    if (turn < this.config.minTurns) {
      return {
        shouldContinue: true,
        reason: `min turns (${this.config.minTurns})`,
        confidence: 1.0,
        remaining: this.config.maxTurns - turn,
      }
    }

    // Early termination
    const remainingRatio = 1 - ratio
    if (remainingRatio < this.config.earlyTermThreshold && turn > this.config.maxTurns * 0.7) {
      return {
        shouldContinue: false,
        reason: `budget low (${(remainingRatio * 100).toFixed(0)}% left)`,
        confidence: 0.7,
        remaining: 0,
      }
    }

    // Dynamic adjustment
    if (this.config.enableDynamic && successHistory.length >= 3) {
      const avg = this.average(successHistory)
      const trend = this.calculateTrend()

      if (avg < this.config.adaptiveThreshold && trend < -0.1) {
        const left = this.config.maxTurns - turn
        const prob = avg * (1 + trend) ** left

        if (prob < 0.3) {
          return {
            shouldContinue: false,
            reason: `low success (${(avg * 100).toFixed(0)}%), declining`,
            confidence: 0.8,
            remaining: 0,
          }
        }
      }
    }

    // Token pattern prediction
    if (this.state.usageHistory.length >= 3) {
      const avgPerTurn = this.calculateAvgUsage()
      const remainingBudget = budget - current
      const predicted = Math.floor(remainingBudget / avgPerTurn)

      if (predicted <= 1 && turn > this.config.minTurns) {
        return {
          shouldContinue: false,
          reason: `insufficient turns (${predicted})`,
          confidence: 0.75,
          remaining: predicted,
        }
      }
    }

    const left = this.config.maxTurns - turn
    return {
      shouldContinue: true,
      reason: "proceeding",
      confidence: 0.9,
      remaining: left,
    }
  }

  private average(arr: number[]): number {
    if (arr.length === 0) return 0
    return arr.reduce((a, b) => a + b, 0) / arr.length
  }

  private calculateTrend(): number {
    const h = this.state.successHistory
    if (h.length < 2) return 0

    const n = h.length
    const sumX = (n * (n - 1)) / 2
    const sumY = h.reduce((a, b) => a + b, 0)
    const sumXY = h.reduce((s, y, x) => s + x * y, 0)
    const sumX2 = h.reduce((s, _, x) => s + x * x, 0)

    const denom = n * sumX2 - sumX * sumX
    if (denom === 0) return 0

    return (n * sumXY - sumX * sumY) / denom
  }

  private calculateAvgUsage(): number {
    const h = this.state.usageHistory
    if (h.length === 0) return 5000

    const total = h.reduce((s, u) => s + u.total, 0)
    return total / h.length
  }

  getState(): State & { config: Config } {
    return { ...this.state, config: this.config }
  }

  getProgress(): number {
    return this.state.turn / this.config.maxTurns
  }

  reset(): void {
    this.state.turn = 0
    this.state.successHistory = []
    this.state.usageHistory = []
    this.state.start = 0
    this.ready = false
  }
}

class Manager {
  private controllers: Map<string, DynamicTurnController> = new Map()

  getOrCreate(id: string): DynamicTurnController {
    let ctrl = this.controllers.get(id)
    if (!ctrl) {
      ctrl = new DynamicTurnController()
      this.controllers.set(id, ctrl)
    }
    return ctrl
  }

  remove(id: string): void {
    const ctrl = this.controllers.get(id)
    if (ctrl) {
      ctrl.reset()
      this.controllers.delete(id)
    }
  }

  clear(): void {
    for (const c of this.controllers.values()) {
      c.reset()
    }
    this.controllers.clear()
  }
}

export const globalTurnControlManager = new Manager()

export function getController(id: string): DynamicTurnController {
  return globalTurnControlManager.getOrCreate(id)
}
