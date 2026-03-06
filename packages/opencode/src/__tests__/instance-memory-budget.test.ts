import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import {
  InstanceMemoryBudget,
  getBudget,
  globalManager,
  type InstanceMemoryBudgetConfig,
} from "../util/instance-memory-budget"

describe("InstanceMemoryBudget", () => {
  let budget: InstanceMemoryBudget

  beforeEach(() => {
    budget = new InstanceMemoryBudget({
      maxMemory: 1024 * 1024,
      warningThreshold: 0.7,
      criticalThreshold: 0.9,
      autoCleanup: true,
      cleanupPercentage: 0.5,
    })
  })

  afterEach(() => {
    budget.destroy()
  })

  describe("initialization", () => {
    test("initializes with default config", () => {
      const b = new InstanceMemoryBudget()
      const usage = b.getUsage()
      expect(usage.used).toBe(0)
      expect(usage.max).toBe(512 * 1024 * 1024)
      expect(usage.ratio).toBe(0)
      expect(usage.entryCount).toBe(0)
    })

    test("initializes with custom config", () => {
      const cfg: Partial<InstanceMemoryBudgetConfig> = {
        maxMemory: 256 * 1024 * 1024,
        warningThreshold: 0.8,
        criticalThreshold: 0.95,
        autoCleanup: false,
        cleanupPercentage: 0.3,
      }
      const b = new InstanceMemoryBudget(cfg)
      const usage = b.getUsage()
      expect(usage.max).toBe(256 * 1024 * 1024)
    })
  })

  describe("acquire", () => {
    test("acquires memory allocation", async () => {
      const result = await budget.acquire("entry-1", 1024)
      expect(result).toBe(true)

      const usage = budget.getUsage()
      expect(usage.used).toBe(1024)
      expect(usage.entryCount).toBe(1)
    })

    test("rejects allocation exceeding max", async () => {
      const result = await budget.acquire("entry-1", 2 * 1024 * 1024)
      expect(result).toBe(false)

      const usage = budget.getUsage()
      expect(usage.used).toBe(0)
    })

    test("handles multiple allocations", async () => {
      const r1 = await budget.acquire("entry-1", 512 * 1024)
      expect(r1).toBe(true)

      const r2 = await budget.acquire("entry-2", 256 * 1024)
      expect(r2).toBe(true)

      const usage = budget.getUsage()
      expect(usage.used).toBe(768 * 1024)
      expect(usage.entryCount).toBe(2)
    })

    test("rejects when cumulative exceeds max without cleanup", async () => {
      const b = new InstanceMemoryBudget({
        maxMemory: 1024 * 1024,
        autoCleanup: false,
      })

      const r1 = await b.acquire("entry-1", 768 * 1024)
      expect(r1).toBe(true)

      const r2 = await b.acquire("entry-2", 512 * 1024)
      expect(r2).toBe(false)
      b.destroy()
    })

    test("allows after cleanup when autoCleanup enabled", async () => {
      const r1 = await budget.acquire("entry-1", 768 * 1024)
      expect(r1).toBe(true)

      const r2 = await budget.acquire("entry-2", 512 * 1024)
      expect(r2).toBe(true)
    })

    test("replaces existing entry with same id", async () => {
      await budget.acquire("entry-1", 1024)
      await budget.acquire("entry-1", 2048)

      const usage = budget.getUsage()
      expect(usage.used).toBe(2048)
      expect(usage.entryCount).toBe(1)
    })
  })

  describe("release", () => {
    test("releases memory allocation", async () => {
      await budget.acquire("entry-1", 1024)
      const result = budget.release("entry-1")
      expect(result).toBe(true)

      const usage = budget.getUsage()
      expect(usage.used).toBe(0)
      expect(usage.entryCount).toBe(0)
    })

    test("returns false for non-existent entry", () => {
      const result = budget.release("non-existent")
      expect(result).toBe(false)
    })

    test("handles partial release", async () => {
      await budget.acquire("entry-1", 512 * 1024)
      await budget.acquire("entry-2", 256 * 1024)

      budget.release("entry-1")

      const usage = budget.getUsage()
      expect(usage.used).toBe(256 * 1024)
      expect(usage.entryCount).toBe(1)
    })
  })

  describe("auto cleanup", () => {
    test("triggers cleanup on critical threshold", async () => {
      let cleanupCalled = false
      budget.onCleanup(async () => {
        cleanupCalled = true
      })

      await budget.acquire("entry-1", 950 * 1024)
      await sleep(50)

      expect(cleanupCalled).toBe(true)
    })

    test("cleanup removes oldest entries first", async () => {
      const b = new InstanceMemoryBudget({
        maxMemory: 1024,
        autoCleanup: false,
        cleanupPercentage: 0.5,
      })

      await b.acquire("oldest", 400)
      await sleep(10)
      await b.acquire("middle", 400)
      await sleep(10)
      await b.acquire("newest", 200)

      await b.triggerCleanup()

      const usage = b.getUsage()
      expect(usage.entryCount).toBeLessThan(3)
      b.destroy()
    })
  })

  describe("thresholds", () => {
    test("detects warning threshold", async () => {
      const b = new InstanceMemoryBudget({
        maxMemory: 1000,
        warningThreshold: 0.7,
        criticalThreshold: 0.9,
        autoCleanup: false,
      })

      await b.acquire("entry", 750)

      const usage = b.getUsage()
      expect(usage.ratio).toBeGreaterThanOrEqual(0.7)
      b.destroy()
    })
  })

  describe("getUsage", () => {
    test("returns correct statistics", async () => {
      await budget.acquire("entry-1", 1024)
      await budget.acquire("entry-2", 2048)

      const usage = budget.getUsage()
      expect(usage.used).toBe(3072)
      expect(usage.max).toBe(1024 * 1024)
      expect(usage.ratio).toBeCloseTo(3072 / (1024 * 1024), 4)
      expect(usage.entryCount).toBe(2)
    })
  })

  describe("reset", () => {
    test("clears all state", async () => {
      await budget.acquire("entry-1", 1024)
      await budget.acquire("entry-2", 2048)

      budget.reset()

      const usage = budget.getUsage()
      expect(usage.used).toBe(0)
      expect(usage.entryCount).toBe(0)
    })
  })

  describe("destroy", () => {
    test("cleans up all resources", async () => {
      await budget.acquire("entry-1", 1024)
      budget.destroy()

      const usage = budget.getUsage()
      expect(usage.used).toBe(0)
    })
  })

  describe("cleanup callbacks", () => {
    test("registers and calls cleanup callbacks", async () => {
      let called = false
      budget.onCleanup(async () => {
        called = true
      })

      await budget.acquire("entry-1", 950 * 1024)
      await sleep(100)

      expect(called).toBe(true)
    })

    test("handles multiple callbacks", async () => {
      const calls: number[] = []
      budget.onCleanup(() => {
        calls.push(1)
        return Promise.resolve()
      })
      budget.onCleanup(() => {
        calls.push(2)
        return Promise.resolve()
      })

      await budget.acquire("entry-1", 950 * 1024)
      await sleep(100)

      expect(calls.length).toBe(2)
    })
  })
})

describe("Global Manager", () => {
  beforeEach(() => {
    globalManager.clear()
  })

  test("getOrCreate returns same budget for same instance", () => {
    const b1 = getBudget("instance-1")
    const b2 = getBudget("instance-1")
    expect(b1).toBe(b2)
  })

  test("getOrCreate returns different budgets for different instances", () => {
    const b1 = getBudget("instance-1")
    const b2 = getBudget("instance-2")
    expect(b1).not.toBe(b2)
  })

  test("remove clears specific budget", async () => {
    const b = getBudget("instance-1")
    await b.acquire("entry", 1024)

    globalManager.remove("instance-1")

    const b2 = getBudget("instance-1")
    expect(b2.getUsage().used).toBe(0)
  })

  test("clear removes all budgets", async () => {
    const b1 = getBudget("instance-1")
    const b2 = getBudget("instance-2")
    await b1.acquire("entry", 1024)
    await b2.acquire("entry", 1024)

    globalManager.clear()

    expect(getBudget("instance-1").getUsage().used).toBe(0)
    expect(getBudget("instance-2").getUsage().used).toBe(0)
  })
})

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
