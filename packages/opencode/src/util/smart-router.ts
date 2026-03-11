import { Log } from "@/util/log"
import { EventEmitter } from "events"

const log = Log.create({ service: "mcp-smart-router" })

// ============================================================================
// Types and Interfaces
// ============================================================================

export interface MCPToolCapability {
  toolId: string
  name: string
  description: string
  serverName: string
  serverType: "local" | "remote"
  suitableTaskTypes: string[]
  inputSchema?: Record<string, unknown>
  responseTimes: number[]
  successRates: number[]
  errorRates: number[]
  lastUsed?: number
  lastSuccess?: number
  lastError?: number
  available: boolean
  tags: string[]
  category: string
}

export interface MCPRouterConfig {
  enabled: boolean
  responseTimeWindowSize: number
  successRateThreshold: number
  errorRateThreshold: number
  maxRetries: number
  enableLoadBalancing: boolean
  enableProactiveDiscovery: boolean
  taskDecompositionEnabled: boolean
  toolWarmingEnabled: boolean
  semanticSimilarityThreshold: number
}

const DEFAULT_CONFIG: MCPRouterConfig = {
  enabled: true,
  responseTimeWindowSize: 20,
  successRateThreshold: 0.7,
  errorRateThreshold: 0.3,
  maxRetries: 3,
  enableLoadBalancing: true,
  enableProactiveDiscovery: true,
  taskDecompositionEnabled: true,
  toolWarmingEnabled: true,
  semanticSimilarityThreshold: 0.6,
}

export interface RoutingDecision {
  selectedTool: MCPToolCapability | null
  alternatives: MCPToolCapability[]
  reason: string
  confidence: number
  strategy: "direct" | "fallback" | "parallel" | "decomposed"
  subtasks?: SubTask[]
}

export interface SubTask {
  id: string
  description: string
  requiredCapabilities: string[]
  estimatedComplexity: number
  dependencies: string[]
}

export interface ToolInvocation {
  toolId: string
  arguments: Record<string, unknown>
  startTime: number
  endTime?: number
  success?: boolean
  error?: string
  result?: unknown
}

export interface SessionMetrics {
  sessionId: string
  toolInvocations: ToolInvocation[]
  totalTokens: number
  totalDuration: number
  successCount: number
  errorCount: number
  startTime: number
}

// ============================================================================
// Tool Semantic Matcher - 使用简单的关键词匹配实现
// ============================================================================

class ToolSemanticMatcher {
  private toolIndex = new Map<string, Set<string>>() // word -> tools

  indexTool(tool: MCPToolCapability): void {
    // 从名称、描述、tags中提取关键词
    const words = this.extractKeywords(tool)
    for (const word of words) {
      let tools = this.toolIndex.get(word)
      if (!tools) {
        tools = new Set()
        this.toolIndex.set(word, tools)
      }
      tools.add(tool.toolId)
    }
  }

  removeTool(tool: MCPToolCapability): void {
    const words = this.extractKeywords(tool)
    for (const word of words) {
      const tools = this.toolIndex.get(word)
      if (tools) {
        tools.delete(tool.toolId)
        if (tools.size === 0) {
          this.toolIndex.delete(word)
        }
      }
    }
  }

  findSimilarTools(task: string, tools: MCPToolCapability[], limit = 5): MCPToolCapability[] {
    // 创建模拟的 tool 对象用于提取关键词
    const mockTool: MCPToolCapability = {
      name: task,
      description: task,
      toolId: "",
      serverName: "",
      serverType: "local",
      tags: [],
      suitableTaskTypes: [],
      responseTimes: [],
      successRates: [],
      errorRates: [],
      category: "",
      available: true,
    }
    const taskWords = this.extractKeywords(mockTool)
    
    const scores = new Map<string, number>()

    for (const tool of tools) {
      if (!tool.available) continue

      const toolWords = this.extractKeywords(tool)
      let matchCount = 0

      for (const tw of taskWords) {
        if (toolWords.includes(tw)) {
          matchCount++
        }
      }

      if (matchCount > 0) {
        scores.set(tool.toolId, matchCount / Math.max(taskWords.length, toolWords.length))
      }
    }

    return Array.from(scores.entries())
      .sort((a, b) => b[1] - a[1])
      .slice(0, limit)
      .map(([toolId]) => tools.find(t => t.toolId === toolId)!)
      .filter(Boolean)
  }

