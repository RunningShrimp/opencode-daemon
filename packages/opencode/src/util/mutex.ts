/**
 * Mutex - Simple mutual exclusion lock for critical sections
 *
 * Provides a simple mutex implementation for protecting critical sections
 * from concurrent access. Unlike the existing Lock namespace which provides
 * reader-writer locks, this provides exclusive access.
 */

import { Log } from "./log"

const log = Log.create({ service: "mutex" })

/**
 * A simple mutex implementation using promise-based locking.
 * Provides mutual exclusion for critical sections.
 *
 * @example
 * ```typescript
 * const mutex = new Mutex()
 *
 * // Lock and execute
 * await mutex.run(async () => {
 *   // Only one operation can run this at a time
 *   await doWork()
 * })
 * ```
 */
export class Mutex {
  private locked = false
  private waitQueue: Array<{
    resolve: () => void
    reject: (error: Error) => void
  }> = []

  /**
   * Execute a function with mutex protection.
   * If the mutex is already locked, the function will wait until it's available.
   *
   * @param fn - The function to execute with mutex protection
   * @returns Promise resolving to the function's return value
   */
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (!this.locked) {
      this.locked = true
      try {
        return await fn()
      } finally {
        this.release()
      }
    }

    // Wait for mutex to be released
    return new Promise<T>((resolve, reject) => {
      this.waitQueue.push({ resolve, reject })
    }).then(async () => {
      this.locked = true
      try {
        return await fn()
      } finally {
        this.release()
      }
    })
  }

  /**
   * Release the mutex and notify the next waiter
   */
  private release(): void {
    if (this.waitQueue.length > 0) {
      // Use queueMicrotask to avoid synchronous recursion
      // and ensure fair scheduling
      queueMicrotask(() => {
        const next = this.waitQueue.shift()
        if (next) {
          next.resolve()
        } else {
          this.locked = false
        }
      })
    } else {
      this.locked = false
    }
  }

  /**
   * Check if the mutex is currently locked
   */
  isLocked(): boolean {
    return this.locked
  }

  /**
   * Get the number of waiting operations
   */
  getWaitCount(): number {
    return this.waitQueue.length
  }

  /**
   * Force release the mutex, rejecting all waiting operations
   * @param error - Error to reject waiting operations with
   */
  forceRelease(error: Error): void {
    // Reject all waiting operations
    while (this.waitQueue.length > 0) {
      const waiter = this.waitQueue.shift()
      if (waiter) {
        waiter.reject(error)
      }
    }
    this.locked = false
    log.warn("Mutex force released", { waiters: this.waitQueue.length })
  }
}

/**
 * Create a new Mutex instance
 */
export function createMutex(): Mutex {
  return new Mutex()
}

/**
 * Execute a function with mutex protection, creating a new mutex for each call.
 * This is useful for one-off critical sections.
 *
 * @param fn - The function to execute
 * @returns Promise resolving to the function's return value
 */
export async function withMutex<T>(fn: () => Promise<T>): Promise<T> {
  const mutex = new Mutex()
  return mutex.run(fn)
}

/**
 * A map of named mutexes for coordinating across different resources.
 * This is useful when you need different mutexes for different resources.
 *
 * @example
 * ```typescript
 * const mutexes = new NamedMutex()
 *
 * await mutexes.run('resource-a', async () => {
 *   // Only one operation can access 'resource-a' at a time
 * })
 * ```
 */
export class NamedMutex {
  private mutexes = new Map<string, Mutex>()

  /**
   * Get or create a mutex for the given key
   */
  private getMutex(key: string): Mutex {
    let mutex = this.mutexes.get(key)
    if (!mutex) {
      mutex = new Mutex()
      this.mutexes.set(key, mutex)
    }
    return mutex
  }

  /**
   * Execute a function with mutex protection for the given key
   */
  async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const mutex = this.getMutex(key)
    return mutex.run(fn)
  }

  /**
   * Check if a mutex exists for the given key
   */
  has(key: string): boolean {
    return this.mutexes.has(key)
  }

  /**
   * Check if the mutex for the given key is locked
   */
  isLocked(key: string): boolean {
    const mutex = this.mutexes.get(key)
    return mutex?.isLocked() ?? false
  }

  /**
   * Get the wait count for the mutex of the given key
   */
  getWaitCount(key: string): number {
    const mutex = this.mutexes.get(key)
    return mutex?.getWaitCount() ?? 0
  }

  /**
   * Delete a mutex and force release it
   */
  delete(key: string, error?: Error): boolean {
    const mutex = this.mutexes.get(key)
    if (mutex) {
      if (error) {
        mutex.forceRelease(error)
      }
      this.mutexes.delete(key)
      return true
    }
    return false
  }

  /**
   * Clear all mutexes
   */
  clear(error?: Error): void {
    for (const [, mutex] of this.mutexes) {
      if (error) {
        mutex.forceRelease(error)
      }
    }
    this.mutexes.clear()
  }

  /**
   * Get the number of active mutexes
   */
  size(): number {
    return this.mutexes.size
  }
}

/**
 * Global named mutex instance for application-wide resource coordination
 */
export const globalNamedMutex = new NamedMutex()

/**
 * Execute a function with global mutex protection for the given resource key
 */
export async function withGlobalMutex<T>(key: string, fn: () => Promise<T>): Promise<T> {
  return globalNamedMutex.run(key, fn)
}
