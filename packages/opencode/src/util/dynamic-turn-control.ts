/**
 * Dynamic Turn Control - Adjusts turn limits based on task complexity
 *
 * Implements turn-control strategies for cost optimization:
 * - Fixed turn limits (75th percentile)
 * - Dynamic adjustment based on success rate prediction
 * - Early termination for low-probability tasks
 *
 * Reference: arXiv:2510.16786 - "More with Lessons with Less: An Empirical Study of Turn-Control Strategies"
 *
 * This implementation includes:
 * - TTL-based auto-expiration for controllers
 * - LRU eviction strategy
 * - Auto-cleanup callbacks for session end
 */

import { Log } from "@/util/log"

const log = Log.create({ service: "dynamic-turn-control" })

/**
 * Configuration options for DynamicTurnController
 */
export interface Config {
  enabled: boolean
  maxTurns: number
  adaptiveThreshold: number
  budgetMultiplier: number
  enableDynamic: boolean
  minTurns: number
  earlyTermThreshold: number
}

/**
 * Default configuration
 */
export const DEFAULT_CONFIG: Config = {
  enabled: true,
  maxTurns: 30,
  adaptiveThreshold: 0.5,
  budgetMultiplier: 1.5,
  enableDynamic: true,
  minTurns: 5,
  earlyTermThreshold: 0.3,
}

/**
 * Configuration for different complexity levels
 */
interface ComplexityConfig {
  simple: number
  moderate: number
  complex: number
}

/**
 * Complexity level presets
 */
const COMPLEXITY: ComplexityConfig = {
  simple: 10,
  moderate: 20,
  complex: 35,
}

/**
 * Token usage tracking
 */
interface Usage {
  input: number
  output: number
  total: number
}

/**
 * Internal state of the controller
 */
interface State {
  turn: number
  budget: number
  successHistory: number[]
  usageHistory: Usage[]
  start: number
  complexity: "simple" | "moderate" | "complex"
  maxTurns: number
  lastAccess: number  // Timestamp for TTL tracking
}

/**
 * Result of shouldContinue check
 */
export interface Result {
  shouldContinue: boolean
  reason: string
  confidence: number
  remaining: number
}

/**
 * Complexity level type
 */
export type Complexity = "simple" | "moderate" | "complex"

/**
 * Dynamic Turn Controller
 *
 * Controls turn limits based on complexity and success rate predictions.
 * Includes TTL-based auto-expiration to prevent memory leaks.
 */
export class DynamicTurnController {
  private config: Config
  private state: State
  private ready: boolean = false

  /**
   * Create a new DynamicTurnController
   * @param cfg - Partial configuration to override defaults
   */
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
      lastAccess: Date.now(),
    }
  }

  /**
   * Initialize the controller with complexity and optional budget estimate
   * @param complexity - Task complexity level
   * @param estimated - Optional estimated token budget
   */
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
    this.state.lastAccess = Date.now()

    this.ready = true

    log.info("initialized", {
      complexity,
      maxTurns: this.state.maxTurns,
      budget: this.state.budget,
    })
  }

  /**
   * Record a turn result for tracking
   * @param success - Whether the turn was successful
   * @param usage - Optional token usage information
   */
  record(success: boolean, usage?: Usage): void {
    if (!this.ready || !this.config.enabled) return

    this.state.turn++
    this.state.lastAccess = Date.now()  // Update last access time
    this.state.successHistory.push(success ? 1 : 0)

    // Keep only last 10 success records
    if (this.state.successHistory.length > 10) {
      this.state.successHistory.shift()
    }

    if (usage) {
      this.state.usageHistory.push(usage)
      // Keep only last 20 usage records
      if (this.state.usageHistory.length > 20) {
        this.state.usageHistory.shift()
      }
    }
  }

  /**
   * Check if the controller should continue to the next turn
   * @param current - Current token usage
   * @returns Result indicating whether to continue and reasoning
   */
  shouldContinue(current: number): Result {
    // Update last access on each check
    this.state.lastAccess = Date.now()

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

  /**
   * Calculate average of an array
   */
  private average(arr: number[]): number {
    if (arr.length === 0) return 0
    return arr.reduce((a, b) => a + b, 0) / arr.length
  }

  /**
   * Calculate trend using linear regression
   */
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

  /**
   * Calculate average token usage per turn
   */
  private calculateAvgUsage(): number {
    const h = this.state.usageHistory
    if (h.length === 0) return 5000

    const total = h.reduce((s, u) => s + u.total, 0)
    return total / h.length
  }

  /**
   * Get current state with configuration
   */
  getState(): State & { config: Config } {
    return { ...this.state, config: this.config }
  }

  /**
   * Get progress as percentage (0-1)
   */
  getProgress(): number {
    return this.state.turn / this.config.maxTurns
  }

  /**
   * Get last access timestamp
   */
  getLastAccess(): number {
    return this.state.lastAccess
  }

  /**
   * Check if controller has expired based on TTL
   */
  isExpired(ttlMs: number = 3600000): boolean {  // Default 1 hour TTL
    return Date.now() - this.state.lastAccess > ttlMs
  }

  /**
   * Reset the controller to initial state
   */
  reset(): void {
    this.state.turn = 0
    this.state.successHistory = []
    this.state.usageHistory = []
    this.state.start = 0
    this.state.lastAccess = Date.now()
    this.ready = false
  }

  /**
   * Force cleanup - same as reset but logs the action
   */
  dispose(): void {
    log.debug("disposing controller", {
      turn: this.state.turn,
      complexity: this.state.complexity,
    })
    this.reset()
  }
}

/**
 * Manager for DynamicTurnController instances
 *
 * Provides TTL-based expiration and LRU eviction to prevent memory leaks.
 */
