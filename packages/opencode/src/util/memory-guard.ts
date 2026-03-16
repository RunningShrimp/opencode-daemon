/**
 * Memory Guard Module
 *
 * Provides memory monitoring and pressure detection for the OpenCode daemon.
 * Implements a singleton pattern to prevent callback accumulation.
 */

import { Log } from "./log"
import { globalInstanceBudget } from "./instance-memory-budget"

const log = Log.create({ service: "memory-guard" })

export interface MemoryGuardConfig {
  softLimitMB: number
  hardLimitMB: number
  checkIntervalMs: number
}

export interface MemoryPressureLevel {
  level: "normal" | "warning" | "critical"
  usagePercent: number
  heapUsedMB: number
  heapTotalMB: number
}

const DEFAULT_CONFIG: MemoryGuardConfig = {
  softLimitMB: 1024,
  hardLimitMB: 2048,
  checkIntervalMs: 30000,
}

/**
 * MemoryGuard namespace provides memory monitoring and pressure detection.
 * Uses singleton pattern to ensure callbacks are registered only once.
 */
export namespace MemoryGuard {
  let config: MemoryGuardConfig = DEFAULT_CONFIG
  let intervalId: ReturnType<typeof setInterval> | undefined
  let criticalExitTimeoutId: ReturnType<typeof setTimeout> | undefined
  let pressureCallbacks: Array<(level: MemoryPressureLevel) => void> = []

  // Singleton cleanup callback reference - registered only once to prevent memory leak
  let cleanupCallback: (() => void | Promise<void>) | null = null

  /**
   * Configure memory guard settings
   */
  export function configure(newConfig: Partial<MemoryGuardConfig>): void {
    config = { ...config, ...newConfig }
  }

  /**
   * Get current configuration
   */
  export function getConfig(): MemoryGuardConfig {
    return { ...config }
  }

  /**
   * Get current memory pressure level
   */
  export function getCurrentPressure(): MemoryPressureLevel {
    const usage = process.memoryUsage()
    const heapUsedMB = Math.round(usage.heapUsed / 1024 / 1024)
    const heapTotalMB = Math.round(usage.heapTotal / 1024 / 1024)
    const usagePercent = heapTotalMB > 0 ? (heapUsedMB / heapTotalMB) * 100 : 0

    let level: MemoryPressureLevel["level"] = "normal"
    if (usagePercent > 85 || heapUsedMB > config.hardLimitMB) {
      level = "critical"
    } else if (usagePercent > 70 || heapUsedMB > config.softLimitMB) {
      level = "warning"
    }

    return { level, usagePercent, heapUsedMB, heapTotalMB }
  }

  /**
   * Register a callback for memory pressure events
   * Returns an unsubscribe function
   */
  export function onPressure(callback: (level: MemoryPressureLevel) => void): () => void {
    pressureCallbacks.push(callback)
    return () => {
      const index = pressureCallbacks.indexOf(callback)
      if (index > -1) {
        pressureCallbacks.splice(index, 1)
      }
    }
  }

  /**
   * Register cleanup callback with global instance budget
   * Uses singleton pattern to prevent callback accumulation
   */
  function registerCleanupCallback(): void {
    // Only register if not already registered
    if (cleanupCallback === null) {
      cleanupCallback = async () => {
        log.info("Instance memory budget triggered cleanup")
        if (typeof global.gc === "function") {
          global.gc()
        }
      }
      globalInstanceBudget.onCleanup(cleanupCallback)
    }
  }

  /**
   * Check memory and trigger appropriate actions
   */
  function checkMemory(): void {
    const pressure = getCurrentPressure()

    if ((pressure.level !== "critical" || pressure.heapUsedMB <= config.hardLimitMB) && criticalExitTimeoutId) {
      clearTimeout(criticalExitTimeoutId)
      criticalExitTimeoutId = undefined
    }

    if (pressure.level !== "normal") {
      log.warn("Memory pressure detected", pressure)
    }

    // Register cleanup callback once (singleton pattern)
    registerCleanupCallback()

    // Notify all pressure callbacks
    for (const callback of pressureCallbacks) {
      try {
        callback(pressure)
      } catch (error) {
        log.error("Error in memory pressure callback", { error: String(error) })
      }
    }

    // Handle critical memory situation
    if (pressure.level === "critical" && pressure.heapUsedMB > config.hardLimitMB) {
      log.error("Memory hard limit exceeded", {
        heapUsedMB: pressure.heapUsedMB,
        limitMB: config.hardLimitMB,
      })

      if (typeof global.gc === "function") {
        global.gc()
      }

      if (!criticalExitTimeoutId) {
        criticalExitTimeoutId = setTimeout(() => {
          criticalExitTimeoutId = undefined
          const afterGC = getCurrentPressure()
          if (afterGC.heapUsedMB > config.hardLimitMB) {
            log.error("Memory still critical after GC", {
              heapUsedMB: afterGC.heapUsedMB,
            })
            process.exit(1)
          }
        }, 1000)
      }
    }
  }

  /**
   * Start memory monitoring
   */
  export function start(): void {
    if (intervalId) {
      log.warn("MemoryGuard already running")
      return
    }

    checkMemory()
    intervalId = setInterval(checkMemory, config.checkIntervalMs)
    intervalId.unref()
  }

  /**
   * Stop memory monitoring
   */
  export function stop(): void {
    if (intervalId) {
      clearInterval(intervalId)
      intervalId = undefined
    }

    if (criticalExitTimeoutId) {
      clearTimeout(criticalExitTimeoutId)
      criticalExitTimeoutId = undefined
    }
  }

  /**
   * Force an immediate memory check
   */
  export function forceCheck(): MemoryPressureLevel {
    checkMemory()
    return getCurrentPressure()
  }

  /**
   * Reset the singleton cleanup callback (for testing purposes)
   */
  export function __resetForTesting(): void {
    stop()
    config = DEFAULT_CONFIG
    pressureCallbacks = []
    cleanupCallback = null
  }

  /**
   * Get the current cleanup callback state (for testing purposes)
   */
  export function __getCleanupCallbackState(): boolean {
    return cleanupCallback !== null
  }
}