  private extractKeywords(tool: MCPToolCapability): string[] {
    const text = [
      tool.name,
      tool.description,
      ...tool.tags,
      ...tool.suitableTaskTypes,
      tool.category,
    ].join(" ").toLowerCase()

    // 简单的分词
    return text
      .replace(/[^a-z0-9\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 2)
  }
}

// ============================================================================
// Task Decomposer - 将复杂任务分解为子任务
// ============================================================================

class TaskDecomposer {
  decompose(task: string): SubTask[] {
    const subtasks: SubTask[] = []

    // 简单的模式匹配分解
    const multiActionPatterns = [
      { pattern: /(\w+)\s+然后\s+(\w+)/, split: 2 },
      { pattern: /(\w+)\s+并且\s+(\w+)/, split: 2 },
      { pattern: /(\w+)\s+再\s+(\w+)/, split: 2 },
      { pattern: /(\w+)\s+接着\s+(\w+)/, split: 2 },
    ]

    for (const { pattern, split } of multiActionPatterns) {
      const match = task.match(pattern)
      if (match) {
        for (let i = 1; i <= split; i++) {
          subtasks.push({
            id: `subtask-${i}`,
            description: match[i],
            requiredCapabilities: this.inferCapabilities(match[i]),
            estimatedComplexity: 1,
            dependencies: i > 1 ? [`subtask-${i - 1}`] : [],
          })
        }
        return subtasks
      }
    }

    // 默认返回单个任务
    subtasks.push({
      id: "main-task",
      description: task,
      requiredCapabilities: this.inferCapabilities(task),
      estimatedComplexity: this.estimateComplexity(task),
      dependencies: [],
    })

    return subtasks
  }

  private inferCapabilities(task: string): string[] {
    const taskLower = task.toLowerCase()
    const capabilities: string[] = []

    const capabilityMap: Record<string, string[]> = {
      search: ["web_search", "code_search", "file_search"],
      read: ["file_read", "resource_read"],
      write: ["file_write", "http_post"],
      execute: ["command_execute", "tool_execute"],
      analyze: ["code_analysis", "data_analysis"],
      debug: ["code_debug", "error_diagnosis"],
      test: ["unit_test", "integration_test"],
      deploy: ["deployment", "cloud_deploy"],
      optimize: ["performance_optimization", "code_optimization"],
    }

    for (const [keyword, caps] of Object.entries(capabilityMap)) {
      if (taskLower.includes(keyword)) {
        capabilities.push(...caps)
      }
    }

    return capabilities
  }

  private estimateComplexity(task: string): number {
    // 简单估算
    let complexity = 1
    if (task.length > 100) complexity += 0.5
    if (task.split(" ").length > 10) complexity += 0.5
    if (/然后|并且|接着|再/.test(task)) complexity += 1
    return Math.min(complexity, 5)
  }
}

// ============================================================================
// Proactive Tool Discoverer - 主动工具发现
// ============================================================================

class ProactiveToolDiscoverer extends EventEmitter {
  private discoverTimer?: NodeJS.Timeout
  private discoveryInterval = 5 * 60 * 1000 // 5分钟

  startPeriodicDiscovery(
    getTools: () => MCPToolCapability[],
    router: MCPSmartRouter,
  ): void {
    this.discoverTimer = setInterval(() => {
      getTools()
      this.discoverAndRegister(router)
    }, this.discoveryInterval)
  }

  stopPeriodicDiscovery(): void {
    if (this.discoverTimer) {
      clearInterval(this.discoverTimer)
      this.discoverTimer = undefined
    }
  }

