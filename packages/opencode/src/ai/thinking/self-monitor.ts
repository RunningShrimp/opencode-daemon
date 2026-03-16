import { z } from "zod"

export enum AgentState {
  IDLE = "idle",
  THINKING = "thinking",
  SENSING = "sensing",
  PERCEIVING = "perceiving",
  PLANNING = "planning",
  EXECUTING = "executing",
  WAITING = "waiting",
  WAITING_FOR_INPUT = "waiting_for_input",
  REFLECTING = "reflecting",
  LEARNING = "learning",
  ADAPTING = "adapting",
  BLOCKED = "blocked",
  ERROR = "error",
}

export enum PerformanceLevel {
  EXCELLENT = "excellent",
  GOOD = "good",
  AVERAGE = "average",
  POOR = "poor",
  CRITICAL = "critical",
}

export const AgentSelfState = z.object({
  currentState: z.nativeEnum(AgentState),
  previousState: z.nativeEnum(AgentState).optional(),
  stateDuration: z.number(),
  totalSteps: z.number(),
  currentStep: z.number(),
  confidence: z.number().min(0).max(1),
  energy: z.number().min(0).max(1),
  focusLevel: z.number().min(0).max(1),
  errorCount: z.number(),
  successCount: z.number(),
  consecutiveErrors: z.number(),
  lastError: z.string().optional(),
  lastSuccess: z.string().optional(),
  timestamp: z.number(),
})

export type AgentSelfState = z.infer<typeof AgentSelfState>

export const BehavioralMetrics = z.object({
  toolCallPattern: z.record(z.string(), z.number()),
  averageResponseTime: z.number(),
  contextUtilization: z.number(),
  reasoningDepth: z.number(),
  selfCorrectionRate: z.number(),
  goalAdaptationCount: z.number(),
  reflectionFrequency: z.number(),
  evidenceCollectionRate: z.number(),
  timestamp: z.number(),
})

export type BehavioralMetrics = z.infer<typeof BehavioralMetrics>

export const SelfMonitoringConfig = z.object({
  enableStateTracking: z.boolean().default(true),
  enableMetricsCollection: z.boolean().default(true),
  enablePerformanceAlert: z.boolean().default(true),
  enableAnomalyDetection: z.boolean().default(true),
  stateChangeThreshold: z.number().default(0.3),
  performanceAlertThreshold: z.number().default(0.5),
  reflectionTriggerConditions: z
    .array(
      z.object({
        condition: z.string(),
        severity: z.enum(["low", "medium", "high"]),
      }),
    )
    .optional(),
})

export type SelfMonitoringConfig = z.infer<typeof SelfMonitoringConfig>

export interface SelfMonitoringData {
  state: AgentSelfState
  metrics: BehavioralMetrics
  alerts: MonitoringAlert[]
  anomalies: AnomalyRecord[]
}

export const MonitoringAlert = z.object({
  id: z.string(),
  type: z.enum(["performance", "behavior", "state", "error"]),
  severity: z.enum(["low", "medium", "high", "critical"]),
  message: z.string(),
  timestamp: z.number(),
  relatedMetric: z.string().optional(),
  suggestedAction: z.string().optional(),
})

export type MonitoringAlert = z.infer<typeof MonitoringAlert>

export const AnomalyRecord = z.object({
  id: z.string(),
  type: z.string(),
  description: z.string(),
  detectedAt: z.number(),
  severity: z.enum(["low", "medium", "high", "critical"]),
  resolved: z.boolean().default(false),
  resolution: z.string().optional(),
})

export type AnomalyRecord = z.infer<typeof AnomalyRecord>

export class SelfMonitor {
  private state: AgentSelfState
  private metrics: BehavioralMetrics
  private alerts: MonitoringAlert[] = []
  private anomalies: AnomalyRecord[] = []
  private stateHistory: AgentSelfState[] = []
  private metricsHistory: BehavioralMetrics[] = []
  private config: SelfMonitoringConfig

