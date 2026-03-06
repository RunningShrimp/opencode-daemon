import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import {
  MCPSmartRouter,
  getMCPRouter,
  globalMCPRouterManager,
  type MCPRouterConfig,
  type MCPToolCapability,
} from "../util/smart-router"

describe("MCPSmartRouter", () => {
  let router: MCPSmartRouter

  beforeEach(() => {
    router = new MCPSmartRouter()
    router.initialize()
  })

  afterEach(() => {
    router.clear()
  })

  const createTool = (id: string, name: string, taskTypes: string[], available = true): MCPToolCapability => ({
    toolId: id,
    name,
    description: `Tool ${name}`,
    serverName: "test-server",
    serverType: "local" as const,
    suitableTaskTypes: taskTypes,
    responseTimes: [],
    successRates: [],
    errorRates: [],
    tags: [],
    category: "test",
    available,
  })

  describe("initialization", () => {
    test("initializes with default config", () => {
      const r = new MCPSmartRouter()
      r.initialize()
      expect(r).toBeDefined()
    })

    test("initializes with custom config", () => {
      const cfg: Partial<MCPRouterConfig> = {
        enabled: true,
        responseTimeWindowSize: 20,
        successRateThreshold: 0.8,
        maxRetries: 5,
        enableLoadBalancing: false,
      }
      const r = new MCPSmartRouter(cfg)
      r.initialize()
      expect(r).toBeDefined()
    })
  })

  describe("registerTool", () => {
    test("registers a tool", () => {
      const tool = createTool("tool-1", "TestTool", ["implementation"])
      router.registerTool(tool)

      const tools = router.getAllTools()
      expect(tools.length).toBe(1)
      expect(tools[0].toolId).toBe("tool-1")
    })

    test("registers multiple tools", () => {
      router.registerTool(createTool("tool-1", "Tool1", ["implementation"]))
      router.registerTool(createTool("tool-2", "Tool2", ["debugging"]))

      const tools = router.getAllTools()
      expect(tools.length).toBe(2)
    })

    test("updates existing tool on re-register", () => {
      router.registerTool(createTool("tool-1", "Tool1", ["implementation"]))
      router.registerTool({
        ...createTool("tool-1", "Tool1-Updated", ["implementation", "debugging"]),
        available: false,
      })

      const tools = router.getAllTools()
      expect(tools.length).toBe(1)
      expect(tools[0].name).toBe("Tool1-Updated")
      expect(tools[0].available).toBe(false)
    })
  })

  describe("unregisterTool", () => {
    test("unregisters a tool", () => {
      router.registerTool(createTool("tool-1", "Tool1", ["implementation"]))
      router.unregisterTool("tool-1")

      const tools = router.getAllTools()
      expect(tools.length).toBe(0)
    })
  })

  describe("updateToolStatus", () => {
    test("updates tool availability", () => {
      router.registerTool(createTool("tool-1", "Tool1", ["implementation"]))
      router.updateToolStatus("tool-1", false)

      const available = router.getAvailableTools()
      expect(available.length).toBe(0)
    })
  })

  describe("recordToolCall", () => {
    test("records successful call", () => {
      router.registerTool(createTool("tool-1", "Tool1", ["implementation"]))
      router.recordToolCall("tool-1", true, 1000)

      const tools = router.getAllTools()
      expect(tools[0].responseTimes.length).toBe(1)
      expect(tools[0].successRates.length).toBe(1)
    })

    test("maintains window size", () => {
      router.registerTool(createTool("tool-1", "Tool1", ["implementation"]))

      for (let i = 0; i < 15; i++) {
        router.recordToolCall("tool-1", true, 1000)
      }

      const tools = router.getAllTools()
      expect(tools[0].responseTimes.length).toBeLessThanOrEqual(10)
    })
  })

  describe("selectTool", () => {
    test("returns null when no suitable tools", () => {
      const decision = router.selectTool("implementation")
      expect(decision.selectedTool).toBeNull()
      expect(decision.alternatives.length).toBe(0)
    })

    test("selects available tool matching task type", () => {
      router.registerTool(createTool("tool-1", "Tool1", ["implementation"]))

      const decision = router.selectTool("implementation")
      expect(decision.selectedTool).not.toBeNull()
      expect(decision.selectedTool!.toolId).toBe("tool-1")
    })

    test("skips unavailable tools", () => {
      router.registerTool(createTool("tool-1", "Tool1", ["implementation"], false))
      router.registerTool(createTool("tool-2", "Tool2", ["implementation"], true))

      const decision = router.selectTool("implementation")
      expect(decision.selectedTool!.toolId).toBe("tool-2")
    })

    test("selects tool with better response time", () => {
      router.registerTool(createTool("tool-1", "FastTool", ["implementation"]))
      router.registerTool(createTool("tool-2", "SlowTool", ["implementation"]))

      for (let i = 0; i < 5; i++) {
        router.recordToolCall("tool-1", true, 500)
        router.recordToolCall("tool-2", true, 3000)
      }

      const decision = router.selectTool("implementation")
      expect(decision.selectedTool!.toolId).toBe("tool-1")
    })

    test("selects tool with better success rate", () => {
      router.registerTool(createTool("tool-1", "ReliableTool", ["implementation"]))
      router.registerTool(createTool("tool-2", "UnreliableTool", ["implementation"]))

      for (let i = 0; i < 5; i++) {
        router.recordToolCall("tool-1", true, 1000)
        router.recordToolCall("tool-2", i < 2, 1000)
      }

      const decision = router.selectTool("implementation")
      expect(decision.selectedTool!.toolId).toBe("tool-1")
    })

    test("returns alternatives", () => {
      router.registerTool(createTool("tool-1", "Tool1", ["implementation"]))
      router.registerTool(createTool("tool-2", "Tool2", ["implementation"]))
      router.registerTool(createTool("tool-3", "Tool3", ["implementation"]))

      const decision = router.selectTool("implementation")
      expect(decision.alternatives.length).toBe(2)
    })

    test("handles fuzzy task type matching", () => {
      router.registerTool(createTool("tool-1", "Tool1", ["code implementation"]))

      const decision = router.selectTool("implementation code")
      expect(decision.selectedTool).not.toBeNull()
    })
  })

  describe("getAvailableTools", () => {
    test("returns only available tools", () => {
      router.registerTool(createTool("tool-1", "Tool1", ["implementation"], true))
      router.registerTool(createTool("tool-2", "Tool2", ["implementation"], false))
      router.registerTool(createTool("tool-3", "Tool3", ["implementation"], true))

      const available = router.getAvailableTools()
      expect(available.length).toBe(2)
    })
  })

  describe("clear", () => {
    test("clears all tools", () => {
      router.registerTool(createTool("tool-1", "Tool1", ["implementation"]))
      router.registerTool(createTool("tool-2", "Tool2", ["debugging"]))

      router.clear()

      expect(router.getAllTools().length).toBe(0)
    })
  })
})

