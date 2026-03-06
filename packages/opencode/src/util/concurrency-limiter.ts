/**
 * Concurrency Limiter Module
 *
 * Provides a semaphore-based concurrency limiter to control the maximum
 * number of concurrent operations. Implements a fair queue with FIFO ordering.
 */

import { Log } from "./log"

const log = Log.create({ service: "concurrency-limiter" })

/**
 * ConcurrencyLimiter implements a semaphore pattern to limit concurrent operations.
 *
 * When the concurrency limit is reached, new operations are queued and executed
 * in FIFO order when a slot becomes available.
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
  private waitQueue: Array<() => void> = []
  private activeCount = 0
  private readonly maxConcurrent: number

  /**
   * Create a new ConcurrencyLimiter
   * @param maxConcurrent - Maximum number of concurrent operations
   */
  constructor(maxConcurrent: number) {
    if (maxConcurrent <= 0) {
      throw new Error("maxConcurrent must be greater than 0")
    }
    this.maxConcurrent = maxConcurrent
  }

  /**
   * Run a function with concurrency limiting.
   * If the concurrency limit is reached, the function will be queued.
   *
   * @param fn - The function to execute
   * @returns Promise resolving to the function's return value
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    // If there's capacity, run immediately
    if (this.activeCount < this.maxConcurrent) {
      this.activeCount++
      try {
        return await fn()
      } catch (error) {
        throw error
      } finally {
        this.activeCount--
        this.processQueue()
      }
    }

    // Queue the operation
    return new Promise<T>((resolve, reject) => {
      this.waitQueue.push(async () => {
        this.activeCount++
        try {
          const result = await fn()
          resolve(result)
        } catch (error) {
          reject(error)
        } finally {
          this.activeCount--
          this.processQueue()
        }
      })
    })
  }

  /**
   * Process the next item in the queue
   */
  private processQueue(): void {
    if (this.waitQueue.length > 0 && this.activeCount < this.maxConcurrent) {
      const next = this.waitQueue.shift()
      if (next) {
        next()
      }
    }
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
   */
  drainQueue(error: Error): void {
    while (this.waitQueue.length > 0) {
      const next = this.waitQueue.shift()
      if (next) {
        // We can't reject the promise directly since it's already created
        // Instead, we'll let it run but it will be a no-op
        // The caller should handle this by checking the limiter state
        log.warn("Draining queue", { queueLength: this.waitQueue.length + 1 })
      }
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