  constructor(config?: Partial<SelfMonitoringConfig>) {
    this.config = {
      enableStateTracking: config?.enableStateTracking ?? true,
      enableMetricsCollection: config?.enableMetricsCollection ?? true,
      enablePerformanceAlert: config?.enablePerformanceAlert ?? true,
      enableAnomalyDetection: config?.enableAnomalyDetection ?? true,
      stateChangeThreshold: config?.stateChangeThreshold ?? 0.3,
      performanceAlertThreshold: config?.performanceAlertThreshold ?? 0.5,
    }

    const now = Date.now()
    this.state = {
      currentState: AgentState.IDLE,
      stateDuration: 0,
      totalSteps: 0,
      currentStep: 0,
      confidence: 0.8,
      energy: 1.0,
      focusLevel: 1.0,
      errorCount: 0,
      successCount: 0,
      consecutiveErrors: 0,
      timestamp: now,
    }

    this.metrics = {
      toolCallPattern: {},
      averageResponseTime: 0,
      contextUtilization: 0,
      reasoningDepth: 0,
      selfCorrectionRate: 0,
      goalAdaptationCount: 0,
      reflectionFrequency: 0,
      evidenceCollectionRate: 0,
      timestamp: now,
    }
  }

  transitionState(newState: AgentState): void {
    if (this.config.enableStateTracking) {
      this.state.previousState = this.state.currentState
      this.state.currentState = newState
      this.state.stateDuration = 0
      this.recordStateHistory()
    }
  }

  incrementStep(): void {
    this.state.currentStep++
    this.state.totalSteps++
  }

  recordSuccess(action: string): void {
    this.state.successCount++
    this.state.consecutiveErrors = 0
    this.state.energy = Math.min(1.0, this.state.energy + 0.05)
    this.state.lastSuccess = action
    this.updateConfidence(0.02)
  }

  recordError(error: string): void {
    this.state.errorCount++
    this.state.consecutiveErrors++
    this.state.lastError = error
    this.state.energy = Math.max(0, this.state.energy - 0.1)
    this.updateConfidence(-0.05)

    if (this.config.enableAnomalyDetection) {
      this.detectAnomaly("error_surge", "Consecutive errors increasing", "medium")
    }
  }

  private updateConfidence(delta: number): void {
    this.state.confidence = Math.max(0, Math.min(1, this.state.confidence + delta))
  }

  updateFocus(level: number): void {
    this.state.focusLevel = Math.max(0, Math.min(1, level))
  }

  recordToolCall(toolName: string, duration: number): void {
    if (this.config.enableMetricsCollection) {
      this.metrics.toolCallPattern[toolName] = (this.metrics.toolCallPattern[toolName] || 0) + 1

      const prevAvg = this.metrics.averageResponseTime
      const count = this.state.totalSteps
      this.metrics.averageResponseTime = prevAvg + (duration - prevAvg) / count
    }
  }

  recordReflection(): void {
    this.metrics.reflectionFrequency++
  }

  recordEvidenceCollection(): void {
    this.metrics.evidenceCollectionRate++
  }

  recordSelfCorrection(): void {
    this.metrics.selfCorrectionRate++
  }

  recordGoalAdaptation(): void {
    this.metrics.goalAdaptationCount++
  }

  updateContextUtilization(utilization: number): void {
    this.metrics.contextUtilization = Math.max(0, Math.min(1, utilization))
  }

  updateReasoningDepth(depth: number): void {
    this.metrics.reasoningDepth = depth
  }

  private recordStateHistory(): void {
    this.stateHistory.push({ ...this.state })
    if (this.stateHistory.length > 100) {
      this.stateHistory.shift()
    }
  }

  recordMetricsSnapshot(): void {
    this.metrics.timestamp = Date.now()
    this.metricsHistory.push({ ...this.metrics })
    if (this.metricsHistory.length > 50) {
      this.metricsHistory.shift()
    }
  }

