import { Log } from "@/util/log"

const log = Log.create({ service: "tool-effectiveness" })

export interface ToolEffectivenessConfig {
  enabled: boolean
  historySize: number
  minRecordsForRecommendation: number
  successRateWeight: number
  executionTimeWeight: number
}

const DEFAULT_CONFIG: ToolEffectivenessConfig = {
  enabled: true,
  historySize: 50,
  minRecordsForRecommendation: 5,
  successRateWeight: 0.7,
  executionTimeWeight: 0.3,
}

interface ToolExecutionRecord {
  toolName: string
  taskType: string
  success: boolean
  duration: number
  timestamp: number
  error?: string
}

interface ToolEffectivenessStats {
  toolName: string
  totalExecutions: number
  successCount: number
  failureCount: number
  successRate: number
  avgDuration: number
  minDuration: number
  maxDuration: number
  lastExecuted: number
  taskTypes: Set<string>
}

export interface ToolRecommendation {
  toolName: string
  score: number
  successRate: number
  avgDuration: number
  reason: string
}

export class ToolEffectivenessTracker {
  private cfg: ToolEffectivenessConfig
  private records: ToolExecutionRecord[] = []
  private stats = new Map<string, ToolEffectivenessStats>()
  private initialized = false

  constructor(cfg: Partial<ToolEffectivenessConfig> = {}) {
    this.cfg = { ...DEFAULT_CONFIG, ...cfg }
  }

  initialize(): void {
    this.records = []
    this.stats.clear()
    this.initialized = true
    log.info("Tool effectiveness tracker initialized")
  }

  recordExecution(toolName: string, taskType: string, success: boolean, duration: number, error?: string): void {
    if (!this.initialized || !this.cfg.enabled) return

    const record: ToolExecutionRecord = {
      toolName,
      taskType,
      success,
      duration,
      timestamp: Date.now(),
      error,
    }

    this.records.push(record)

    if (this.records.length > this.cfg.historySize) {
      this.records.shift()
    }

    this.updateStats(record)

    log.debug("Recorded tool execution", {
      tool: toolName,
      success,
      duration,
      taskType,
    })
  }

  private updateStats(record: ToolExecutionRecord): void {
    const { toolName, success, duration, taskType } = record

    let stats = this.stats.get(toolName)
    if (!stats) {
      stats = {
        toolName,
        totalExecutions: 0,
        successCount: 0,
        failureCount: 0,
        successRate: 0,
        avgDuration: 0,
        minDuration: duration,
        maxDuration: duration,
        lastExecuted: record.timestamp,
        taskTypes: new Set(),
      }
      this.stats.set(toolName, stats)
    }

    stats.totalExecutions++
    if (success) {
      stats.successCount++
    } else {
      stats.failureCount++
    }

    stats.successRate = stats.successCount / stats.totalExecutions

    stats.avgDuration = (stats.avgDuration * (stats.totalExecutions - 1) + duration) / stats.totalExecutions
    stats.minDuration = Math.min(stats.minDuration, duration)
    stats.maxDuration = Math.max(stats.maxDuration, duration)

    stats.lastExecuted = record.timestamp

    stats.taskTypes.add(taskType)
  }

  recommendTools(availableTools: string[], taskType: string): ToolRecommendation[] {
    if (!this.initialized || !this.cfg.enabled || availableTools.length === 0) {
      return []
    }

    const recommendations: ToolRecommendation[] = []

    for (const toolName of availableTools) {
      const stats = this.stats.get(toolName)

      if (!stats || stats.totalExecutions < this.cfg.minRecordsForRecommendation) {
        recommendations.push({
          toolName,
          score: 0.5,
          successRate: 0.5,
          avgDuration: 5000,
          reason: "无足够历史数据",
        })
        continue
      }

      const successScore = stats.successRate * this.cfg.successRateWeight

      const maxExpectedDuration = 30000
      const timeScore = Math.max(0, 1 - stats.avgDuration / maxExpectedDuration) * this.cfg.executionTimeWeight

      const taskTypeMatch = stats.taskTypes.has(taskType) ? 0.1 : 0

      const score = successScore + timeScore + taskTypeMatch

      let reason = `成功率 ${(stats.successRate * 100).toFixed(0)}%`
      if (stats.avgDuration < 2000) {
        reason += `, 执行快速 (${stats.avgDuration.toFixed(0)}ms)`
      }
      if (stats.taskTypes.has(taskType)) {
        reason += `, 适合 ${taskType} 任务`
      }

      recommendations.push({
        toolName,
        score,
        successRate: stats.successRate,
        avgDuration: stats.avgDuration,
        reason,
      })
    }

    recommendations.sort((a, b) => b.score - a.score)

    return recommendations
  }

  getToolStats(toolName: string): ToolEffectivenessStats | null {
    return this.stats.get(toolName) ?? null
  }

  getAllStats(): Map<string, ToolEffectivenessStats> {
    return new Map(this.stats)
  }

  getRecentRecords(limit: number = 10): ToolExecutionRecord[] {
    return this.records.slice(-limit)
  }

  clearTool(toolName: string): void {
    this.records = this.records.filter((r) => r.toolName !== toolName)
    this.stats.delete(toolName)
  }

  clear(): void {
    this.records = []
    this.stats.clear()
    this.initialized = false
  }
}

class ToolEffectivenessManager {
  private trackers = new Map<string, ToolEffectivenessTracker>()

  getOrCreate(sessionId: string): ToolEffectivenessTracker {
    let tracker = this.trackers.get(sessionId)
    if (!tracker) {
      tracker = new ToolEffectivenessTracker()
      tracker.initialize()
      this.trackers.set(sessionId, tracker)
    }
    return tracker
  }

  remove(sessionId: string): void {
    const tracker = this.trackers.get(sessionId)
    if (tracker) {
      tracker.clear()
      this.trackers.delete(sessionId)
    }
  }

  clear(): void {
    for (const tracker of this.trackers.values()) {
      tracker.clear()
    }
    this.trackers.clear()
  }

  getGlobal(): ToolEffectivenessTracker {
    return this.getOrCreate("_global_")
  }
}

export const globalToolEffectivenessManager = new ToolEffectivenessManager()

export function getToolEffectivenessTracker(sessionId: string): ToolEffectivenessTracker {
  return globalToolEffectivenessManager.getOrCreate(sessionId)
}

export function getGlobalToolStats(): Map<string, ToolEffectivenessStats> {
  return globalToolEffectivenessManager.getGlobal().getAllStats()
}