class Manager {
  private controllers: Map<string, DynamicTurnController> = new Map()
  private ttlMs: number  // Time-to-live in milliseconds
  private maxControllers: number  // Maximum number of controllers to keep
  private cleanupInterval: ReturnType<typeof setInterval> | null = null

  /**
   * Create a new Manager
   * @param ttlMs - Time-to-live for controllers (default: 1 hour)
   * @param maxControllers - Maximum number of controllers to keep (default: 100)
   */
  constructor(ttlMs: number = 3600000, maxControllers: number = 100) {
    this.ttlMs = ttlMs
    this.maxControllers = maxControllers
  }

  /**
   * Get or create a controller for the given ID
   */
  getOrCreate(id: string): DynamicTurnController {
    // Check if controller exists and is not expired
    const existing = this.controllers.get(id)
    if (existing && !existing.isExpired(this.ttlMs)) {
      return existing
    }

    // Remove expired controller if exists
    if (existing) {
      existing.dispose()
      this.controllers.delete(id)
    }

    // Evict oldest if at capacity
    if (this.controllers.size >= this.maxControllers) {
      this.evictOldest()
    }

    // Create new controller
    const ctrl = new DynamicTurnController()
    this.controllers.set(id, ctrl)

    // Start cleanup interval if not already running
    this.startCleanupInterval()

    return ctrl
  }

  /**
   * Remove a controller by ID
   */
  remove(id: string): void {
    const ctrl = this.controllers.get(id)
    if (ctrl) {
      ctrl.dispose()
      this.controllers.delete(id)
    }

    // Stop cleanup interval if no controllers left
    if (this.controllers.size === 0) {
      this.stopCleanupInterval()
    }
  }

  /**
   * Clear all controllers
   */
  clear(): void {
    for (const c of this.controllers.values()) {
      c.dispose()
    }
    this.controllers.clear()
    this.stopCleanupInterval()
  }

  /**
   * Get the number of active controllers
   */
  size(): number {
    return this.controllers.size
  }

  /**
   * Get all controller IDs
   */
  keys(): string[] {
    return Array.from(this.controllers.keys())
  }

  /**
   * Check if a controller exists and is valid
   */
  has(id: string): boolean {
    const ctrl = this.controllers.get(id)
    return ctrl !== undefined && !ctrl.isExpired(this.ttlMs)
  }

  /**
   * Get controller info for debugging
   */
  getInfo(id: string): { exists: boolean; expired: boolean; lastAccess: number } | undefined {
    const ctrl = this.controllers.get(id)
    if (!ctrl) return undefined
    return {
      exists: true,
      expired: ctrl.isExpired(this.ttlMs),
      lastAccess: ctrl.getLastAccess(),
    }
  }

  /**
   * Get all expired controller IDs
   */
  getExpired(): string[] {
    const expired: string[] = []
    for (const [id, ctrl] of this.controllers) {
      if (ctrl.isExpired(this.ttlMs)) {
        expired.push(id)
      }
    }
    return expired
  }

  /**
   * Clean up expired controllers
   * @returns Number of controllers cleaned up
   */
  cleanup(): number {
    const expired = this.getExpired()
    for (const id of expired) {
      this.remove(id)
    }

    if (expired.length > 0) {
      log.debug("cleaned up expired controllers", { count: expired.length })
    }

    return expired.length
  }

  /**
   * Evict the oldest controller (LRU eviction)
   */
  private evictOldest(): void {
    let oldestId: string | null = null
    let oldestTime = Infinity

    for (const [id, ctrl] of this.controllers) {
      const lastAccess = ctrl.getLastAccess()
      if (lastAccess < oldestTime) {
        oldestTime = lastAccess
        oldestId = id
      }
    }

    if (oldestId) {
      log.debug("evicting oldest controller", {
        id: oldestId,
        age: Date.now() - oldestTime,
      })
      this.controllers.delete(oldestId)
    }
  }

  /**
   * Start periodic cleanup interval
   */
  private startCleanupInterval(): void {
    if (this.cleanupInterval) return

    // Run cleanup every 5 minutes
    this.cleanupInterval = setInterval(() => {
      this.cleanup()
    }, 300000)

    // Allow interval to be cleaned up on process exit
    this.cleanupInterval.unref()
  }

  /**
   * Stop cleanup interval
   */
  private stopCleanupInterval(): void {
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval)
      this.cleanupInterval = null
    }
  }
}

/**
 * Global turn control manager with 1 hour TTL and max 100 controllers
 */
export const globalTurnControlManager = new Manager(3600000, 100)

/**
 * Get or create a turn controller for the given session ID
 * This is the main entry point for most use cases
 */
export function getController(id: string): DynamicTurnController {
  return globalTurnControlManager.getOrCreate(id)
}

/**
 * Remove a turn controller (call when session ends)
 */
export function removeController(id: string): void {
  globalTurnControlManager.remove(id)
}

/**
 * Clear all turn controllers
 */
export function clearAllControllers(): void {
  globalTurnControlManager.clear()
}

/**
 * Get statistics about the controller pool
 */
export function getControllerStats(): {
  totalControllers: number
  expiredControllers: number
  oldestController: number | null
  newestController: number | null
} {
  const expired = globalTurnControlManager.getExpired()
  const keys = globalTurnControlManager.keys()

  let oldest: number | null = null
  let newest: number | null = null

  for (const id of keys) {
    const info = globalTurnControlManager.getInfo(id)
    if (info) {
      if (oldest === null || info.lastAccess < oldest) {
        oldest = info.lastAccess
      }
      if (newest === null || info.lastAccess > newest) {
        newest = info.lastAccess
      }
    }
  }

  return {
    totalControllers: keys.length,
    expiredControllers: expired.length,
    oldestController: oldest,
    newestController: newest,
  }
}
