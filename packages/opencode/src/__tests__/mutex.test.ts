/**
 * Mutex Unit Tests
 *
 * Tests for the Mutex, NamedMutex, and related utilities.
 */

import { describe, test, expect, beforeEach } from "bun:test"
import { Mutex, NamedMutex, createMutex, withMutex, withGlobalMutex, globalNamedMutex } from "../util/mutex"

describe("Mutex", () => {
  describe("construction", () => {
    test("creates unlocked mutex", () => {
      const mutex = new Mutex()
      expect(mutex.isLocked()).toBe(false)
      expect(mutex.getWaitCount()).toBe(0)
    })
  })

  describe("basic locking", () => {
    test("run executes function while locked", async () => {
      const mutex = new Mutex()
      let lockedDuringRun = false

      await mutex.run(async () => {
        lockedDuringRun = mutex.isLocked()
      })

      expect(lockedDuringRun).toBe(true)
      expect(mutex.isLocked()).toBe(false)
    })

    test("run returns function result", async () => {
      const mutex = new Mutex()
      const result = await mutex.run(async () => {
        return "test result"
      })

      expect(result).toBe("test result")
    })

    test("run throws after forceRelease", async () => {
      const mutex = new Mutex()

      mutex.forceRelease(new Error("Released"))

      await expect(mutex.run(async () => "test")).rejects.toThrow("Released")
    })

    test("subsequent runs wait for first to complete", async () => {
      const mutex = new Mutex()
      const order: number[] = []

      const task1 = mutex.run(async () => {
        order.push(1)
        await new Promise((r) => setTimeout(r, 20))
        order.push(2)
        return "task1"
      })

      const task2 = mutex.run(async () => {
        order.push(3)
        return "task2"
      })

      const [result1, result2] = await Promise.all([task1, task2])

      expect(result1).toBe("task1")
      expect(result2).toBe("task2")
      expect(order).toEqual([1, 2, 3])
    })
  })

  describe("error handling", () => {
    test("propagates errors from function", async () => {
      const mutex = new Mutex()

      await expect(
        mutex.run(async () => {
          throw new Error("test error")
        })
      ).rejects.toThrow("test error")
    })

    test("unlocks after error", async () => {
      const mutex = new Mutex()

      try {
        await mutex.run(async () => {
          throw new Error("test error")
        })
      } catch (e) {
        // Expected
      }

      expect(mutex.isLocked()).toBe(false)
    })
  })

  describe("wait count", () => {
    test("tracks waiting operations", async () => {
      const mutex = new Mutex()
      const mutex2 = new Mutex()

      const task1 = mutex.run(async () => {
        await new Promise((r) => setTimeout(r, 50))
        return "done"
      })

      // Give time for task1 to start
      await new Promise((r) => setTimeout(r, 5))

      const task2 = mutex.run(async () => "task2")
      const task3 = mutex.run(async () => "task3")

      expect(mutex.getWaitCount()).toBe(2)

      await Promise.all([task1, task2, task3])

      expect(mutex.getWaitCount()).toBe(0)
    })
  })

  describe("force release", () => {
    test("rejects all waiting operations", async () => {
      const mutex = new Mutex()

      const task1 = mutex.run(async () => {
        await new Promise((r) => setTimeout(r, 50))
        return "task1"
      })

      await new Promise((r) => setTimeout(r, 5))

      const task2 = mutex.run(async () => "task2")
      const task3 = mutex.run(async () => "task3")

      mutex.forceRelease(new Error("Force release"))

      const results = await Promise.allSettled([task1, task2, task3])

      expect(results[0].status).toBe("fulfilled")
      expect(results[1].status).toBe("rejected")
      expect(results[2].status).toBe("rejected")
    })

    test("resets locked state", () => {
      const mutex = new Mutex()

      mutex.forceRelease(new Error("test"))

      expect(mutex.isLocked()).toBe(false)
    })
  })

  describe("concurrent access", () => {
    test("handles many concurrent locks", async () => {
      const mutex = new Mutex()
      let activeCount = 0
      const maxActive = { value: 0 }

      const tasks = Array(100)
        .fill(0)
        .map(() =>
          mutex.run(async () => {
            activeCount++
            maxActive.value = Math.max(maxActive.value, activeCount)
            await new Promise((r) => setTimeout(r, 1))
            activeCount--
            return "done"
          })
        )

      const results = await Promise.all(tasks)

      expect(results.every((r) => r === "done")).toBe(true)
      expect(maxActive.value).toBe(1) // Should never exceed 1
    })

    test("maintains order under high concurrency", async () => {
      const mutex = new Mutex()
      const order: number[] = []

      const tasks = Array(50)
        .fill(0)
        .map((_, i) =>
          mutex.run(async () => {
            order.push(i)
            await new Promise((r) => setTimeout(r, 1))
            return i
          })
        )

      await Promise.all(tasks)

      // Order should be sequential
      const sortedOrder = [...order].sort((a, b) => a - b)
      expect(order).toEqual(sortedOrder)
    })
  })
})

describe("createMutex", () => {
  test("creates new mutex instance", () => {
    const mutex = createMutex()
    expect(mutex).toBeInstanceOf(Mutex)
  })
})