describe("Global Manager", () => {
  beforeEach(() => {
    globalMCPRouterManager.clear()
  })

  test("getOrCreate returns same router for same session", () => {
    const r1 = getMCPRouter("session-1")
    const r2 = getMCPRouter("session-1")
    expect(r1).toBe(r2)
  })

  test("getOrCreate returns different routers for different sessions", () => {
    const r1 = getMCPRouter("session-1")
    const r2 = getMCPRouter("session-2")
    expect(r1).not.toBe(r2)
  })

  test("remove clears specific router", () => {
    const r = getMCPRouter("session-1")
    r.registerTool({
      toolId: "tool-1",
      name: "Tool1",
      description: "Test",
      serverName: "test",
      serverType: "local",
      suitableTaskTypes: ["implementation"],
      responseTimes: [],
      successRates: [],
      errorRates: [],
      tags: [],
      category: "test",
      available: true,
    })

    globalMCPRouterManager.remove("session-1")

    const r2 = getMCPRouter("session-1")
    expect(r2.getAllTools().length).toBe(0)
  })

  test("clear removes all routers", () => {
    const r1 = getMCPRouter("session-1")
    const r2 = getMCPRouter("session-2")
    r1.registerTool({
      toolId: "tool-1",
      name: "Tool1",
      description: "Test",
      serverName: "test",
      serverType: "local",
      suitableTaskTypes: ["implementation"],
      responseTimes: [],
      successRates: [],
      errorRates: [],
      tags: [],
      category: "test",
      available: true,
    })
    r2.registerTool({
      toolId: "tool-2",
      name: "Tool2",
      description: "Test",
      serverName: "test",
      serverType: "local",
      suitableTaskTypes: ["debugging"],
      responseTimes: [],
      successRates: [],
      errorRates: [],
      tags: [],
      category: "test",
      available: true,
    })

    globalMCPRouterManager.clear()

    expect(getMCPRouter("session-1").getAllTools().length).toBe(0)
    expect(getMCPRouter("session-2").getAllTools().length).toBe(0)
  })
})