  private discoverAndRegister(router: MCPSmartRouter): void {
    // 基于使用模式主动发现可能需要的工具
    const recentTasks = router.getRecentTasks(10)

    for (const recentTask of recentTasks) {
      const similarTools = router.findSimilarTools(recentTask, 3)

      for (const tool of similarTools) {
        // 预热工具：更新状态为available
        if (!tool.available) {
          router.updateToolStatus(tool.toolId, true)
          log.info("Proactively enabled tool", {
            toolId: tool.toolId,
            reason: `used in similar task: ${recentTask}`,
          })
        }
      }
    }
  }
}

// ============================================================================
// Main Smart Router Class
// ============================================================================

export class MCPSmartRouter {
  private cfg: MCPRouterConfig
  private tools = new Map<string, MCPToolCapability>()
  private initialized = false
  private semanticMatcher = new ToolSemanticMatcher()
  private taskDecomposer = new TaskDecomposer()
  private proactiveDiscoverer = new ProactiveToolDiscoverer()
  private recentTasks: string[] = []
  private maxRecentTasks = 50

  // Session-aware metrics
  private sessions = new Map<string, SessionMetrics>()

  // Tool warming queue
  private warmingQueue: Set<string> = new Set()
  private isWarmingUp = false

  constructor(cfg: Partial<MCPRouterConfig> = {}) {
    this.cfg = { ...DEFAULT_CONFIG, ...cfg }
  }

  initialize(): void {
    this.tools.clear()
    this.recentTasks = []
    this.initialized = true
    log.info("MCP smart router initialized", { config: this.cfg })
  }

  // Register a tool from MCP server
  registerTool(tool: MCPToolCapability): void {
    if (!this.initialized) {
      this.initialize()
    }

    const toolWithDefaults: MCPToolCapability = {
      ...tool,
      responseTimes: tool.responseTimes ?? [],
      successRates: tool.successRates ?? [],
      errorRates: tool.errorRates ?? [],
      tags: tool.tags ?? [],
      category: tool.category ?? "general",
      available: tool.available ?? true,
    }

    this.tools.set(toolWithDefaults.toolId, toolWithDefaults)
    this.semanticMatcher.indexTool(toolWithDefaults)

    log.info("Registered MCP tool", {
      toolId: toolWithDefaults.toolId,
      name: toolWithDefaults.name,
      server: toolWithDefaults.serverName,
      category: toolWithDefaults.category,
    })
  }

  // Batch register tools
  registerTools(tools: MCPToolCapability[]): void {
    for (const tool of tools) {
      this.registerTool(tool)
    }
  }

  unregisterTool(toolId: string): void {
    const tool = this.tools.get(toolId)
    if (tool) {
      this.semanticMatcher.removeTool(tool)
      this.tools.delete(toolId)
      log.info("Unregistered MCP tool", { toolId })
    }
  }

  // Update tool availability status
  updateToolStatus(toolId: string, available: boolean): void {
    const tool = this.tools.get(toolId)
    if (tool) {
      tool.available = available
      log.info("Updated MCP tool status", { toolId, available })
    }
  }

  // Record tool call result for metrics
  recordToolCall(
    toolId: string,
    success: boolean,
    responseTime: number,
    sessionId?: string,
  ): void {
    const tool = this.tools.get(toolId)
    if (!tool) return

    const timestamp = Date.now()

    // Update tool metrics
    tool.responseTimes.push(responseTime)
    if (tool.responseTimes.length > this.cfg.responseTimeWindowSize) {
      tool.responseTimes.shift()
    }

    tool.successRates.push(success ? 1 : 0)
    if (tool.successRates.length > this.cfg.responseTimeWindowSize) {
      tool.successRates.shift()
    }

    tool.errorRates.push(success ? 0 : 1)
    if (tool.errorRates.length > this.cfg.responseTimeWindowSize) {
      tool.errorRates.shift()
    }

    tool.lastUsed = timestamp
    if (success) {
      tool.lastSuccess = timestamp
    } else {
      tool.lastError = timestamp
    }

    // Update session metrics if provided
    if (sessionId) {
      this.recordSessionMetrics(sessionId, toolId, success, responseTime)
    }

    log.debug("Recorded MCP tool call", {
      toolId,
      success,
      responseTime,
      avgResponseTime: this.getAverageResponseTime(tool),
      successRate: this.getSuccessRate(tool),
    })
  }

