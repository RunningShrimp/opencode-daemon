/**
 * AsyncQueue and WorkPool Unit Tests
 *
 * Tests for thread-safe queue implementations.
 */

import { describe, test, expect } from "bun:test"
import { AsyncQueue, WorkPool, work, boundedWork } from "../util/queue"

describe("AsyncQueue", () => {
  describe("basic operations", () => {
    test("push and next work correctly", async () => {
      const queue = new AsyncQueue<string>()

      queue.push("item1")
      queue.push("item2")

      const item1 = await queue.next()
      const item2 = await queue.next()

      expect(item1).toBe("item1")
      expect(item2).toBe("item2")
    })

    test("next waits for push when queue is empty", async () => {
      const queue = new AsyncQueue<string>()

      const promise = queue.next()

      // Should not resolve immediately
      let resolved = false
      promise.then(() => {
        resolved = true
      })

      await new Promise((r) => setTimeout(r, 10))
      expect(resolved).toBe(false)

      queue.push("item")

      const item = await promise
      expect(item).toBe("item")
    })

    test("push resolves waiting next immediately", async () => {
      const queue = new AsyncQueue<string>()

      const nextPromise = queue.next()

      // Wait for next to start waiting
      await new Promise((r) => setTimeout(r, 5))

      const pushPromise = queue.push("item")

      const item = await nextPromise
      expect(item).toBe("item")

      await pushPromise
    })
  })

  describe("queue state", () => {
    test("length returns correct count", () => {
      const queue = new AsyncQueue<string>()

      expect(queue.length).toBe(0)

      queue.push("item1")
      expect(queue.length).toBe(1)

      queue.push("item2")
      expect(queue.length).toBe(2)
    })

    test("isEmpty returns correct state", () => {
      const queue = new AsyncQueue<string>()

      expect(queue.isEmpty).toBe(true)

      queue.push("item")
      expect(queue.isEmpty).toBe(false)
    })

    test("waitingConsumers returns correct count", async () => {
      const queue = new AsyncQueue<string>()

      expect(queue.waitingConsumers).toBe(0)

      const next1 = queue.next()
      await new Promise((r) => setTimeout(r, 5))
      expect(queue.waitingConsumers).toBe(1)

      const next2 = queue.next()
      await new Promise((r) => setTimeout(r, 5))
      expect(queue.waitingConsumers).toBe(2)

      queue.push("item1")
      await new Promise((r) => setTimeout(r, 5))
      expect(queue.waitingConsumers).toBe(1)

      queue.push("item2")
      await Promise.all([next1, next2])
    })
  })

  describe("tryNext", () => {
    test("returns undefined when empty", () => {
      const queue = new AsyncQueue<string>()

      expect(queue.tryNext()).toBeUndefined()
    })

    test("returns item without waiting", () => {
      const queue = new AsyncQueue<string>()

      queue.push("item")

      const item = queue.tryNext()
      expect(item).toBe("item")
    })
  })

  describe("clear", () => {
    test("clears all items", () => {
      const queue = new AsyncQueue<string>()

      queue.push("item1")
      queue.push("item2")

      const cleared = queue.clear()

      expect(cleared).toEqual(["item1", "item2"])
      expect(queue.length).toBe(0)
    })

    test("rejects waiting consumers", async () => {
      const queue = new AsyncQueue<string>()

      const next1 = queue.next()
      const next2 = queue.next()
      const next1Error = next1.then(
        () => null,
        (error) => error as Error,
      )
      const next2Error = next2.then(
        () => null,
        (error) => error as Error,
      )

      await new Promise((r) => setTimeout(r, 5))

      queue.clear()

      expect((await next1Error)?.message).toBe("Queue cleared")
      expect((await next2Error)?.message).toBe("Queue cleared")
    })
  })

  describe("drain", () => {
    test("drains queue and rejects waiters", async () => {
      const queue = new AsyncQueue<string>()

      queue.push("item1")

      const next1 = queue.next()
      const next2 = queue.next()
      const next2Error = next2.then(
        () => null,
        (error) => error as Error,
      )

      await new Promise((r) => setTimeout(r, 5))

      const drained = queue.drain(new Error("Drained"))

      expect(drained).toBe(1)
      await expect(next1).resolves.toBe("item1")
      expect((await next2Error)?.message).toBe("Drained")
    })
  })

  describe("async iterator", () => {
    test("iterates over items", async () => {
      const queue = new AsyncQueue<number>()

      const results: number[] = []

      queue.push(1)
      queue.push(2)
      queue.push(3)

      // Create iterator
      const iterator = queue[Symbol.asyncIterator]()

      results.push((await iterator.next()).value!)
      results.push((await iterator.next()).value!)
      results.push((await iterator.next()).value!)

      expect(results).toEqual([1, 2, 3])
    })
  })

  describe("concurrent access", () => {
    test("handles concurrent push and next", async () => {
      const queue = new AsyncQueue<number>()

      const pushPromises = Array(100)
        .fill(0)
        .map((_, i) => queue.push(i))

      const results: number[] = []
      for (let i = 0; i < 100; i++) {
        results.push(await queue.next())
      }

      await Promise.all(pushPromises)

      // All items should be received
      expect([...results].sort((a, b) => a - b)).toEqual(Array.from({ length: 100 }, (_, i) => i))
    })
  })
})

