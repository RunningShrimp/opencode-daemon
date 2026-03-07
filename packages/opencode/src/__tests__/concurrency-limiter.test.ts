/**
 * Concurrency Limiter Unit Tests
 *
 * Tests for the ConcurrencyLimiter class including:
 * - Basic concurrency limiting
 * - Queue ordering
 * - Error handling
 * - State queries
 * - Drain queue tests
 */

import { describe, test, expect } from "bun:test"
import {
  ConcurrencyLimiter,
  globalLspLimiter,
  globalMcpLimiter,
  globalFileLimiter,
  globalSubagentLimiter,
  withLspLimit,
  withMcpLimit,
  withFileLimit,
  withSubagentLimit,
  ConcurrencyLimiterManager,
} from "../util/concurrency-limiter"

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
            await new Promise((resolve) => setTimeout(resolve, 5))
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

      const tasks = Array(5)
        .fill(0)
        .map(() =>
          limiter.run(async () => {
            await new Promise((resolve) => setTimeout(resolve, 5))
            return "done"
          }),
        )

      await Promise.all(tasks)
      expect(limiter.getActiveCount()).toBe(0)
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
            await new Promise((resolve) => setTimeout(resolve, 3))
            activeCount--
            return "done"
          }),
        )

      await Promise.all(tasks)
      expect(maxActive.value).toBe(2)
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
            await new Promise((resolve) => setTimeout(resolve, 3))
            return i
          }),
        )

      await Promise.all(tasks)
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
        limiter.run(async () => "success"),
        limiter.run(async () => "success 2"),
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
        await new Promise((resolve) => setTimeout(resolve, 5))
        return "done"
      })

      await task
      expect(limiter.getActiveCount()).toBe(0)
    })

    test("getQueueLength returns correct count", async () => {
      const limiter = new ConcurrencyLimiter(1)

      const tasks = [
        limiter.run(async () => {
          await new Promise((resolve) => setTimeout(resolve, 30))
          return "1"
        }),
        limiter.run(async () => "2"),
        limiter.run(async () => "3"),
      ]

      await new Promise((resolve) => setTimeout(resolve, 3))

      expect(limiter.getQueueLength()).toBe(2)

      await Promise.all(tasks)
      expect(limiter.getQueueLength()).toBe(0)
    })

    test("hasPendingOperations returns correct state", async () => {
      const limiter = new ConcurrencyLimiter(1)

      expect(limiter.hasPendingOperations()).toBe(false)

      const task = limiter.run(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30))
        return "done"
      })

      await new Promise((resolve) => setTimeout(resolve, 3))
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

  describe("drain queue", () => {
    test("drainQueue rejects all queued operations", async () => {
      const limiter = new ConcurrencyLimiter(1)

      const running = limiter.run(async () => {
        await new Promise((resolve) => setTimeout(resolve, 30))
        return "running"
      })

      const queued = [limiter.run(async () => "1"), limiter.run(async () => "2"), limiter.run(async () => "3")]

      await new Promise((resolve) => setTimeout(resolve, 3))

      const drainError = new Error("Queue drained")
      const drained = limiter.drainQueue(drainError)

      expect(drained).toBe(3)

      const results = await Promise.allSettled(queued)
      expect(results[0].status).toBe("rejected")
      expect(results[1].status).toBe("rejected")
      expect(results[2].status).toBe("rejected")

      expect(await running).toBe("running")
    })

    test("run throws after drainQueue", async () => {
      const limiter = new ConcurrencyLimiter(5)

      limiter.drainQueue(new Error("Drained"))

      await expect(limiter.run(async () => "test")).rejects.toThrow("ConcurrencyLimiter has been drained")
    })

    test("drainQueue does not cause negative activeCount", async () => {
      const limiter = new ConcurrencyLimiter(1)

      const queued = [
        limiter.run(async () => {
          await new Promise((resolve) => setTimeout(resolve, 100))
          return "1"
        }),
        limiter.run(async () => "2"),
        limiter.run(async () => "3"),
      ]

      await new Promise((resolve) => setTimeout(resolve, 5))

      expect(limiter.getActiveCount()).toBe(1)
      expect(limiter.getQueueLength()).toBe(2)

      const drainError = new Error("Queue drained")
      const drained = limiter.drainQueue(drainError)

      expect(drained).toBe(2)
      expect(limiter.getActiveCount()).toBe(1)

      const results = await Promise.allSettled(queued)
      expect(results[0].status).toBe("fulfilled")
      expect((results[0] as PromiseFulfilledResult<string>).value).toBe("1")
      expect(results[1].status).toBe("rejected")
      expect(results[2].status).toBe("rejected")

      expect(limiter.getActiveCount()).toBe(0)
    })

    test("drainQueue returns correct count", async () => {
      const limiter = new ConcurrencyLimiter(1)

      // First limiter completes immediately, then drain
      const result = limiter.drainQueue(new Error("Test"))
      expect(result).toBe(0) // Queue is empty at start

      // After drain, trying to run should throw
      await expect(limiter.run(async () => "test")).rejects.toThrow("drained")
    })
  })

  describe("pause and resume", () => {
    test("pause sets paused state", () => {
      const limiter = new ConcurrencyLimiter(5)
      limiter.pause()
      expect(limiter.getStatus().isPaused).toBe(true)
    })

    test("resume clears paused state", () => {
      const limiter = new ConcurrencyLimiter(5)
      limiter.pause()
      limiter.resume()
      expect(limiter.getStatus().isPaused).toBe(false)
    })
  })

  describe("waitForIdle", () => {
    test("waits for all operations to complete", async () => {
      const limiter = new ConcurrencyLimiter(2)

      const tasks = Array(3)
        .fill(0)
        .map(() =>
          limiter.run(async () => {
            await new Promise((resolve) => setTimeout(resolve, 10))
            return "done"
          }),
        )

      await limiter.waitForIdle()

      expect(limiter.hasPendingOperations()).toBe(false)
      expect(await Promise.all(tasks)).toHaveLength(3)
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
    expect(globalLspLimiter).toBeInstanceOf(ConcurrencyLimiter)
    expect(globalLspLimiter.getMaxConcurrent()).toBe(50)
  })

  test("globalMcpLimiter exists and has correct limit", () => {
    expect(globalMcpLimiter).toBeInstanceOf(ConcurrencyLimiter)
    expect(globalMcpLimiter.getMaxConcurrent()).toBe(30)
  })

  test("globalFileLimiter exists and has correct limit", () => {
    expect(globalFileLimiter).toBeInstanceOf(ConcurrencyLimiter)
    expect(globalFileLimiter.getMaxConcurrent()).toBe(100)
  })

  test("globalSubagentLimiter exists and has correct limit", () => {
    expect(globalSubagentLimiter).toBeInstanceOf(ConcurrencyLimiter)
    expect(globalSubagentLimiter.getMaxConcurrent()).toBe(10)
  })
})

