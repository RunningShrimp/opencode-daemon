/**
 * Concurrency Limiter Unit Tests
 *
 * Tests for the ConcurrencyLimiter class including:
 * - Basic concurrency limiting
 * - Queue ordering
 * - Error handling
 * - State queries
 */

import { describe, test, expect, beforeEach } from "bun:test"
import { ConcurrencyLimiter } from "../util/concurrency-limiter"

describe("ConcurrencyLimiter", () => {
  describe("construction", () => {
    test("creates limiter with valid max concurrent", () => {
      const limiter = new ConcurrencyLimiter(5)
      expect(limiter).toBeDefined()
    })

    test("throws error for zero max concurrent", () => {
      expect(() => new ConcurrencyLimiter(0)).toThrow()
    })

    test("throws error for negative max concurrent", () => {
      expect(() => new ConcurrencyLimiter(-1)).toThrow()
    })
  })

  describe("basic limiting", () => {
    test("allows operations up to limit", async () => {
      const limiter = new ConcurrencyLimiter(3)
      let activeCount = 0
      const maxActive = { value: 0 }

      const tasks = Array(3)
        .fill(0)
        .map(() =>
          limiter.run(async () => {
            activeCount++
            maxActive.value = Math.max(maxActive.value, activeCount)
            await new Promise((resolve) => setTimeout(resolve, 10))
            activeCount--
            return "done"
          }),
        )

      const results = await Promise.all(tasks)
      expect(results).toEqual(["done", "done", "done"])
      expect(maxActive.value).toBe(3)
    })

    test("queues operations beyond limit", async () => {
      const limiter = new ConcurrencyLimiter(2)
      let activeCount = 0

      const tasks = Array(5)
        .fill(0)
        .map(() =>
          limiter.run(async () => {
            activeCount++
            await new Promise((resolve) => setTimeout(resolve, 10))
            activeCount--
            return "done"
          }),
        )

      await Promise.all(tasks)
      // All should complete without exceeding limit
      expect(activeCount).toBe(0)
    })

    test("respects max concurrent limit", async () => {
      const limiter = new ConcurrencyLimiter(2)
      let activeCount = 0
      const maxActive = { value: 0 }

      const tasks = Array(10)
        .fill(0)
        .map(() =>
          limiter.run(async () => {
            activeCount++
            maxActive.value = Math.max(maxActive.value, activeCount)
            await new Promise((resolve) => setTimeout(resolve, 5))
            activeCount--
            return "done"
          }),
        )

      await Promise.all(tasks)
      expect(maxActive.value).toBe(2) // Should never exceed limit
    })
  })

  describe("queue ordering", () => {
    test("executes queued operations in FIFO order", async () => {
      const limiter = new ConcurrencyLimiter(1)
      const executionOrder: number[] = []

      const tasks = Array(5)
        .fill(0)
        .map((_, i) =>
          limiter.run(async () => {
            executionOrder.push(i)
            await new Promise((resolve) => setTimeout(resolve, 5))
            return i
          }),
        )

      await Promise.all(tasks)
      // Should execute in order
      expect(executionOrder).toEqual([0, 1, 2, 3, 4])
    })
  })

  describe("error handling", () => {
    test("propagates errors from wrapped function", async () => {
      const limiter = new ConcurrencyLimiter(1)

      await expect(
        limiter.run(async () => {
          throw new Error("test error")
        }),
      ).rejects.toThrow("test error")
    })

    test("continues processing queue after error", async () => {
      const limiter = new ConcurrencyLimiter(1)
      const results: (string | Error)[] = []

      const tasks = [
        limiter.run(async () => {
          throw new Error("error 1")
        }),
        limiter.run(async () => {
          return "success"
        }),
        limiter.run(async () => {
          return "success 2"
        }),
      ]

      for (const task of tasks) {
        try {
          results.push(await task)
        } catch (e) {
          results.push(e as Error)
        }
      }

      expect(results).toContain("success")
      expect(results).toContain("success 2")
      expect(results.some((r) => r instanceof Error)).toBe(true)
    })
  })

  describe("state queries", () => {
    test("getActiveCount returns correct count", async () => {
      const limiter = new ConcurrencyLimiter(3)

      expect(limiter.getActiveCount()).toBe(0)

      const task = limiter.run(async () => {
        expect(limiter.getActiveCount()).toBe(1)
        await new Promise((resolve) => setTimeout(resolve, 10))
        return "done"
      })

      await task
      expect(limiter.getActiveCount()).toBe(0)
    })

    test("getQueueLength returns correct count", async () => {
      const limiter = new ConcurrencyLimiter(1)

      const tasks = [
        limiter.run(async () => {
          await new Promise((resolve) => setTimeout(resolve, 50))
          return "1"
        }),
        limiter.run(async () => "2"),
        limiter.run(async () => "3"),
      ]

      // Give time for queue to fill
      await new Promise((resolve) => setTimeout(resolve, 5))

      expect(limiter.getQueueLength()).toBe(2)

      await Promise.all(tasks)
      expect(limiter.getQueueLength()).toBe(0)
    })

    test("hasPendingOperations returns correct state", async () => {
      const limiter = new ConcurrencyLimiter(1)

      expect(limiter.hasPendingOperations()).toBe(false)

      const task = limiter.run(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50))
        return "done"
      })

      await new Promise((resolve) => setTimeout(resolve, 5))
      expect(limiter.hasPendingOperations()).toBe(true)

      await task
      expect(limiter.hasPendingOperations()).toBe(false)
    })
  })

  describe("concurrent access", () => {
    test("handles many concurrent operations", async () => {
      const limiter = new ConcurrencyLimiter(10)
      let activeCount = 0
      const maxActive = { value: 0 }

      const tasks = Array(100)
        .fill(0)
        .map(() =>
          limiter.run(async () => {
            activeCount++
            maxActive.value = Math.max(maxActive.value, activeCount)
            await new Promise((resolve) => setTimeout(resolve, 1))
            activeCount--
            return Math.random()
          }),
        )

      const results = await Promise.all(tasks)
      expect(results.length).toBe(100)
      expect(maxActive.value).toBe(10) // Should not exceed limit
    })
  })
})

describe("Global Limiters", () => {
  test("globalLspLimiter exists and has correct limit", () => {
    const { globalLspLimiter } = require("../util/concurrency-limiter")
    expect(globalLspLimiter).toBeInstanceOf(ConcurrencyLimiter)
  })

  test("globalMcpLimiter exists and has correct limit", () => {
    const { globalMcpLimiter } = require("../util/concurrency-limiter")
    expect(globalMcpLimiter).toBeInstanceOf(ConcurrencyLimiter)
  })

  test("globalFileLimiter exists and has correct limit", () => {
    const { globalFileLimiter } = require("../util/concurrency-limiter")
    expect(globalFileLimiter).toBeInstanceOf(ConcurrencyLimiter)
  })
})

describe("Helper functions", () => {
  test("withLspLimit wraps function correctly", async () => {
    const { withLspLimit } = require("../util/concurrency-limiter")
    let called = false

    await withLspLimit(async () => {
      called = true
      return "result"
    })

    expect(called).toBe(true)
  })

  test("withMcpLimit wraps function correctly", async () => {
    const { withMcpLimit } = require("../util/concurrency-limiter")

    const result = await withMcpLimit(async () => "mcp result")
    expect(result).toBe("mcp result")
  })

  test("withFileLimit wraps function correctly", () => {
    const { withFileLimit } = require("../util/concurrency-limiter")

    return withFileLimit(async () => "file result").then((result) => {
      expect(result).toBe("file result")
    })
  })
})