  private detectAnomaly(type: string, description: string, severity: "low" | "medium" | "high" | "critical"): void {
    const anomaly: AnomalyRecord = {
      id: `anomaly-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
      type,
      description,
      detectedAt: Date.now(),
      severity,
      resolved: false,
    }
    this.anomalies.push(anomaly)

    if (this.config.enablePerformanceAlert && (severity === "high" || severity === "critical")) {
      this.createAlert({
        id: anomaly.id,
        type: "behavior",
        severity,
        message: `Anomaly detected: ${description}`,
        timestamp: Date.now(),
        relatedMetric: type,
      })
    }
  }

  private createAlert(alert: MonitoringAlert): void {
    this.alerts.push(alert)
    if (this.alerts.length > 20) {
      this.alerts.shift()
    }
  }

  getState(): AgentSelfState {
    return { ...this.state }
  }

  getMetrics(): BehavioralMetrics {
    return { ...this.metrics }
  }

  getAlerts(): MonitoringAlert[] {
    return [...this.alerts]
  }

  getAnomalies(): AnomalyRecord[] {
    return [...this.anomalies]
  }

  getStateHistory(): AgentSelfState[] {
    return [...this.stateHistory]
  }

  getMetricsHistory(): BehavioralMetrics[] {
    return [...this.metricsHistory]
  }

  shouldReflect(): boolean {
    return (
      this.state.consecutiveErrors >= 2 ||
      this.state.confidence < 0.5 ||
      this.state.energy < 0.3 ||
      this.state.focusLevel < 0.4
    )
  }

  shouldRequestHelp(): boolean {
    return this.state.consecutiveErrors >= 3 || this.state.energy < 0.2 || this.state.confidence < 0.3
  }

  getPerformanceLevel(): PerformanceLevel {
    const successRate = this.state.totalSteps > 0 ? this.state.successCount / this.state.totalSteps : 0
    const errorRate = this.state.totalSteps > 0 ? this.state.errorCount / this.state.totalSteps : 1

    if (successRate >= 0.9 && errorRate < 0.1) return PerformanceLevel.EXCELLENT
    if (successRate >= 0.7 && errorRate < 0.3) return PerformanceLevel.GOOD
    if (successRate >= 0.5 && errorRate < 0.5) return PerformanceLevel.AVERAGE
    if (successRate >= 0.3 && errorRate < 0.7) return PerformanceLevel.POOR
    return PerformanceLevel.CRITICAL
  }

  needsCompaction(): boolean {
    return this.metrics.contextUtilization > 0.9
  }

  getSelfMonitoringData(): SelfMonitoringData {
    return {
      state: this.getState(),
      metrics: this.getMetrics(),
      alerts: this.getAlerts(),
      anomalies: this.getAnomalies(),
    }
  }

  getDiagnosticReport(): string {
    const state = this.getState()
    const metrics = this.getMetrics()
    const performance = this.getPerformanceLevel()

    return `
## Agent Self-Diagnostic Report

### Current State
- State: ${state.currentState}
- Step: ${state.currentStep}/${state.totalSteps}
- Confidence: ${(state.confidence * 100).toFixed(1)}%
- Energy: ${(state.energy * 100).toFixed(1)}%
- Focus: ${(state.focusLevel * 100).toFixed(1)}%

### Performance Metrics
- Performance Level: ${performance}
- Success Rate: ${state.totalSteps > 0 ? ((state.successCount / state.totalSteps) * 100).toFixed(1) : 0}%
- Error Count: ${state.errorCount}
- Consecutive Errors: ${state.consecutiveErrors}
- Self-Correction Rate: ${((metrics.selfCorrectionRate / Math.max(1, state.totalSteps)) * 100).toFixed(1)}%
- Reflection Frequency: ${metrics.reflectionFrequency}
- Avg Response Time: ${metrics.averageResponseTime.toFixed(2)}ms

### Active Alerts
${this.alerts.length > 0 ? this.alerts.map((a) => `- [${a.severity}] ${a.message}`).join("\n") : "None"}

### Unresolved Anomalies
${
  this.anomalies.filter((a) => !a.resolved).length > 0
    ? this.anomalies
        .filter((a) => !a.resolved)
        .map((a) => `- [${a.severity}] ${a.description}`)
        .join("\n")
    : "None"
}
`
  }
}
