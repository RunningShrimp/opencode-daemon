export class AsyncQueue<T> implements AsyncIterable<T> {
  private queue: T[] = []
  private resolvers: ((value: T) => void)[] = []
  private rejectors: ((error: Error) => void)[] = []

  get length(): number {
    return this.queue.length
  }

  get isEmpty(): boolean {
    return this.queue.length === 0
  }

  get waitingConsumers(): number {
    return this.resolvers.length
  }

  async push(item: T): Promise<void> {
    const resolve = this.resolvers.shift()
    if (resolve) {
      this.rejectors.shift()
      resolve(item)
    } else {
      this.queue.push(item)
    }
  }

  async next(): Promise<T> {
    if (this.queue.length > 0) {
      return Promise.resolve(this.queue.shift()!)
    }

    return new Promise<T>((resolve, reject) => {
      this.resolvers.push(resolve)
      this.rejectors.push(reject)
    })
  }

  tryNext(): T | undefined {
    if (this.queue.length > 0) {
      return this.queue.shift()
    }
    return undefined
  }

  clear(): T[] {
    const cleared = [...this.queue]
    this.queue = []

    const rejectors = [...this.rejectors]
    this.rejectors = []
    this.resolvers = []

    for (const reject of rejectors) {
      queueMicrotask(() => reject(new Error("Queue cleared")))
    }

    return cleared
  }

  drain(error: Error): number {
    const queuedCount = this.queue.length
    const waitingCount = this.resolvers.length
    const total = queuedCount + waitingCount

    this.queue = []

    const rejectors = [...this.rejectors]
    this.rejectors = []
    this.resolvers = []

    for (const reject of rejectors) {
      queueMicrotask(() => reject(error))
    }

    return total
  }

  async *[Symbol.asyncIterator](): AsyncIterator<T> {
    while (true) {
      yield await this.next()
    }
  }
}

export class WorkPool<T, R> {
  constructor(
    private concurrency: number,
    private processor: (item: T) => Promise<R>,
  ) {}

  async process(items: T[]): Promise<R[]> {
    const results: Array<{ index: number; value: R }> = []
    let index = 0

    await Promise.all(
      Array.from({ length: this.concurrency }, async () => {
        while (true) {
          const currentIndex = index++
          if (currentIndex >= items.length) return

          const result = await this.processor(items[currentIndex])
          results.push({ index: currentIndex, value: result })
        }
      }),
    )

    return results.sort((a, b) => a.index - b.index).map((r) => r.value)
  }

  static async processWithLimit<T, R>(
    concurrency: number,
    items: T[],
    processor: (item: T) => Promise<R>,
  ): Promise<R[]> {
    const pool = new WorkPool<T, R>(concurrency, processor)
    return pool.process(items)
  }
}

export async function work<T, R = T>(concurrency: number, items: T[], fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: Array<{ index: number; value: R }> = []
  let index = 0

  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (true) {
        const currentIndex = index++
        if (currentIndex >= items.length) return

        const result = await fn(items[currentIndex])
        results.push({ index: currentIndex, value: result })
      }
    }),
  )

  return results.sort((a, b) => a.index - b.index).map((r) => r.value)
}

export async function boundedWork<T, R = T>(
  concurrency: number,
  items: T[],
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: Array<{ index: number; value: R }> = []
  let index = 0

  await Promise.all(
    Array.from({ length: concurrency }, async () => {
      while (true) {
        const currentIndex = index++
        if (currentIndex >= items.length) return

        const result = await fn(items[currentIndex])
        results.push({ index: currentIndex, value: result })
      }
    }),
  )

  return results.sort((a, b) => a.index - b.index).map((r) => r.value)
}