  // Record a task for proactive discovery
  recordTask(task: string): void {
    this.recentTasks.push(task)
    if (this.recentTasks.length > this.maxRecentTasks) {
      this.recentTasks.shift()
    }
  }

  getRecentTasks(limit: number): string[] {
    return this.recentTasks.slice(-limit)
  }

  // Main routing function
  selectTool(task: string, _sessionId?: string): RoutingDecision {
    if (!this.initialized || !this.cfg.enabled) {
      return {
        selectedTool: null,
        alternatives: [],
        reason: "Router not initialized or disabled",
        confidence: 0,
        strategy: "direct",
      }
    }

    // Record this task for proactive discovery
    this.recordTask(task)

    // Task decomposition if enabled
    if (this.cfg.taskDecompositionEnabled) {
      const subtasks = this.taskDecomposer.decompose(task)

      if (subtasks.length > 1) {
        return this.handleDecomposedTask(task, subtasks)
      }
    }

    // Direct tool selection
    return this.handleDirectTask(task)
  }

  private handleDirectTask(task: string): RoutingDecision {
    // Find similar tools using semantic matching
    const similarTools = this.semanticMatcher.findSimilarTools(
      task,
      Array.from(this.tools.values()),
      10,
    )

    if (similarTools.length === 0) {
      return {
        selectedTool: null,
        alternatives: [],
        reason: `没有找到适合 "${task}" 的 MCP 工具`,
        confidence: 0,
        strategy: "direct",
      }
    }

    // Score and rank tools
    const scoredTools = this.scoreTools(task, similarTools)
    scoredTools.sort((a, b) => b.score - a.score)

    const selected = scoredTools[0]
    const alternatives = scoredTools.slice(1, 4).map((s) => s.tool)

    // Warm up alternatives in background
    if (this.cfg.toolWarmingEnabled && alternatives.length > 0) {
      this.warmupTools(alternatives.map((t) => t.toolId))
    }

    let reason = ""
    if (selected.tool.available) {
      reason = `选择 ${selected.tool.name}: 匹配度 ${(selected.score * 100).toFixed(0)}%, ` +
        `历史成功率 ${(this.getSuccessRate(selected.tool) * 100).toFixed(0)}%, ` +
        `平均响应 ${this.getAverageResponseTime(selected.tool).toFixed(0)}ms`
    } else {
      reason = `首选工具 ${selected.tool.name} 不可用，使用备选`
    }

    return {
      selectedTool: selected.tool.available ? selected.tool : (alternatives[0] ?? null),
      alternatives,
      reason,
      confidence: selected.score,
      strategy: selected.tool.available ? "direct" : "fallback",
    }
  }

  private handleDecomposedTask(_task: string, subtasks: SubTask[]): RoutingDecision {
    const toolSelections: MCPToolCapability[] = []
    const failedSubtasks: SubTask[] = []

    for (const subtask of subtasks) {
      const decision = this.handleDirectTask(subtask.description)

      if (decision.selectedTool) {
        toolSelections.push(decision.selectedTool)
      } else {
        failedSubtasks.push(subtask)
      }
    }

    if (failedSubtasks.length > 0) {
      log.warn("Some subtasks could not be routed", {
        failed: failedSubtasks.map((t) => t.description),
      })
    }

    return {
      selectedTool: toolSelections[0] ?? null,
      alternatives: toolSelections.slice(1),
      reason: `任务分解为 ${subtasks.length} 个子任务，成功路由 ${toolSelections.length} 个`,
      confidence: toolSelections.length / subtasks.length,
      strategy: "decomposed",
      subtasks,
    }
  }

