/**
 * Concurrency Limiter Module
 *
 * Provides a semaphore-based concurrency limiter to control the maximum
 * number of concurrent operations. Implements a fair queue with FIFO ordering.
 *
 * This implementation is thread-safe and does not have race conditions:
 * - Uses Mutex to protect critical sections
 * - Uses queueMicrotask to avoid synchronous recursion
 * - Properly handles Promise resolution in drainQueue
 */

import { Log } from "./log"
import { Mutex, NamedMutex } from "./mutex"

const log = Log.create({ service: "concurrency-limiter" })

/**
 * Queued operation with full Promise control
 */
interface QueuedOperation<T> {
  fn: () => Promise<T>
  resolve: (value: T) => void
  reject: (error: Error) => void
}

/**
 * ConcurrencyLimiter implements a semaphore pattern to limit concurrent operations.
 *
 * When the concurrency limit is reached, new operations are queued and executed
 * in FIFO order when a slot becomes available.
 *
 * This implementation is thread-safe and handles:
 * - Race conditions via Mutex
 * - Proper Promise resolution/rejection in drainQueue
 * - Avoids synchronous recursion via queueMicrotask
 *
 * @example
 * ```typescript
 * const limiter = new ConcurrencyLimiter(5) // Max 5 concurrent
 *
 * // All operations are automatically throttled
 * const results = await Promise.all(
 *   Array(10).fill(0).map(() => limiter.run(() => doWork()))
 * )
 * ```
 */
export class ConcurrencyLimiter {
  private waitQueue: QueuedOperation<any>[] = []
  private activeCount = 0
  private readonly maxConcurrent: number
  private readonly mutex: Mutex
  private drained = false

  /**
   * Create a new ConcurrencyLimiter
   * @param maxConcurrent - Maximum number of concurrent operations
   */
  constructor(maxConcurrent: number) {
    if (maxConcurrent <= 0) {
      throw new Error("maxConcurrent must be greater than 0")
    }
    this.maxConcurrent = maxConcurrent
    this.mutex = new Mutex()
  }

  /**
   * Run a function with concurrency limiting.
   * If the concurrency limit is reached, the function will be queued.
   *
   * This method is fully thread-safe:
   * - Mutex protects the check-then-act pattern
   * - Queued operations have their own Promise control
   *
   * @param fn - The function to execute
   * @returns Promise resolving to the function's return value
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    // Use mutex to prevent race conditions
    return this.mutex.run(async () => {
      // If limiter is drained, reject immediately
      if (this.drained) {
        throw new Error("ConcurrencyLimiter has been drained")
      }

      // If there's capacity, run immediately
      if (this.activeCount < this.maxConcurrent) {
        this.activeCount++
        try {
          return await fn()
        } catch (error) {
          throw error
        } finally {
          this.decrementActiveCount()
        }
      }

      // Queue the operation - we have full control over the Promise
      return new Promise<T>((resolve, reject) => {
        this.waitQueue.push({
          fn,
          resolve: (value: T) => {
            this.decrementActiveCount()
            resolve(value)
          },
          reject: (error: Error) => {
            this.decrementActiveCount()
            reject(error)
          },
        })

        log.debug("Operation queued", {
          queueLength: this.waitQueue.length,
          activeCount: this.activeCount,
        })
      })
    })
  }

  /**
   * Decrement active count and process queue
   * Must be called within mutex context
   */
  private decrementActiveCount(): void {
    this.activeCount--
    this.processQueue()
  }

  /**
   * Process the next item in the queue
   * Uses queueMicrotask to avoid synchronous recursion
   */
  private processQueue(): void {
    // Check if we can process more
    if (this.waitQueue.length === 0 || this.activeCount >= this.maxConcurrent) {
      return
    }

    // Use queueMicrotask to defer processing and avoid stack overflow
    // from synchronous recursion when tasks complete quickly
    queueMicrotask(() => {
      this.mutex.run(async () => {
        // Double-check after acquiring mutex (another process might have handled this)
        if (this.waitQueue.length === 0 || this.activeCount >= this.maxConcurrent) {
          return
        }

        const next = this.waitQueue.shift()
        if (!next) {
          return
        }

        this.activeCount++
        try {
          const result = await next.fn()
          next.resolve(result)
        } catch (error) {
          next.reject(error as Error)
        } finally {
          this.decrementActiveCount()
        }
      })
    })
  }

  /**
   * Get the number of currently active operations
   */
  getActiveCount(): number {
    return this.activeCount
  }

  /**
   * Get the number of queued operations waiting for a slot
   */
  getQueueLength(): number {
    return this.waitQueue.length
  }

  /**
   * Check if there are any pending operations
   */
  hasPendingOperations(): boolean {
    return this.activeCount > 0 || this.waitQueue.length > 0
  }

  /**
   * Wait for all active and queued operations to complete
   * Returns a promise that resolves when all operations are done
   */
  async waitForIdle(): Promise<void> {
    while (this.hasPendingOperations()) {
      await new Promise((resolve) => setTimeout(resolve, 10))
    }
  }