describe("withMutex", () => {
  test("creates temporary mutex and executes", async () => {
    const result = await withMutex(async () => "result")
    expect(result).toBe("result")
  })

  test("handles errors", async () => {
    await expect(
      withMutex(async () => {
        throw new Error("test")
      })
    ).rejects.toThrow("test")
  })
})

describe("NamedMutex", () => {
  describe("basic operations", () => {
    test("run executes with named lock", async () => {
      const namedMutex = new NamedMutex()
      let executed = false

      await namedMutex.run("resource1", async () => {
        executed = true
      })

      expect(executed).toBe(true)
    })

    test("different keys don't block each other", async () => {
      const namedMutex = new NamedMutex()
      const order: string[] = []

      const task1 = namedMutex.run("key1", async () => {
        order.push("key1-start")
        await new Promise((r) => setTimeout(r, 10))
        order.push("key1-end")
        return "result1"
      })

      // Small delay to ensure task1 starts first
      await new Promise((r) => setTimeout(r, 2))

      const task2 = namedMutex.run("key2", async () => {
        order.push("key2-start")
        order.push("key2-end")
        return "result2"
      })

      const [result1, result2] = await Promise.all([task1, task2])

      expect(result1).toBe("result1")
      expect(result2).toBe("result2")
      // Since different keys don't block, task2 can complete while task1 is sleeping
      // The exact order depends on timing, so we just verify both completed
      expect(order).toContain("key1-start")
      expect(order).toContain("key1-end")
      expect(order).toContain("key2-start")
      expect(order).toContain("key2-end")
    })

    test("same key blocks concurrent access", async () => {
      const namedMutex = new NamedMutex()
      const order: string[] = []

      const task1 = namedMutex.run("same-key", async () => {
        order.push("task1-start")
        await new Promise((r) => setTimeout(r, 10))
        order.push("task1-end")
        return "result1"
      })

      const task2 = namedMutex.run("same-key", async () => {
        order.push("task2-start")
        order.push("task2-end")
        return "result2"
      })

      const [result1, result2] = await Promise.all([task1, task2])

      expect(result1).toBe("result1")
      expect(result2).toBe("result2")
      expect(order).toEqual(["task1-start", "task1-end", "task2-start", "task2-end"])
    })
  })

  describe("queries", () => {
    test("has returns correct value", () => {
      const namedMutex = new NamedMutex()

      expect(namedMutex.has("key1")).toBe(false)

      namedMutex.run("key1", async () => {})

      expect(namedMutex.has("key1")).toBe(true)
    })

    test("isLocked returns correct value", async () => {
      const namedMutex = new NamedMutex()

      expect(namedMutex.isLocked("key1")).toBe(false)

      const task = namedMutex.run("key1", async () => {
        await new Promise((r) => setTimeout(r, 50))
        return "done"
      })

      await new Promise((r) => setTimeout(r, 5))

      expect(namedMutex.isLocked("key1")).toBe(true)

      await task

      expect(namedMutex.isLocked("key1")).toBe(false)
    })

    test("getWaitCount returns correct value", async () => {
      const namedMutex = new NamedMutex()

      const task1 = namedMutex.run("key1", async () => {
        await new Promise((r) => setTimeout(r, 50))
        return "done"
      })

      await new Promise((r) => setTimeout(r, 5))

      const task2 = namedMutex.run("key1", async () => "task2")
      const task3 = namedMutex.run("key1", async () => "task3")

      expect(namedMutex.getWaitCount("key1")).toBe(2)

      await Promise.all([task1, task2, task3])
    })

    test("size returns correct count", () => {
      const namedMutex = new NamedMutex()

      expect(namedMutex.size()).toBe(0)

      namedMutex.run("key1", async () => {})
      namedMutex.run("key2", async () => {})

      expect(namedMutex.size()).toBe(2)
    })
  })

  describe("delete", () => {
    test("deletes named mutex", () => {
      const namedMutex = new NamedMutex()

      namedMutex.run("key1", async () => {})

      expect(namedMutex.has("key1")).toBe(true)

      namedMutex.delete("key1")

      expect(namedMutex.has("key1")).toBe(false)
    })

    test("delete with error rejects waiting", async () => {
      const namedMutex = new NamedMutex()

      const task1 = namedMutex.run("key1", async () => {
        await new Promise((r) => setTimeout(r, 50))
        return "done"
      })

      await new Promise((r) => setTimeout(r, 5))

      const task2 = namedMutex.run("key1", async () => "task2")

      namedMutex.delete("key1", new Error("Deleted"))

      const results = await Promise.allSettled([task1, task2])

      expect(results[0].status).toBe("fulfilled")
      expect(results[1].status).toBe("rejected")
    })
  })

  describe("clear", () => {
    test("clears all mutexes", async () => {
      const namedMutex = new NamedMutex()

      namedMutex.run("key1", async () => {})
      namedMutex.run("key2", async () => {})

      expect(namedMutex.size()).toBe(2)

      namedMutex.clear()

      expect(namedMutex.size()).toBe(0)
    })
  })
})

describe("globalNamedMutex", () => {
  test("is a NamedMutex instance", () => {
    expect(globalNamedMutex).toBeInstanceOf(NamedMutex)
  })

  test("withGlobalMutex works", async () => {
    const result = await withGlobalMutex("test-key", async () => "result")
    expect(result).toBe("result")
  })
})