  private scoreTools(task: string, tools: MCPToolCapability[]): Array<{ tool: MCPToolCapability; score: number }> {
    const taskLower = task.toLowerCase()

    return tools.map((tool) => {
      let score = 0

      // Semantic similarity (40%)
      const semanticScore = this.calculateSemanticScore(taskLower, tool)
      score += semanticScore * 0.4

      // Success rate (30%)
      const successRate = this.getSuccessRate(tool)
      score += successRate * 0.3

      // Availability (20%)
      if (tool.available) {
        score += 0.2
      }

      // Recency bonus (10%)
      if (tool.lastUsed) {
        const hoursSinceLastUse = (Date.now() - tool.lastUsed) / (1000 * 60 * 60)
        if (hoursSinceLastUse < 1) {
          score += 0.1
        } else if (hoursSinceLastUse < 24) {
          score += 0.05
        }
      }

      return { tool, score }
    })
  }

  private calculateSemanticScore(task: string, tool: MCPToolCapability): number {
    // 简单的关键词匹配
    const taskWords = task.toLowerCase().split(/\s+/)
    const toolWords = [
      tool.name.toLowerCase(),
      tool.description.toLowerCase(),
      ...tool.tags,
      ...tool.suitableTaskTypes,
      tool.category.toLowerCase(),
    ].join(" ").split(/\s+/)

    let matchCount = 0
    for (const tw of taskWords) {
      if (tw.length < 3) continue
      if (toolWords.some((w) => w.includes(tw) || tw.includes(w))) {
        matchCount++
      }
    }

    return taskWords.length > 0 ? matchCount / taskWords.length : 0
  }

  private getAverageResponseTime(tool: MCPToolCapability): number {
    if (tool.responseTimes.length === 0) return 5000
    return tool.responseTimes.reduce((a, b) => a + b, 0) / tool.responseTimes.length
  }

  private getSuccessRate(tool: MCPToolCapability): number {
    if (tool.successRates.length === 0) return 0.8
    return tool.successRates.reduce((a, b) => a + b, 0) / tool.successRates.length
  }

  // Find similar tools for a task
  findSimilarTools(task: string, limit = 5): MCPToolCapability[] {
    return this.semanticMatcher.findSimilarTools(
      task,
      Array.from(this.tools.values()),
      limit,
    )
  }

  // Warm up tools in background
  private warmupTools(toolIds: string[]): void {
    for (const toolId of toolIds) {
      if (this.warmingQueue.has(toolId)) continue
      this.warmingQueue.add(toolId)
    }

    if (this.isWarmingUp || this.warmingQueue.size === 0) return

    this.isWarmingUp = true

    // Simulate warming - in real implementation this would pre-connect
    setTimeout(() => {
      for (const toolId of this.warmingQueue) {
        const tool = this.tools.get(toolId)
        if (tool && !tool.available) {
          tool.available = true
          log.info("Warmed up tool", { toolId })
        }
      }
      this.warmingQueue.clear()
      this.isWarmingUp = false
    }, 100)
  }

  // Session management
  startSession(sessionId: string): void {
    this.sessions.set(sessionId, {
      sessionId,
      toolInvocations: [],
      totalTokens: 0,
      totalDuration: 0,
      successCount: 0,
      errorCount: 0,
      startTime: Date.now(),
    })
    log.info("Started router session", { sessionId })
  }

  endSession(sessionId: string): SessionMetrics | undefined {
    const metrics = this.sessions.get(sessionId)
    if (metrics) {
      this.sessions.delete(sessionId)
      log.info("Ended router session", {
        sessionId,
        duration: Date.now() - metrics.startTime,
        successCount: metrics.successCount,
        errorCount: metrics.errorCount,
      })
    }
    return metrics
  }