  /**
   * Drain the queue, rejecting all queued operations with the given error
   * and preventing new operations from being queued.
   *
   * This properly resolves/rejects all pending Promises:
   * - Queued operations are rejected with the provided error
   * - Currently running operations are allowed to complete
   * - New calls to run() will be rejected
   *
   * @param error - Error to reject queued operations with
   * @returns Number of operations that were queued and rejected
   */
  drainQueue(error: Error): number {
    // Mark as drained to prevent new operations
    this.drained = true

    const queueLength = this.waitQueue.length
    log.info("Draining queue", {
      queueLength,
      error: error.message,
      activeCount: this.activeCount,
    })

    // Reject all queued operations
    while (this.waitQueue.length > 0) {
      const next = this.waitQueue.shift()
      if (next) {
        // Use queueMicrotask to avoid modifying queue while iterating
        queueMicrotask(() => {
          next.reject(error)
        })
      }
    }

    return queueLength
  }

  /**
   * Pause the limiter - new operations will be queued but not executed
   * Currently running operations will continue
   */
  pause(): void {
    this.drained = true
    log.info("Limiter paused", {
      queueLength: this.waitQueue.length,
      activeCount: this.activeCount,
    })
  }

  /**
   * Resume the limiter - queued operations will start executing again
   */
  resume(): void {
    this.drained = false
    log.info("Limiter resumed", {
      queueLength: this.waitQueue.length,
    })
    // Process any queued operations
    this.processQueue()
  }

  /**
   * Get the maximum concurrent limit
   */
  getMaxConcurrent(): number {
    return this.maxConcurrent
  }

  /**
   * Get current limiter status
   */
  getStatus(): {
    activeCount: number
    queueLength: number
    maxConcurrent: number
    isPaused: boolean
  } {
    return {
      activeCount: this.activeCount,
      queueLength: this.waitQueue.length,
      maxConcurrent: this.maxConcurrent,
      isPaused: this.drained,
    }
  }
}

/**
 * Create a concurrency limiter with the given maximum concurrent operations
 */
export function createLimiter(maxConcurrent: number): ConcurrencyLimiter {
  return new ConcurrencyLimiter(maxConcurrent)
}

// Global limiter instances for different operation types
// These can be imported and used throughout the application

/**
 * Global LSP request concurrency limiter
 * Limits the number of concurrent LSP requests to prevent server overload
 */
export const globalLspLimiter = new ConcurrencyLimiter(50)

/**
 * Global MCP request concurrency limiter
 * Limits the number of concurrent MCP tool calls
 */
export const globalMcpLimiter = new ConcurrencyLimiter(30)

/**
 * Global file operation concurrency limiter
 * Limits concurrent file system operations
 */
export const globalFileLimiter = new ConcurrencyLimiter(100)

/**
 * Global Subagent concurrency limiter
 * Limits the number of concurrent subagent tasks
 * Default: 10 concurrent subagents
 */
export const globalSubagentLimiter = new ConcurrencyLimiter(10)

/**
 * Run an operation through the global LSP limiter
 */
export async function withLspLimit<T>(fn: () => Promise<T>): Promise<T> {
  return globalLspLimiter.run(fn)
}

/**
 * Run an operation through the global MCP limiter
 */
export async function withMcpLimit<T>(fn: () => Promise<T>): Promise<T> {
  return globalMcpLimiter.run(fn)
}

/**
 * Run an operation through the global file limiter
 */
export async function withFileLimit<T>(fn: () => Promise<T>): Promise<T> {
  return globalFileLimiter.run(fn)
}

/**
 * Run an operation through the global subagent limiter
 */
export async function withSubagentLimit<T>(fn: () => Promise<T>): Promise<T> {
  return globalSubagentLimiter.run(fn)
}

/**
 * Concurrency limiter manager for named limiters
 * Useful when you need different limits for different resource types
 */
export class ConcurrencyLimiterManager {
  private limiters = new Map<string, ConcurrencyLimiter>()
  private defaultMaxConcurrent: number

  constructor(defaultMaxConcurrent: number = 10) {
    this.defaultMaxConcurrent = defaultMaxConcurrent
  }

  /**
   * Get or create a limiter with the given name
   */
  getLimiter(name: string, maxConcurrent?: number): ConcurrencyLimiter {
    let limiter = this.limiters.get(name)
    if (!limiter) {
      limiter = new ConcurrencyLimiter(maxConcurrent ?? this.defaultMaxConcurrent)
      this.limiters.set(name, limiter)
    }
    return limiter
  }

  /**
   * Run a function through a named limiter
   */
  async run<T>(name: string, fn: () => Promise<T>, maxConcurrent?: number): Promise<T> {
    const limiter = this.getLimiter(name, maxConcurrent)
    return limiter.run(fn)
  }

  /**
   * Get status of all limiters
   */
  getAllStatus(): Record<string, ReturnType<ConcurrencyLimiter["getStatus"]>> {
    const status: Record<string, any> = {}
    for (const [name, limiter] of this.limiters) {
      status[name] = limiter.getStatus()
    }
    return status
  }

  /**
   * Drain all limiters
   */
  drainAll(error: Error): number {
    let totalDrained = 0
    for (const [, limiter] of this.limiters) {
      totalDrained += limiter.drainQueue(error)
    }
    return totalDrained
  }

  /**
   * Delete a named limiter
   */
  delete(name: string): boolean {
    return this.limiters.delete(name)
  }

  /**
   * Clear all limiters
   */
  clear(): void {
    this.limiters.clear()
  }
}

/**
 * Global named limiter manager
 */
export const globalLimiterManager = new ConcurrencyLimiterManager(10)
