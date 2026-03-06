import { Log } from "@/util/log"

const log = Log.create({ service: "instance-memory-budget" })

export interface InstanceMemoryBudgetConfig {
  maxMemory: number
  warningThreshold: number
  criticalThreshold: number
  autoCleanup: boolean
  cleanupPercentage: number
}

const DEFAULT_CONFIG: InstanceMemoryBudgetConfig = {
  maxMemory: 512 * 1024 * 1024,
  warningThreshold: 0.7,
  criticalThreshold: 0.9,
  autoCleanup: true,
  cleanupPercentage: 0.5,
}

interface MemoryEntry {
  id: string
  size: number
  timestamp: number
}

export class InstanceMemoryBudget {
  private cfg: InstanceMemoryBudgetConfig
  private used = 0
  private entries = new Map<string, MemoryEntry>()
  private cleanupCallbacks: (() => void | Promise<void>)[] = []
  private cleaningUp = false
  private opPromise: Promise<void> = Promise.resolve()

  constructor(cfg: Partial<InstanceMemoryBudgetConfig> = {}) {
    this.cfg = { ...DEFAULT_CONFIG, ...cfg }
  }

  async acquire(id: string, size: number): Promise<boolean> {
    await this.opPromise

    return new Promise((resolve) => {
      if (this.used + size > this.cfg.maxMemory) {
        log.warn("Memory budget exceeded", {
          id,
          requested: size,
          used: this.used,
          max: this.cfg.maxMemory,
        })

        if (this.cfg.autoCleanup) {
          this.triggerCleanup().then(() => {
            if (this.used + size > this.cfg.maxMemory) {
              resolve(false)
            } else {
              this.doAcquire(id, size)
              resolve(true)
            }
          })
        } else {
          resolve(false)
        }
        return
      }

      this.doAcquire(id, size)
      resolve(true)

      this.opPromise = new Promise((res) => {
        queueMicrotask(res)
      })
    })
  }

  private doAcquire(id: string, size: number): void {
    const existing = this.entries.get(id)
    if (existing) {
      this.used -= existing.size
    }

    const entry: MemoryEntry = {
      id,
      size,
      timestamp: Date.now(),
    }

    this.entries.set(id, entry)
    this.used += size

    this.checkThresholds()
  }

  release(id: string): boolean {
    const entry = this.entries.get(id)
    if (!entry) {
      return false
    }

    this.used -= entry.size
    this.entries.delete(id)

    return true
  }

  private checkThresholds(): void {
    const ratio = this.used / this.cfg.maxMemory

    if (ratio >= this.cfg.criticalThreshold) {
      log.warn("Memory budget critical", {
        used: this.used,
        max: this.cfg.maxMemory,
        ratio,
      })

      if (this.cfg.autoCleanup) {
        this.triggerCleanup()
      }
    } else if (ratio >= this.cfg.warningThreshold) {
      log.warn("Memory budget warning", {
        used: this.used,
        max: this.cfg.maxMemory,
        ratio,
      })
    }
  }

  async triggerCleanup(): Promise<void> {
    if (this.cleaningUp) {
      return
    }

    this.cleaningUp = true

    let attempt = 0
    const maxAttempts = 3
    const baseDelay = 100

    while (attempt < maxAttempts) {
      try {
        await this.doCleanup()
        break
      } catch (error) {
        attempt++
        if (attempt >= maxAttempts) {
          log.error("Cleanup failed after max attempts", { error })
          break
        }

        const delay = baseDelay * Math.pow(2, attempt)
        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }

    this.cleaningUp = false
  }

  private async doCleanup(): Promise<void> {
    const targetCleanup = this.cfg.maxMemory * this.cfg.cleanupPercentage
    let cleaned = 0

    const sortedEntries = Array.from(this.entries.values()).sort((a, b) => a.timestamp - b.timestamp)

    for (const entry of sortedEntries) {
      if (cleaned >= targetCleanup) {
        break
      }

      this.release(entry.id)
      cleaned += entry.size
    }

    for (const cb of this.cleanupCallbacks) {
      try {
        await cb()
      } catch (error) {
        log.error("Cleanup callback error", { error })
      }
    }

    log.info("Memory cleanup completed", { cleaned, remaining: this.used })
  }

  onCleanup(cb: () => void | Promise<void>): void {
    this.cleanupCallbacks.push(cb)
  }

  getUsage(): {
    used: number
    max: number
    ratio: number
    entryCount: number
  } {
    return {
      used: this.used,
      max: this.cfg.maxMemory,
      ratio: this.used / this.cfg.maxMemory,
      entryCount: this.entries.size,
    }
  }

  reset(): void {
    this.used = 0
    this.entries.clear()
    this.cleaningUp = false
  }

  destroy(): void {
    this.reset()
    this.cleanupCallbacks = []
  }
}

class InstanceMemoryBudgetManager {
  private budgets = new Map<string, InstanceMemoryBudget>()

  getOrCreate(id: string): InstanceMemoryBudget {
    let budget = this.budgets.get(id)
    if (!budget) {
      budget = new InstanceMemoryBudget()
      this.budgets.set(id, budget)
    }
    return budget
  }

  remove(id: string): void {
    const budget = this.budgets.get(id)
    if (budget) {
      budget.destroy()
      this.budgets.delete(id)
    }
  }

  clear(): void {
    for (const b of this.budgets.values()) {
      b.destroy()
    }
    this.budgets.clear()
  }
}

export const globalManager = new InstanceMemoryBudgetManager()

export function getBudget(id: string): InstanceMemoryBudget {
  return globalManager.getOrCreate(id)
}

export const globalInstanceBudget = new InstanceMemoryBudget()
