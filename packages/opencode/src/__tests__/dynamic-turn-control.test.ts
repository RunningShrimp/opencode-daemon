import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { DynamicTurnController, getController, globalTurnControlManager } from "../util/dynamic-turn-control"

describe("DynamicTurnController", () => {
  let controller: DynamicTurnController

  beforeEach(async () => {
    controller = new DynamicTurnController()
    await controller.initialize("moderate", 50000)
  })

  afterEach(() => {
    controller.reset()
  })

  describe("initialization", () => {
    test("initializes with moderate complexity", async () => {
      const c = new DynamicTurnController()
      await c.initialize("moderate")
      const state = c.getState()
      expect(state.complexity).toBe("moderate")
      expect(state.maxTurns).toBe(20)
    })

    test("initializes with simple complexity", async () => {
      const c = new DynamicTurnController()
      await c.initialize("simple")
      const state = c.getState()
      expect(state.complexity).toBe("simple")
      expect(state.maxTurns).toBe(10)
    })

    test("initializes with complex complexity", async () => {
      const c = new DynamicTurnController()
      await c.initialize("complex")
      const state = c.getState()
      expect(state.complexity).toBe("complex")
      expect(state.maxTurns).toBe(35)
    })

    test("sets budget from estimated tokens", async () => {
      const c = new DynamicTurnController()
      await c.initialize("moderate", 100000)
      const state = c.getState()
      expect(state.budget).toBe(150000)
    })
  })

  describe("record", () => {
    test("records successful tool execution", () => {
      controller.record(true)
      const state = controller.getState()
      expect(state.turn).toBe(1)
      expect(state.successHistory).toContain(1)
    })

    test("records failed tool execution", () => {
      controller.record(false)
      const state = controller.getState()
      expect(state.turn).toBe(1)
      expect(state.successHistory).toContain(0)
    })

    test("records with token usage", () => {
      controller.record(true, { input: 1000, output: 500, total: 1500 })
      const state = controller.getState()
      expect(state.usageHistory.length).toBe(1)
    })
  })

  describe("shouldContinue", () => {
    test("continues when under max turns", () => {
      controller.record(true)
      const result = controller.shouldContinue(5000)
      expect(result.shouldContinue).toBe(true)
    })

    test("stops at max turns", async () => {
      const c = new DynamicTurnController({ maxTurns: 3 })
      await c.initialize("simple")
      c.record(true)
      c.record(true)
      c.record(true)
      const result = c.shouldContinue(5000)
      expect(result.shouldContinue).toBe(false)
      expect(result.reason).toContain("max turns")
    })

    test("stops when budget exceeded", async () => {
      const c = new DynamicTurnController({ maxTurns: 10 })
      await c.initialize("simple", 1000)
      c.record(true)
      const result = c.shouldContinue(50000)
      expect(result.shouldContinue).toBe(false)
      expect(result.reason).toContain("budget")
    })

    test("protects minimum turns within budget", async () => {
      const c = new DynamicTurnController({ maxTurns: 10, minTurns: 5 })
      await c.initialize("simple", 100000)
      c.record(true)
      const result = c.shouldContinue(20000)
      expect(result.shouldContinue).toBe(true)
      expect(result.reason).toContain("min turns")
    })
  })

  describe("getProgress", () => {
    test("returns correct progress", async () => {
      const c = new DynamicTurnController({ maxTurns: 10 })
      await c.initialize("simple")
      c.record(true)
      c.record(true)
      expect(c.getProgress()).toBe(0.2)
    })
  })

  describe("reset", () => {
    test("clears all state", async () => {
      const c = new DynamicTurnController()
      await c.initialize("moderate")
      c.record(true)
      c.record(true)
      c.reset()

      const state = c.getState()
      expect(state.turn).toBe(0)
      expect(state.successHistory.length).toBe(0)
    })
  })
})

describe("Global Turn Control Manager", () => {
  beforeEach(() => {
    globalTurnControlManager.clear()
  })

  test("getOrCreate returns same controller for same session", () => {
    const c1 = getController("session-1")
    const c2 = getController("session-1")
    expect(c1).toBe(c2)
  })

  test("getOrCreate returns different controllers for different sessions", () => {
    const c1 = getController("session-1")
    const c2 = getController("session-2")
    expect(c1).not.toBe(c2)
  })

  test("remove clears specific controller", async () => {
    const c1 = getController("session-1")
    await c1.initialize("moderate")
    c1.record(true)
    globalTurnControlManager.remove("session-1")

    const c1new = getController("session-1")
    expect(c1new.getState().turn).toBe(0)
  })

  test("clear removes all controllers", async () => {
    const c1 = getController("session-1")
    const c2 = getController("session-2")
    await c1.initialize("moderate")
    await c2.initialize("moderate")
    c1.record(true)
    c2.record(true)
    globalTurnControlManager.clear()

    const c1new = getController("session-1")
    const c2new = getController("session-2")
    expect(c1new.getState().turn).toBe(0)
    expect(c2new.getState().turn).toBe(0)
  })
})