describe("WorkPool", () => {
  describe("basic processing", () => {
    test("processes items with concurrency", async () => {
      const pool = new WorkPool<number, number>(2, async (item) => {
        return item * 2
      })

      const results = await pool.process([1, 2, 3, 4])

      expect(results).toEqual([2, 4, 6, 8])
    })

    test("processes in order", async () => {
      const pool = new WorkPool<string, number>(2, async (item) => {
        return item.length
      })

      const results = await pool.process(["a", "ab", "abc", "abcd"])

      expect(results).toEqual([1, 2, 3, 4])
    })

    test("respects concurrency limit", async () => {
      let activeCount = 0
      let maxActive = 0

      const pool = new WorkPool<number, number>(2, async (item) => {
        activeCount++
        maxActive = Math.max(maxActive, activeCount)
        await new Promise((r) => setTimeout(r, 10))
        activeCount--
        return item
      })

      await pool.process([1, 2, 3, 4, 5, 6])

      expect(maxActive).toBe(2)
    })
  })

  describe("error handling", () => {
    test("throws on error", async () => {
      const pool = new WorkPool<number, number>(2, async (item) => {
        if (item === 3) {
          throw new Error("test error")
        }
        return item
      })

      await expect(pool.process([1, 2, 3, 4])).rejects.toThrow("test error")
    })
  })

  describe("processWithLimit", () => {
    test("limits in-flight items", async () => {
      let activeCount = 0
      let maxActive = 0

      const results = await WorkPool.processWithLimit(3, [1, 2, 3, 4, 5, 6], async (item) => {
        activeCount++
        maxActive = Math.max(maxActive, activeCount)
        await new Promise((r) => setTimeout(r, 10))
        activeCount--
        return item
      })

      expect(maxActive).toBe(3)
      expect(results).toEqual([1, 2, 3, 4, 5, 6])
    })
  })
})

describe("work function", () => {
  test("processes items with concurrency", async () => {
    let running = 0
    let maxRunning = 0

    const results = await work(3, [1, 2, 3, 4, 5, 6, 7, 8, 9, 10], async (item) => {
      running++
      maxRunning = Math.max(maxRunning, running)
      await new Promise((r) => setTimeout(r, 5))
      running--
      return item * 2
    })

    expect(maxRunning).toBe(3)
    expect(results).toEqual([2, 4, 6, 8, 10, 12, 14, 16, 18, 20])
  })

  test("handles empty array", async () => {
    const results = await work(3, [], async (item) => item)
    expect(results).toEqual([])
  })

  test("handles concurrency greater than array length", async () => {
    const results = await work(10, [1, 2, 3], async (item) => item * 2)
    expect(results).toEqual([2, 4, 6])
  })
})

describe("boundedWork function", () => {
  test("works like work function", async () => {
    const results = await boundedWork(2, [1, 2, 3], async (item) => item * 2)
    expect(results).toEqual([2, 4, 6])
  })
})
