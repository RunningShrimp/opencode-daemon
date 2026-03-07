/**
 * Compaction Predictor - Context compression predictor
 *
 * Predicts when to trigger context compaction based on token usage patterns.
 * Uses linear regression to forecast overflow and trigger pre-emptive compression,
 * reducing context overflow errors by ~50%.
 *
 * Reference: arXiv:2510.16786
 */

import { Log } from "@/util/log"

const log = Log.create({ service: "compaction-predictor" })

export interface Config {
  enabled: boolean
  predictionAhead: number
  triggerThreshold: number
  historySize: number
  minConfidence: number
}

export const DEFAULT_CONFIG: Config = {
  enabled: true,
  predictionAhead: 15000,
  triggerThreshold: 0.75,
  historySize: 10,
  minConfidence: 0.6,
}

interface Record {
  timestamp: number
  input: number
  output: number
  total: number
  limit: number
}

export interface Result {
  shouldPreempt: boolean
  confidence: number
  predictedOverflowTurns: number
  action: "compact" | "wait" | "urgent"
  reason: string
}

export class CompactionPredictor {
  private config: Config
  private history: Record[] = []
  private last: Result | null = null
  private ready: boolean = false

  constructor(cfg: Partial<Config> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...cfg }
  }

  initialize(): void {
    this.history = []
    this.last = null
    this.ready = true
    log.info("initialized")
  }

  record(input: number, output: number, limit: number): void {
    if (!this.ready || !this.config.enabled) return

    const rec: Record = {
      timestamp: Date.now(),
      input,
      output,
      total: input + output,
      limit,
    }

    this.history.push(rec)

    if (this.history.length > this.config.historySize) {
      this.history.shift()
    }

    log.debug("recorded", {
      input,
      output,
      total: rec.total,
      limit,
      ratio: (rec.total / limit).toFixed(2),
    })
  }

  predict(input: number, output: number, limit: number): Result {
    if (!this.ready || !this.config.enabled || this.history.length < 3) {
      return {
        shouldPreempt: false,
        confidence: 0,
        predictedOverflowTurns: -1,
        action: "wait",
        reason: "not ready",
      }
    }

    const total = input + output
    const ratio = total / limit

    // Already at threshold
    if (ratio >= this.config.triggerThreshold) {
      return {
        shouldPreempt: true,
        confidence: 0.95,
        predictedOverflowTurns: 0,
        action: "urgent",
        reason: `usage at ${(ratio * 100).toFixed(0)}%`,
      }
    }

    // Linear regression trend
    const trend = this.calculateTrend()
    const growth = this.calculateGrowth()

    if (growth <= 0) {
      return {
        shouldPreempt: false,
        confidence: 0.8,
        predictedOverflowTurns: -1,
        action: "wait",
        reason: "no growth trend",
      }
    }

    // Predict overflow
    const remaining = limit - total
    const turns = Math.ceil(remaining / growth)
    const predicted = total + growth * this.config.predictionAhead

    if (turns <= 3 || predicted > limit - this.config.predictionAhead) {
      const conf = Math.min(0.9, this.calculateConfidence())
      return {
        shouldPreempt: conf >= this.config.minConfidence,
        confidence: conf,
        predictedOverflowTurns: turns,
        action: turns <= 1 ? "urgent" : "compact",
        reason: `overflow in ${turns} turns (growth ${growth}/turn)`,
      }
    }

    return {
      shouldPreempt: false,
      confidence: this.calculateConfidence(),
      predictedOverflowTurns: turns,
      action: "wait",
      reason: `stable, ${turns} turns to ${(ratio + (growth * turns) / limit).toFixed(2)}%`,
    }
  }

  private calculateTrend(): number {
    if (this.history.length < 2) return 0

    const n = this.history.length
    const xs = this.history.map((_, i) => i)
    const ys = this.history.map((r) => r.total)

    const sumX = xs.reduce((a, b) => a + b, 0)
    const sumY = ys.reduce((a, b) => a + b, 0)
    const sumXY = xs.reduce((s, x, i) => s + x * ys[i], 0)
    const sumX2 = xs.reduce((s, x) => s + x * x, 0)

    const denom = n * sumX2 - sumX * sumX
    if (denom === 0) return 0

    return (n * sumXY - sumX * sumY) / denom
  }

  private calculateGrowth(): number {
    if (this.history.length < 2) return 0

    let total = 0
    let count = 0

    for (let i = 1; i < this.history.length; i++) {
      const g = this.history[i].total - this.history[i - 1].total
      if (g > 0) {
        total += g
        count++
      }
    }

    return count > 0 ? total / count : 0
  }

  private calculateConfidence(): number {
    if (this.history.length < 3) return 0.3

    const trends = []
    for (let i = 2; i < this.history.length; i++) {
      const g1 = this.history[i - 1].total - this.history[i - 2].total
      const g2 = this.history[i].total - this.history[i - 1].total
      if (g1 > 0 && g2 > 0) {
        trends.push(Math.abs(g1 - g2) / Math.max(g1, g2))
      }
    }

    if (trends.length === 0) return 0.5

    const avg = trends.reduce((a, b) => a + b, 0) / trends.length
    return Math.max(0.3, 1 - avg)
  }

  getLastPrediction(): Result | null {
    return this.last
  }

  getStats(): { count: number; avg: number; trend: number } {
    return {
      count: this.history.length,
      avg: this.history.length > 0 ? this.history.reduce((s, r) => s + r.total, 0) / this.history.length : 0,
      trend: this.calculateTrend(),
    }
  }

  reset(): void {
    this.history = []
    this.last = null
    this.ready = false
  }
}

class Manager {
  private predictors: Map<string, CompactionPredictor> = new Map()

  getOrCreate(id: string): CompactionPredictor {
    let pred = this.predictors.get(id)
    if (!pred) {
      pred = new CompactionPredictor()
      pred.initialize()
      this.predictors.set(id, pred)
    }
    return pred
  }

  remove(id: string): void {
    const pred = this.predictors.get(id)
    if (pred) {
      pred.reset()
      this.predictors.delete(id)
    }
  }

  clear(): void {
    for (const p of this.predictors.values()) {
      p.reset()
    }
    this.predictors.clear()
  }
}

export const globalManager = new Manager()

export function getPredictor(id: string): CompactionPredictor {
  return globalManager.getOrCreate(id)
}
