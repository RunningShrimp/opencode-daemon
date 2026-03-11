const DEFAULT_IDLE_TIMEOUT = 5 * 60 * 1000
const DEFAULT_CLEANUP_INTERVAL = 60 * 1000

export interface PoolStats {
  totalSize: number
  idleCount: number
  entries: PoolEntry[]
}

export interface PoolEntry {
  key: string
  referenceCount: number
  lastUsed: number
}

export interface PoolOptions {
  idleTimeoutMs?: number
  maxSize?: number
  cleanupIntervalMs?: number
}

interface PoolEntryInternal<V> {
  value: V
  referenceCount: number
  lastUsed: number
}

export abstract class ResourcePool<V> {
  protected pool = new Map<string, PoolEntryInternal<V>>()
  protected options: Required<PoolOptions>
  protected cleanupTimer: ReturnType<typeof setInterval> | undefined
  // Track pending releases to avoid race conditions
  protected pendingReleases = new Set<string>()
  // Wait queue for when pool is full
  protected waitQueue: Array<{
    resolve: (value: V) => void
    reject: (error: Error) => void
    key: string
    args: unknown[]
  }> = []
  // Maximum number of waiting requests before rejecting
  protected maxWaitQueueSize = 100

  constructor(options: PoolOptions = {}) {
    this.options = {
      idleTimeoutMs: options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT,
      maxSize: options.maxSize ?? 100,
      cleanupIntervalMs: options.cleanupIntervalMs ?? DEFAULT_CLEANUP_INTERVAL,
    }
  }

  abstract getKey(...args: unknown[]): string
  abstract create(...args: unknown[]): Promise<V>
  abstract destroy(value: V): Promise<void>

  async acquire(...args: unknown[]): Promise<V> {
    const key = this.getKey(...args)
    let entry = this.pool.get(key)

    if (entry) {
      entry.referenceCount++
      entry.lastUsed = Date.now()
      return entry.value
    }

    if (this.pool.size >= this.options.maxSize) {
      // Try cleanup first
      await this.cleanup(0)

      // If still full, add to wait queue instead of throwing
      if (this.pool.size >= this.options.maxSize) {
        if (this.waitQueue.length >= this.maxWaitQueueSize) {
          throw new Error(`Pool wait queue full (max ${this.maxWaitQueueSize})`)
        }

        return new Promise((resolve, reject) => {
          this.waitQueue.push({ resolve, reject, key, args })
        })
      }
    }

    const value = await this.create(...args)
    entry = {
      value,
      referenceCount: 1,
      lastUsed: Date.now(),
    }
    this.pool.set(key, entry)

    return value
  }

  private processWaitQueue(): void {
    if (this.waitQueue.length === 0) return
    if (this.pool.size >= this.options.maxSize) return

    const waiting = this.waitQueue.shift()!
    this.acquire(...waiting.args)
      .then(waiting.resolve)
      .catch(waiting.reject)
  }

  release(key: string): void {
    // Prevent double-release race condition
    if (this.pendingReleases.has(key)) {
      return
    }

    const entry = this.pool.get(key)
    if (!entry) return

    // Use setImmediate to defer release and prevent synchronous race conditions
    this.pendingReleases.add(key)
    setImmediate(() => {
      try {
        if (entry.referenceCount > 0) {
          entry.referenceCount--
        }
        entry.lastUsed = Date.now()

        // Process wait queue after release
        this.processWaitQueue()
      } finally {
        this.pendingReleases.delete(key)
      }
    })
  }

  async cleanup(idleMs?: number): Promise<number> {
    const threshold = Date.now() - (idleMs ?? this.options.idleTimeoutMs)
    let cleaned = 0

    // Find entries to clean
    const toClean: Array<{ key: string; value: unknown }> = []
    for (const [key, entry] of this.pool) {
      if (entry.referenceCount === 0 && entry.lastUsed < threshold) {
        toClean.push({ key, value: entry.value })
      }
    }

    if (toClean.length === 0) return 0

    // Parallel destruction for better performance
    await Promise.all(
      toClean.map(async ({ key, value }) => {
        try {
          await this.destroy(value as V)
          this.pool.delete(key)
          cleaned++
        } catch (err) {
          // Log but continue cleanup
          console.error(`Failed to destroy pool entry: ${key}`, err)
        }
      })
    )

    return cleaned
  }

  startCleanup(): void {
    if (this.cleanupTimer) return
    if (this.options.idleTimeoutMs === Infinity) return

    this.cleanupTimer = setInterval(() => {
      this.cleanup().catch(() => {})
    }, this.options.cleanupIntervalMs)

    this.cleanupTimer.unref()
  }

  stopCleanup(): void {
    if (this.cleanupTimer) {
      clearInterval(this.cleanupTimer)
      this.cleanupTimer = undefined
    }
  }

  async dispose(): Promise<void> {
    this.stopCleanup()

    for (const [_key, entry] of this.pool) {
      try {
        await this.destroy(entry.value)
      } catch {
        // Ignore errors during shutdown
      }
    }
    this.pool.clear()
  }

  status(): PoolStats {
    const entries: PoolEntry[] = []
    let idleCount = 0

    for (const [key, entry] of this.pool) {
      entries.push({
        key,
        referenceCount: entry.referenceCount,
        lastUsed: entry.lastUsed,
      })
      if (entry.referenceCount === 0) idleCount++
    }

    return {
      totalSize: this.pool.size,
      idleCount,
      entries,
    }
  }
}

export function normalizePath(filepath: string): string {
  return filepath.replace(/\\/g, "/").replace(/\/+$/, "") || "/"
}

export function hashConfig(config: Record<string, unknown>): string {
  const str = JSON.stringify(config, Object.keys(config).sort())
  let hash = 0
  for (let i = 0; i < str.length; i++) {
    const char = str.charCodeAt(i)
    hash = (hash << 5) - hash + char
    hash = hash & hash
  }
  return Math.abs(hash).toString(36)
}
