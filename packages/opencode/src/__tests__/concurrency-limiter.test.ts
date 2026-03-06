/**
 * Concurrency Limiter Unit Tests
 *
 * Tests for the ConcurrencyLimiter class including:
 * - Basic concurrency limiting
 * - Queue ordering
 * - Error handling
 * - State queries
 * - Race condition tests
 * - Drain queue tests
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

    test("throws error for non-numeric max concurrent", () => {
      expect(() => new ConcurrencyLimiter(NaN)).toThrow()
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

    test("getMaxConcurrent returns correct value", () => {
      const limiter = new ConcurrencyLimiter(7)
      expect(limiter.getMaxConcurrent()).toBe(7)
    })

    test("getStatus returns complete status", () => {
      const limiter = new ConcurrencyLimiter(5)
      const status = limiter.getStatus()

      expect(status).toEqual({
        activeCount: 0,
        queueLength: 0,
        maxConcurrent: 5,
        isPaused: false,
      })
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

    test("handles rapid concurrent submissions", async () => {
      const limiter = new ConcurrencyLimiter(2)
      let activeCount = 0
      const maxActive = { value: 0 }

      // Submit 50 operations as fast as possible
      const promises = Array(50)
        .fill(0)
        .map(() =>
          limiter.run(async () => {
            activeCount++
            maxActive.value = Math.max(maxActive.value, activeCount)
            await new Promise((resolve) => setTimeout(resolve, 1))
            activeCount--
            return "done"
          }),
        )

      await Promise.all(promises)
      expect(maxActive.value).toBe(2)
    })
  })

  describe("race condition stress tests", () => {
    test("handles 1000 concurrent operations without exceeding limit", async () => {
      const limiter = new ConcurrencyLimiter(20)
      let activeCount = 0
      const maxActive = { value: 0 }

      const tasks = Array(1000)
        .fill(0)
        .map(() =>
          limiter.run(async () => {
            activeCount++
            maxActive.value = Math.max(maxActive.value, activeCount)
            await new Promise((resolve) => setTimeout(resolve, Math.random() * 5))
            activeCount--
            return "done"
          }),
        )

      const results = await Promise.all(tasks)
      expect(results.length).toBe(1000)
      expect(maxActive.value).toBe(20)
    })

    test("no race condition with simultaneous submissions", async () => {
      const limiter = new ConcurrencyLimiter(3)
      let activeCount = 0
      const maxActive = { value: 0 }

      // All operations start at exactly the same time
      const promises = Array(50).fill(0).map(() =>
        Promise.resolve().then(() =>
          limiter.run(async () => {
            activeCount++
            maxActive.value = Math.max(maxActive.value, activeCount)
            await new Promise((resolve) => setTimeout(resolve, 2))
            activeCount--
            return "done"
          })
        )
      )

      await Promise.all(promises)
      expect(maxActive.value).toBe(3) // Should never exceed 3
    })
  })

  describe("drain queue", () => {
    test("drainQueue rejects all queued operations", async () => {
      const limiter = new ConcurrencyLimiter(1)

      // Start one operation
      const running = limiter.run(async () => {
        await new Promise((resolve) => setTimeout(resolve, 50))
        return "running"
      })

      // Queue several operations
      const queued = [
        limiter.run(async () => "1"),
        limiter.run(async () => "2"),
        limiter.run(async () => "3"),
      ]

      // Give time for operations to be queued
      await new Promise((resolve) => setTimeout(resolve, 5))

      // Drain the queue
      const drainError = new Error("Queue drained")
      const drained = limiter.drainQueue(drainError)

      expect(drained).toBe(3) // 3 operations were queued

      // Queued operations should be rejected
      const results = await Promise.allSettled(queued)
      expect(results[0].status).toBe("rejected")
      expect(results[1].status).toBe("rejected")
      expect(results[2].status).toBe("rejected")

      // Running operation should complete
      expect(await running).toBe("running")
    })

    test("run throws after drainQueue", async () => {
      const limiter = new ConcurrencyLimiter(5)

      limiter.drainQueue(new Error("Drained"))

      await expect(limiter.run(async () => "test")).rejects.toThrow(
        "ConcurrencyLimiter has been drained"
      )
    })

    test("drainQueue returns correct count", async () => {
      const limiter = new ConcurrencyLimiter(1)

      // Queue 10 operations (limit is 1)
      const tasks = Array(10).fill(0).map(() =>
        limiter.run(async () => {
          await new Promise((resolve) => setTimeout(resolve, 10))
          return "done"
        })
      )

      await new Promise((resolve) => setTimeout(resolve, 5))

      const drained = limiter.drainQueue(new Error("Test"))

      expect(drained).toBe(9) // 1 running + 9 queued = 10 total, but running continues

      await Promise.all(tasks)
    })

    test("multiple drainQueue calls don't cause issues", async () => {
      const limiter = new ConcurrencyLimiter(2)

      const tasks = [
        limiter.run(async () => "1"),
        limiter.run(async () => "2"),
        limiter.run(async () => "3"),
      ]

      await new Promise((resolve) => setTimeout(resolve, 5))

      limiter.drainQueue(new Error("First drain"))
      const secondDrain = limiter.drainQueue(new Error("Second drain"))

      expect(secondDrain).toBe(0) // Already drained

      await Promise.allSettled(tasks)
    })
  })

  describe("pause and resume", () => {
    test("pause prevents new executions but allows running to complete", async () => {
      const limiter = new ConcurrencyLimiter(2)

      const running = limiter.run(async () => {
        await new Promise((resolve) => setTimeout(resolve, 20))
        return "running"
      })

      await new Promise((resolve) => setTimeout(resolve, 5))

      limiter.pause()

      const queued = limiter.run(async () => "queued")

      // Give time for queue
      await new Promise((resolve) => setTimeout(resolve, 5))

      expect(limiter.getStatus().isPaused).toBe(true)
      expect(limiter.getQueueLength()).toBe(1)

      // Resume should process queue
      limiter.resume()

      expect(await running).toBe("running")
      expect(await queued).toBe("queued")
    })

    test("resume processes queued operations", async () => {
      const limiter = new ConcurrencyLimiter(1)

      limiter.pause()

      const task = limiter.run(async () => "done")

      await new Promise((resolve) => setTimeout(resolve, 5))

      expect(limiter.getQueueLength()).toBe(1)

      limiter.resume()

      expect(await task).toBe("done")
    })
  })

  describe("waitForIdle", () => {
    test("waits for all operations to complete", async () => {
      const limiter = new ConcurrencyLimiter(2)

      const tasks = Array(5).fill(0).map(() =>
        limiter.run(async () => {
          await new Promise((resolve) => setTimeout(resolve, 20))
          return "done"
        })
      )

      await limiter.waitForIdle()

      expect(limiter.hasPendingOperations()).toBe(false)
      expect(await Promise.all(tasks)).toHaveLength(5)
    })

    test("returns immediately when idle", async () => {
      const limiter = new ConcurrencyLimiter(5)

      await limiter.waitForIdle()

      expect(true).toBe(true)
    })
  })
})

describe("Global Limiters", () => {
  test("globalLspLimiter exists and has correct limit", () => {
    const { globalLspLimiter } = require("../util/concurrency-limiter")
    expect(globalLspLimiter).toBeInstanceOf(ConcurrencyLimiter)
    expect(globalLspLimiter.getMaxConcurrent()).toBe(50)
  })

  test("globalMcpLimiter exists and has correct limit", () => {
    const { globalMcpLimiter } = require("../util/concurrency-limiter")
    expect(globalMcpLimiter).toBeInstanceOf(ConcurrencyLimiter)
    expect(globalMcpLimiter.getMaxConcurrent()).toBe(30)
  })

  test("globalFileLimiter exists and has correct limit", () => {
    const { globalFileLimiter } = require("../util/concurrency-limiter")
    expect(globalFileLimiter).toBeInstanceOf(ConcurrencyLimiter)
    expect(globalFileLimiter.getMaxConcurrent()).toBe(100)
  })

  test("globalSubagentLimiter exists and has correct limit", () => {
    const { globalSubagentLimiter } = require("../util/concurrency-limiter")
    expect(globalSubagentLimiter).toBeInstanceOf(ConcurrencyLimiter)
    expect(globalSubagentLimiter.getMaxConcurrent()).toBe(10)
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

  test("withSubagentLimit wraps function correctly", () => {
    const { withSubagentLimit } = require("../util/concurrency-limiter")

    return withSubagentLimit(async () => "subagent result").then((result) => {
      expect(result).toBe("subagent result")
    })
  })
})

describe("ConcurrencyLimiterManager", () => {
  test("creates and manages named limiters", async () => {
    const { ConcurrencyLimiterManager } = require("../util/concurrency-limiter")
    const manager = new ConcurrencyLimiterManager(5)

    const limiter1 = manager.getLimiter("test1", 3)
    const limiter2 = manager.getLimiter("test2")

    expect(limiter1.getMaxConcurrent()).toBe(3)
    expect(limiter2.getMaxConcurrent()).toBe(5)
  })

  test("runs function through named limiter", async () => {
    const { ConcurrencyLimiterManager } = require("../util/concurrency-limiter")
    const manager = new ConcurrencyLimiterManager(2)

    const result = await manager.run("test", async () => "result")
    expect(result).toBe("result")
  })

  test("gets status of all limiters", async () => {
    const { ConcurrencyLimiterManager } = require("../util/concurrency-limiter")
    const manager = new ConcurrencyLimiterManager(2)

    await manager.run("limiter1", async () => "a")
    await manager.run("limiter2", async () => "b")

    const status = manager.getAllStatus()
    expect(Object.keys(status)).toContain("limiter1")
    expect(Object.keys(status)).toContain("limiter2")
  })

  test("drains all limiters", async () => {
    const { ConcurrencyLimiterManager } = require("../util/concurrency-limiter")
    const manager = new ConcurrencyLimiterManager(1)

    manager.run("limiter1", async () => {
      await new Promise((r) => setTimeout(r, 100))
      return "a"
    })

    manager.run("limiter2", async () => {
      await new Promise((r) => setTimeout(r, 100))
      return "b"
    })

    await new Promise((r) => setTimeout(r, 10))

    const total = manager.drainAll(new Error("drain"))
    expect(total).toBeGreaterThan(0)
  })
})