  private recordSessionMetrics(
    sessionId: string,
    toolId: string,
    success: boolean,
    duration: number,
  ): void {
    const metrics = this.sessions.get(sessionId)
    if (!metrics) return

    metrics.toolInvocations.push({
      toolId,
      arguments: {},
      startTime: Date.now() - duration,
      endTime: Date.now(),
      success,
    })

    if (success) {
      metrics.successCount++
    } else {
      metrics.errorCount++
    }

    metrics.totalDuration += duration
  }

  // Get all tools
  getAllTools(): MCPToolCapability[] {
    return Array.from(this.tools.values())
  }

  // Get available tools
  getAvailableTools(): MCPToolCapability[] {
    return Array.from(this.tools.values()).filter((t) => t.available)
  }

  // Get tools by server
  getToolsByServer(serverName: string): MCPToolCapability[] {
    return Array.from(this.tools.values()).filter((t) => t.serverName === serverName)
  }

  // Get tools by category
  getToolsByCategory(category: string): MCPToolCapability[] {
    return Array.from(this.tools.values()).filter((t) => t.category === category)
  }

  // Get router statistics
  getStats(): {
    totalTools: number
    availableTools: number
    averageSuccessRate: number
    averageResponseTime: number
    sessions: number
  } {
    const tools = Array.from(this.tools.values())
    const available = tools.filter((t) => t.available)

    const totalSuccessRate = tools.reduce((sum, t) => sum + this.getSuccessRate(t), 0)
    const totalResponseTime = tools.reduce((sum, t) => sum + this.getAverageResponseTime(t), 0)

    return {
      totalTools: tools.length,
      availableTools: available.length,
      averageSuccessRate: tools.length > 0 ? totalSuccessRate / tools.length : 0,
      averageResponseTime: tools.length > 0 ? totalResponseTime / tools.length : 0,
      sessions: this.sessions.size,
    }
  }

  // Clear router state
  clear(): void {
    this.tools.clear()
    this.recentTasks = []
    this.sessions.clear()
    this.initialized = false
    this.proactiveDiscoverer.stopPeriodicDiscovery()
    log.info("Cleared MCP router")
  }

  // Update configuration
  updateConfig(cfg: Partial<MCPRouterConfig>): void {
    this.cfg = { ...this.cfg, ...cfg }
    log.info("Updated router config", { config: this.cfg })
  }
}

// ============================================================================
// Router Manager - Manages multiple router instances
// ============================================================================

class MCPRouterManager {
  private routers = new Map<string, MCPSmartRouter>()

  getOrCreate(instanceId: string): MCPSmartRouter {
    let router = this.routers.get(instanceId)
    if (!router) {
      router = new MCPSmartRouter()
      router.initialize()
      this.routers.set(instanceId, router)
      log.info("Created new router instance", { instanceId })
    }
    return router
  }

  remove(instanceId: string): void {
    const router = this.routers.get(instanceId)
    if (router) {
      router.clear()
      this.routers.delete(instanceId)
      log.info("Removed router instance", { instanceId })
    }
  }

  getGlobal(): MCPSmartRouter {
    return this.getOrCreate("_global_")
  }

  getAllInstances(): string[] {
    return Array.from(this.routers.keys())
  }

  clear(): void {
    for (const router of this.routers.values()) {
      router.clear()
    }
    this.routers.clear()
    log.info("Cleared all router instances")
  }

  getAllStats(): Record<string, ReturnType<MCPSmartRouter["getStats"]>> {
    const stats: Record<string, any> = {}
    for (const [id, router] of this.routers.entries()) {
      stats[id] = router.getStats()
    }
    return stats
  }
}

// Export singleton
export const globalMCPRouterManager = new MCPRouterManager()

// Convenience functions
export function getMCPRouter(instanceId: string): MCPSmartRouter {
  return globalMCPRouterManager.getOrCreate(instanceId)
}

export function getGlobalMCPRouter(): MCPSmartRouter {
  return globalMCPRouterManager.getGlobal()
}
