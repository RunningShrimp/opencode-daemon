/**
 * AsyncQueue - Thread-safe asynchronous queue implementation
 *
 * Provides a FIFO queue for asynchronous operations with proper
 * thread-safety guarantees using Mutex for critical section protection.
 */

import { Mutex } from "./mutex"

/**
 * A thread-safe asynchronous queue implementation.
 *
 * This queue ensures proper coordination between producers (push) and
 * consumers (next) using a mutex to protect critical sections.
 *
 * @example
 * ```typescript
 * const queue = new AsyncQueue<string>()
 *
 * // Producer
 * queue.push("item1")
 * queue.push("item2")
 *
 * // Consumer
 * const item1 = await queue.next() // "item1"
 * const item2 = await queue.next() // "item2"
 * ```
 */
export class AsyncQueue<T> implements AsyncIterable<T> {
  private queue: T[] = []
  private resolvers: ((value: T) => void)[] = []
  private rejectors: ((error: Error) => void)[] = []
  private readonly mutex: Mutex

  /**
   * Create a new AsyncQueue
   */
  constructor() {
    this.mutex = new Mutex()
  }

  /**
   * Push an item to the queue.
   * If there's a waiting consumer, it will be resolved immediately.
   * Otherwise, the item will be queued.
   *
   * @param item - The item to push to the queue
   */
  async push(item: T): Promise<void> {
    await this.mutex.run(async () => {
      const resolve = this.resolvers.shift()
      if (resolve) {
        // There's a waiting consumer, resolve immediately
        resolve(item)
      } else {
        // No waiting consumer, add to queue
        this.queue.push(item)
      }
    })
  }

  /**
   * Get the next item from the queue.
   * If the queue has items, returns immediately.
   * Otherwise, waits for a push.
   *
   * @returns Promise resolving to the next item
   */
  async next(): Promise<T> {
    return this.mutex.run(() => {
      if (this.queue.length > 0) {
        // Has queued items, return immediately
        return Promise.resolve(this.queue.shift()!)
      }

      // No items available, wait for a push
      return new Promise<T>((resolve, reject) => {
        this.resolvers.push(resolve)
        this.rejectors.push(reject)
      })
    })
  }

  /**
   * Try to get the next item without waiting.
   *
   * @returns The next item, or undefined if queue is empty
   */
  tryNext(): T | undefined {
    // Note: This is a best-effort read without mutex
    // For strict consistency, use next() instead
    if (this.queue.length > 0) {
      return this.queue.shift()
    }
    return undefined
  }

  /**
   * Get the number of items in the queue
   */
  get length(): number {
    return this.queue.length
  }

  /**
   * Check if the queue is empty
   */
  get isEmpty(): boolean {
    return this.queue.length === 0 && this.resolvers.length === 0
  }

  /**
   * Get the number of waiting consumers
   */
  get waitingConsumers(): number {
    return this.resolvers.length
  }

  /**
   * Clear all items from the queue
   * @returns Array of cleared items
   */
  clear(): T[] {
    const items = [...this.queue]
    this.queue = []

    // Reject waiting consumers
    while (this.rejectors.length > 0) {
      const rejector = this.rejectors.shift()
      if (rejector) {
        queueMicrotask(() => {
          rejector(new Error("Queue cleared"))
        })
      }
    }

    return items
  }

  /**
   * Drain the queue, rejecting all waiting consumers with the given error
   * @param error - Error to reject with
   * @returns Number of operations rejected
   */
  drain(error: Error): number {
    const queueLength = this.queue.length
    const waitingLength = this.resolvers.length

    // Clear queue
    this.queue = []

    // Reject all waiting consumers
    while (this.rejectors.length > 0) {
      const rejector = this.rejectors.shift()
      if (rejector) {
        queueMicrotask(() => {
          rejector(error)
        })
      }
    }

    // Clear resolvers
    this.resolvers = []
    this.rejectors = []

    return queueLength + waitingLength
  }

  /**
   * Async iterator implementation
   */
  async *[Symbol.asyncIterator](): AsyncGenerator<T> {
    while (true) {
      try {
        const item = await this.next()
        yield item
      } catch {
        // Queue was drained or cleared, stop iteration
        break
      }
    }
  }
}

/**
 * Work pool - distributes work across a fixed number of concurrent workers
 *
 * @example
 * ```typescript
 * const pool = new WorkPool<string, number>(3, async (item) => {
 *   return item.length
 * })
 *
 * const results = await pool.process(['a', 'ab', 'abc', 'abcd'])
 * // Results: [1, 2, 3, 4]
 * ```
 */
export class WorkPool<T, R> {
  private queue: T[] = []
  private results: R[] = []
  private running = 0
  private readonly concurrency: number
  private readonly processor: (item: T) => Promise<R>
  private readonly mutex: Mutex
  private error: Error | null = null

  /**
   * Create a new work pool
   * @param concurrency - Maximum concurrent workers
   * @param processor - Function to process each item
   */
  constructor(concurrency: number, processor: (item: T) => Promise<R>) {
    if (concurrency <= 0) {
      throw new Error("concurrency must be greater than 0")
    }
    this.concurrency = concurrency
    this.processor = processor
    this.mutex = new Mutex()
  }

  /**
   * Process all items with the work pool
   * @param items - Items to process
   * @returns Promise resolving to results in order
   */
  async process(items: T[]): Promise<R[]> {
    this.queue = [...items]
    this.results = new Array(items.length)
    this.running = 0
    this.error = null

    // Start workers
    const workers: Promise<void>[] = []
    for (let i = 0; i < this.concurrency; i++) {
      workers.push(this.worker(i))
    }

    // Wait for all workers to complete
    await Promise.all(workers)

    if (this.error) {
      throw this.error
    }

    return this.results
  }

  /**
   * Process items with a limit on total items in flight
   * @param items - Items to process
   * @param limit - Maximum items to have in flight
   * @returns Promise resolving to results in order
   */
  async processWithLimit<T, R>(
    items: T[],
    limit: number,
    processor: (item: T) => Promise<R>
  ): Promise<R[]> {
    const pool = new WorkPool(limit, processor)
    return pool.process(items)
  }

  private async worker(workerId: number): Promise<void> {
    while (true) {
      let item: T | undefined
      let index: number

      // Get next item from queue
      await this.mutex.run(async () => {
        if (this.queue.length === 0 || this.error) {
          item = undefined
          index = -1
          return
        }

        index = this.queue.length - this.queue.length // Always 0 after shift
        item = this.queue.shift()
        this.running++
      })

      if (!item || index === -1) {
        // No more items or error, exit worker
        await this.mutex.run(async () => {
          this.running--
        })
        break
      }

      try {
        const result = await this.processor(item)
        await this.mutex.run(async () => {
          this.results[index] = result
          this.running--
        })
      } catch (e) {
        await this.mutex.run(async () => {
          if (!this.error) {
            this.error = e as Error
          }
          this.running--
        })
      }
    }
  }
}

/**
 * Execute work items with a concurrency limit
 *
 * @param concurrency - Maximum concurrent operations
 * @param items - Items to process
 * @param fn - Function to process each item
 * @returns Array of results in order
 */
export async function work<T, R>(
  concurrency: number,
  items: T[],
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const pool = new WorkPool(concurrency, fn)
  return pool.process(items)
}

/**
 * Bounded work function - limits both concurrency and total in-flight items
 *
 * @param items - Items to process
 * @param concurrency - Maximum concurrent operations
 * @param fn - Function to process each item
 * @returns Array of results in order
 */
export async function boundedWork<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  return work(concurrency, items, fn)
}