describe("Helper functions", () => {
  test("withLspLimit wraps function correctly", async () => {
    let called = false

    await withLspLimit(async () => {
      called = true
      return "result"
    })

    expect(called).toBe(true)
  })

  test("withMcpLimit wraps function correctly", async () => {
    const result = await withMcpLimit(async () => "mcp result")
    expect(result).toBe("mcp result")
  })

  test("withFileLimit wraps function correctly", async () => {
    const result = await withFileLimit(async () => "file result")
    expect(result).toBe("file result")
  })

  test("withSubagentLimit wraps function correctly", async () => {
    const result = await withSubagentLimit(async () => "subagent result")
    expect(result).toBe("subagent result")
  })
})

describe("ConcurrencyLimiterManager", () => {
  test("creates and manages named limiters", () => {
    const manager = new ConcurrencyLimiterManager(5)

    const limiter1 = manager.getLimiter("test1", 3)
    const limiter2 = manager.getLimiter("test2")

    expect(limiter1.getMaxConcurrent()).toBe(3)
    expect(limiter2.getMaxConcurrent()).toBe(5)
  })

  test("runs function through named limiter", async () => {
    const manager = new ConcurrencyLimiterManager(2)

    const result = await manager.run("test", async () => "result")
    expect(result).toBe("result")
  })

  test("gets status of all limiters", async () => {
    const manager = new ConcurrencyLimiterManager(2)

    await manager.run("limiter1", async () => "a")
    await manager.run("limiter2", async () => "b")

    const status = manager.getAllStatus()
    expect(Object.keys(status)).toContain("limiter1")
    expect(Object.keys(status)).toContain("limiter2")
  })

  test("drains all limiters", async () => {
    const manager = new ConcurrencyLimiterManager(1)

    // Create limiters and drain immediately
    const limiter1 = manager.getLimiter("limiter1", 1)
    const limiter2 = manager.getLimiter("limiter2", 1)

    // Drain both
    const total = manager.drainAll(new Error("drain"))
    expect(total).toBe(0) // No queued operations
  })
})
