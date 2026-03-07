import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import {
  ToolEffectivenessTracker,
  getToolEffectivenessTracker,
  globalToolEffectivenessManager,
  type ToolEffectivenessConfig,
} from "../util/effectiveness-tracker"

describe("ToolEffectivenessTracker", () => {
  let tracker: ToolEffectivenessTracker

  beforeEach(() => {
    tracker = new ToolEffectivenessTracker()
    tracker.initialize()
  })

  afterEach(() => {
    tracker.clear()
  })

  describe("initialization", () => {
    test("initializes with default config", () => {
      const t = new ToolEffectivenessTracker()
      t.initialize()
      expect(t).toBeDefined()
    })

    test("initializes with custom config", () => {
      const cfg: Partial<ToolEffectivenessConfig> = {
        enabled: true,
        historySize: 100,
        minRecordsForRecommendation: 10,
        successRateWeight: 0.8,
        executionTimeWeight: 0.2,
      }
      const t = new ToolEffectivenessTracker(cfg)
      t.initialize()
      expect(t).toBeDefined()
    })
  })

  describe("recordExecution", () => {
    test("records successful execution", () => {
      tracker.recordExecution("bash", "implementation", true, 1500)

      const stats = tracker.getToolStats("bash")
      expect(stats).not.toBeNull()
      expect(stats!.totalExecutions).toBe(1)
      expect(stats!.successCount).toBe(1)
      expect(stats!.failureCount).toBe(0)
      expect(stats!.successRate).toBe(1)
    })

    test("records failed execution", () => {
      tracker.recordExecution("bash", "implementation", false, 3000, "Command failed")

      const stats = tracker.getToolStats("bash")
      expect(stats).not.toBeNull()
      expect(stats!.totalExecutions).toBe(1)
      expect(stats!.successCount).toBe(0)
      expect(stats!.failureCount).toBe(1)
      expect(stats!.successRate).toBe(0)
    })

    test("calculates average duration", () => {
      tracker.recordExecution("bash", "implementation", true, 1000)
      tracker.recordExecution("bash", "implementation", true, 2000)
      tracker.recordExecution("bash", "implementation", true, 3000)

      const stats = tracker.getToolStats("bash")
      expect(stats!.avgDuration).toBe(2000)
    })

    test("maintains history size limit", () => {
      for (let i = 0; i < 60; i++) {
        tracker.recordExecution("bash", "implementation", true, 1000)
      }

      const records = tracker.getRecentRecords()
      expect(records.length).toBeLessThanOrEqual(50)
    })

    test("does not record when disabled", () => {
      const t = new ToolEffectivenessTracker({ enabled: false })
      t.initialize()
      t.recordExecution("bash", "implementation", true, 1000)

      const stats = t.getToolStats("bash")
      expect(stats).toBeNull()
    })

    test("tracks task types", () => {
      tracker.recordExecution("bash", "implementation", true, 1000)
      tracker.recordExecution("bash", "debugging", true, 1500)

      const stats = tracker.getToolStats("bash")
      expect(stats!.taskTypes.has("implementation")).toBe(true)
      expect(stats!.taskTypes.has("debugging")).toBe(true)
    })
  })

  describe("recommendTools", () => {
    test("returns empty array when no tools", () => {
      const recs = tracker.recommendTools([], "implementation")
      expect(recs).toEqual([])
    })

    test("returns default score for tools without history", () => {
      const recs = tracker.recommendTools(["bash", "edit"], "implementation")

      expect(recs.length).toBe(2)
      expect(recs[0].score).toBe(0.5)
      expect(recs[0].reason).toContain("无足够历史数据")
    })

    test("recommends tools with higher success rate", () => {
      for (let i = 0; i < 10; i++) {
        tracker.recordExecution("bash", "implementation", true, 1000)
        tracker.recordExecution("edit", "implementation", i < 5, 2000)
      }

      const recs = tracker.recommendTools(["bash", "edit"], "implementation")

      expect(recs[0].toolName).toBe("bash")
      expect(recs[0].successRate).toBe(1)
    })

    test("considers execution time in scoring", () => {
      for (let i = 0; i < 10; i++) {
        tracker.recordExecution("fast-tool", "implementation", true, 500)
        tracker.recordExecution("slow-tool", "implementation", true, 5000)
      }

      const recs = tracker.recommendTools(["fast-tool", "slow-tool"], "implementation")

      expect(recs[0].toolName).toBe("fast-tool")
    })

    test("gives bonus for task type match", () => {
      for (let i = 0; i < 10; i++) {
        tracker.recordExecution("bash", "implementation", true, 1000)
        tracker.recordExecution("edit", "debugging", true, 1000)
      }

      const recs = tracker.recommendTools(["bash", "edit"], "implementation")

      expect(recs[0].toolName).toBe("bash")
    })

    test("sorts recommendations by score descending", () => {
      for (let i = 0; i < 10; i++) {
        tracker.recordExecution("best", "implementation", true, 500)
        tracker.recordExecution("good", "implementation", i < 8, 1000)
        tracker.recordExecution("ok", "implementation", i < 6, 1500)
      }

      const recs = tracker.recommendTools(["best", "good", "ok"], "implementation")

      expect(recs[0].toolName).toBe("best")
      expect(recs[1].toolName).toBe("good")
      expect(recs[2].toolName).toBe("ok")
    })
  })

  describe("getToolStats", () => {
    test("returns null for non-existent tool", () => {
      const stats = tracker.getToolStats("non-existent")
      expect(stats).toBeNull()
    })

    test("returns complete statistics", () => {
      tracker.recordExecution("bash", "implementation", true, 1000)
      tracker.recordExecution("bash", "implementation", false, 2000)

      const stats = tracker.getToolStats("bash")
      expect(stats!.totalExecutions).toBe(2)
      expect(stats!.successCount).toBe(1)
      expect(stats!.failureCount).toBe(1)
      expect(stats!.successRate).toBe(0.5)
      expect(stats!.avgDuration).toBe(1500)
      expect(stats!.minDuration).toBe(1000)
      expect(stats!.maxDuration).toBe(2000)
    })
  })

  describe("getRecentRecords", () => {
    test("returns empty array when no records", () => {
      const records = tracker.getRecentRecords()
      expect(records).toEqual([])
    })

    test("returns most recent records", () => {
      tracker.recordExecution("bash", "implementation", true, 1000)
      tracker.recordExecution("edit", "implementation", true, 2000)

      const records = tracker.getRecentRecords(2)
      expect(records.length).toBe(2)
    })
  })

  describe("clearTool", () => {
    test("clears specific tool records", () => {
      tracker.recordExecution("bash", "implementation", true, 1000)
      tracker.recordExecution("edit", "implementation", true, 2000)

      tracker.clearTool("bash")

      expect(tracker.getToolStats("bash")).toBeNull()
      expect(tracker.getToolStats("edit")).not.toBeNull()
    })
  })

  describe("clear", () => {
    test("clears all records and stats", () => {
      tracker.recordExecution("bash", "implementation", true, 1000)
      tracker.recordExecution("edit", "implementation", true, 2000)

      tracker.clear()

      expect(tracker.getToolStats("bash")).toBeNull()
      expect(tracker.getToolStats("edit")).toBeNull()
      expect(tracker.getRecentRecords()).toEqual([])
    })
  })
})

