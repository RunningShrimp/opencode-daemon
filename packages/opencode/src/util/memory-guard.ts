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

export namespace MemoryGuard {
  let config: MemoryGuardConfig = DEFAULT_CONFIG
  let intervalId: ReturnType<typeof setInterval> | undefined
  let pressureCallbacks: Array<(level: MemoryPressureLevel) => void> = []

  export function configure(newConfig: Partial<MemoryGuardConfig>): void {
    config = { ...config, ...newConfig }
  }

  export function getConfig(): MemoryGuardConfig {
    return { ...config }
  }

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

  export function onPressure(callback: (level: MemoryPressureLevel) => void): () => void {
    pressureCallbacks.push(callback)
    return () => {
      const index = pressureCallbacks.indexOf(callback)
      if (index > -1) {
        pressureCallbacks.splice(index, 1)
      }
    }
  }

  function checkMemory(): void {
    const pressure = getCurrentPressure()

    if (pressure.level !== "normal") {
      log.warn("Memory pressure detected", pressure)
    }

    globalInstanceBudget.onCleanup(async () => {
      log.info("Instance memory budget triggered cleanup")
      if (typeof global.gc === "function") {
        global.gc()
      }
    })

    for (const callback of pressureCallbacks) {
      try {
        callback(pressure)
      } catch (error) {
        log.error("Error in memory pressure callback", { error: String(error) })
      }
    }

    if (pressure.level === "critical" && pressure.heapUsedMB > config.hardLimitMB) {
      log.error("Memory hard limit exceeded", {
        heapUsedMB: pressure.heapUsedMB,
        limitMB: config.hardLimitMB,
      })

      if (typeof global.gc === "function") {
        global.gc()
      }

      setTimeout(() => {
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

  export function start(): void {
    if (intervalId) {
      log.warn("MemoryGuard already running")
      return
    }

    checkMemory()
    intervalId = setInterval(checkMemory, config.checkIntervalMs)
    intervalId.unref()
  }

  export function stop(): void {
    if (intervalId) {
      clearInterval(intervalId)
      intervalId = undefined
    }
  }

  export function forceCheck(): MemoryPressureLevel {
    checkMemory()
    return getCurrentPressure()
  }
}