describe("Global Manager", () => {
  beforeEach(() => {
    globalToolEffectivenessManager.clear()
  })

  test("getOrCreate returns same tracker for same session", () => {
    const t1 = getToolEffectivenessTracker("session-1")
    const t2 = getToolEffectivenessTracker("session-1")
    expect(t1).toBe(t2)
  })

  test("getOrCreate returns different trackers for different sessions", () => {
    const t1 = getToolEffectivenessTracker("session-1")
    const t2 = getToolEffectivenessTracker("session-2")
    expect(t1).not.toBe(t2)
  })

  test("remove clears specific tracker", () => {
    const t = getToolEffectivenessTracker("session-1")
    t.recordExecution("bash", "implementation", true, 1000)

    globalToolEffectivenessManager.remove("session-1")

    const t2 = getToolEffectivenessTracker("session-1")
    expect(t2.getToolStats("bash")).toBeNull()
  })

  test("clear removes all trackers", () => {
    const t1 = getToolEffectivenessTracker("session-1")
    const t2 = getToolEffectivenessTracker("session-2")
    t1.recordExecution("bash", "implementation", true, 1000)
    t2.recordExecution("edit", "implementation", true, 1000)

    globalToolEffectivenessManager.clear()

    expect(getToolEffectivenessTracker("session-1").getToolStats("bash")).toBeNull()
    expect(getToolEffectivenessTracker("session-2").getToolStats("edit")).toBeNull()
  })
})
