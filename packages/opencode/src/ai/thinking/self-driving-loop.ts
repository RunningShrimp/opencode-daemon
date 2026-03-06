import { SelfMonitor, AgentState } from "./self-monitor"
import { MetacognitionEngine } from "./metacognition"
import { GoalManager, GoalStatus, GoalPriority } from "./goal-manager"
import type { Goal } from "./goal-manager"
import type { ContextualLearning } from "./experience-learning"
import { ExperienceLearning } from "./experience-learning"
import type { Hypothesis } from "./evidence"
import type { TaskIntent } from "./intent"

export enum LoopPhase {
  SENSING = "sensing",
  PERCEIVING = "perceiving",
  PLANNING = "planning",
  ACTING = "acting",
  REFLECTING = "reflecting",
  LEARNING = "learning",
  ADAPTING = "adapting",
}

export interface LoopDecision {
  phase: LoopPhase
  action: string
  reasoning: string
  confidence: number
  expectedOutcome: string
}

export interface SelfDrivingConfig {
  enableAutonomousGoalSetting: boolean
  enableAutomaticReflection: boolean
  enableAdaptiveStrategy: boolean
  enableExperienceLearning: boolean
  enableProactiveActions: boolean
  reflectionInterval: number
  adaptationThreshold: number
  confidenceThreshold: number
}

export const DEFAULT_SELF_DRIVING_CONFIG: SelfDrivingConfig = {
  enableAutonomousGoalSetting: true,
  enableAutomaticReflection: true,
  enableAdaptiveStrategy: true,
  enableExperienceLearning: true,
  enableProactiveActions: true,
  reflectionInterval: 5,
  adaptationThreshold: 0.4,
  confidenceThreshold: 0.5,
}

export interface LoopState {
  phase: LoopPhase
  stepCount: number
  phaseDuration: number
  currentGoal: Goal | null
  activeHypotheses: Hypothesis[]
  pendingDecisions: LoopDecision[]
  context: Record<string, unknown>
  lastReflection: number
  consecutiveSamePhase: number
}

export class SelfDrivingLoop {
  private monitor: SelfMonitor
  private metacognition: MetacognitionEngine
  private goalManager: GoalManager
  private experienceLearning: ExperienceLearning
  private config: SelfDrivingConfig
  private loopState: LoopState
  private stepCount: number = 0
  private decisionHistory: LoopDecision[] = []

  constructor(config?: Partial<SelfDrivingConfig>) {
    this.config = { ...DEFAULT_SELF_DRIVING_CONFIG, ...config }
    this.monitor = new SelfMonitor()
    this.metacognition = new MetacognitionEngine(this.monitor)
    this.goalManager = new GoalManager()
    this.experienceLearning = new ExperienceLearning()
    this.loopState = {
      phase: LoopPhase.SENSING,
      stepCount: 0,
      phaseDuration: 0,
      currentGoal: null,
      activeHypotheses: [],
      pendingDecisions: [],
      context: {},
      lastReflection: 0,
      consecutiveSamePhase: 0,
    }
  }

  async initialize(userInput: string, intent: TaskIntent): Promise<void> {
    this.monitor.transitionState(AgentState.THINKING)
    this.loopState.context = {
      userInput,
      taskType: intent.type,
      timestamp: Date.now(),
    }
    if (this.config.enableAutonomousGoalSetting) {
      const goal = this.goalManager.createGoal({
        title: this.extractGoalTitle(intent),
        description: this.generateGoalDescription(intent, userInput),
        priority: this.determinePriority(intent),
        estimatedSteps: this.estimateSteps(intent),
        successCriteria: this.generateSuccessCriteria(intent),
      })
      this.loopState.currentGoal = goal
      this.goalManager.activateGoal(goal.id)
    }
  }

  private extractGoalTitle(intent: TaskIntent): string {
    switch (intent.type) {
      case "implementation":
        return `Implement: ${intent.description}`
      case "review":
        return `Review: ${intent.target} (${intent.scope} scope)`
      case "exploration":
        return `Explore: ${intent.query}`
      case "debugging":
        return `Debug: ${intent.error}`
      default:
        return "Process user request"
    }
  }

  private generateGoalDescription(intent: TaskIntent, userInput: string): string {
    return `${intent.type} - ${userInput}`
  }

  private determinePriority(intent: TaskIntent): GoalPriority {
    if (intent.type === "debugging") return GoalPriority.CRITICAL
    if (intent.type === "implementation" && intent.complexity === "complex") return GoalPriority.HIGH
    return GoalPriority.MEDIUM
  }

  private estimateSteps(intent: TaskIntent): number {
    switch (intent.type) {
      case "implementation":
        return intent.complexity === "simple" ? 3 : intent.complexity === "moderate" ? 8 : 15
      case "review":
        return 5
      case "exploration":
        return 3
      case "debugging":
        return 6
      default:
        return 5
    }
  }

  private generateSuccessCriteria(intent: TaskIntent): string[] {
    const criteria: string[] = []
    switch (intent.type) {
      case "implementation":
        criteria.push("Code implementation complete", "Basic tests pass", "No syntax errors")
        if (intent.complexity === "complex") {
          criteria.push("Includes error handling", "Includes documentation")
        }
        break
      case "review":
        criteria.push("All issues identified", "Fix suggestions provided", "Sorted by severity")
        break
      case "exploration":
        criteria.push("Relevant information returned", "Specific references included")
        break
      case "debugging":
        criteria.push("Root cause identified", "Solution provided", "Fix verified")
        break
    }
    return criteria
  }

  async sense(): Promise<LoopPhase> {
    this.monitor.transitionState(AgentState.THINKING)
    this.loopState.phase = LoopPhase.SENSING
    const state = this.monitor.getState()
    if (state.consecutiveErrors >= 3 || state.confidence < 0.3) {
      this.recordDecision({
        phase: LoopPhase.SENSING,
        action: "request_help",
        reasoning: "Consecutive errors and low confidence indicate need for human help",
        confidence: 0.9,
        expectedOutcome: "Get user guidance",
      })
    }
    if (this.monitor.needsCompaction()) {
      this.recordDecision({
        phase: LoopPhase.SENSING,
        action: "trigger_compaction",
        reasoning: "Context utilization too high",
        confidence: 0.95,
        expectedOutcome: "Free up context space",
      })
    }
    return LoopPhase.SENSING
  }

  async perceive(context: Record<string, unknown>): Promise<LoopPhase> {
    this.loopState.context = { ...this.loopState.context, ...context }
    this.loopState.phase = LoopPhase.PERCEIVING
    if (this.config.enableExperienceLearning) {
      const contextualLearning: ContextualLearning = {
        taskType: context.taskType as string,
        complexity: context.complexity as "simple" | "moderate" | "complex",
      }
      const relevantPatterns = this.experienceLearning.getRelevantPatterns(contextualLearning)
      if (relevantPatterns.length > 0) {
        this.recordDecision({
          phase: LoopPhase.PERCEIVING,
          action: "apply_learned_pattern",
          reasoning: `Found ${relevantPatterns.length} relevant patterns`,
          confidence: relevantPatterns[0].successRate,
          expectedOutcome: "Leverage existing experience to accelerate task",
        })
      }
    }
    return LoopPhase.PERCEIVING
  }

  async plan(): Promise<LoopPhase> {
    this.monitor.transitionState(AgentState.THINKING)
    this.loopState.phase = LoopPhase.PLANNING
    const taskType = (this.loopState.context.taskType as string) ?? "unknown"
    const strategy = this.metacognition.selectReasoningStrategy(taskType)
    if (this.loopState.currentGoal) {
      this.goalManager.startGoal(this.loopState.currentGoal.id)
      const activeGoals = this.goalManager.getActiveGoals()
      if (activeGoals.length > 1) {
        const decomposition = this.goalManager.decomposeGoal(
          this.loopState.currentGoal.id,
          this.generateSubTaskDescriptions(),
        )
        this.recordDecision({
          phase: LoopPhase.PLANNING,
          action: "decompose_goal",
          reasoning: `Decomposed into ${decomposition.mainGoals.length} sub-goals`,
          confidence: 0.8,
          expectedOutcome: "Clearer task execution path",
        })
      }
    }
    this.recordDecision({
      phase: LoopPhase.PLANNING,
      action: "select_strategy",
      reasoning: `Selected reasoning strategy: ${strategy}`,
      confidence: 0.7,
      expectedOutcome: "Effective task execution",
    })
    return LoopPhase.PLANNING
  }

  private generateSubTaskDescriptions(): string[] {
    const taskType = this.loopState.context.taskType as string
    switch (taskType) {
      case "implementation":
        return ["Understand requirements", "Implement core functionality", "Add tests", "Verify implementation"]
      case "review":
        return ["Collect code information", "Analyze potential issues", "Generate review report"]
      case "exploration":
        return ["Analyze query", "Search for relevant information", "Organize results"]
      case "debugging":
        return ["Reproduce issue", "Locate root cause", "Formulate fix plan", "Verify fix"]
      default:
        return ["Analyze task", "Execute main steps", "Verify results"]
    }
  }

  async act(toolName: string, _input: Record<string, unknown>): Promise<void> {
    this.monitor.transitionState(AgentState.EXECUTING)
    this.loopState.phase = LoopPhase.ACTING
    this.monitor.incrementStep()
    if (this.loopState.currentGoal) {
      this.goalManager.incrementStep(this.loopState.currentGoal.id)
    }
    const startTime = Date.now()
    try {
      this.recordDecision({
        phase: LoopPhase.ACTING,
        action: `execute_${toolName}`,
        reasoning: `Executing tool: ${toolName}`,
        confidence: this.monitor.getState().confidence,
        expectedOutcome: "Get tool execution result",
      })
    } finally {
      const duration = Date.now() - startTime
      this.monitor.recordToolCall(toolName, duration)
    }
    this.stepCount++
  }

  onToolResult(success: boolean, result?: string): void {
    if (success) {
      this.monitor.recordSuccess(`tool:${result ?? "unknown"}`)
      this.metacognition.recordStrategySuccess(
        this.metacognition.selectReasoningStrategy(this.loopState.context.taskType as string),
      )
      if (this.config.enableExperienceLearning) {
        this.experienceLearning.recordExperience({
          situation: this.loopState.context.taskType as string,
          action: "Execute tool",
          outcome: success ? "Success" : "Failure",
          context: this.loopState.context,
          success,
          tags: ["tool-execution", success ? "success" : "failure"],
        })
      }
    } else {
      this.monitor.recordError(`tool:${result ?? "unknown"}`)
      this.metacognition.recordStrategyFailure(
        this.metacognition.selectReasoningStrategy(this.loopState.context.taskType as string),
      )
    }
  }

  async reflect(): Promise<void> {
    this.monitor.transitionState(AgentState.REFLECTING)
    this.loopState.phase = LoopPhase.REFLECTING
    this.loopState.lastReflection = this.stepCount
    const depth = this.determineReflectionDepth()
    const reflection = await this.metacognition.reflect(`Step ${this.stepCount} reflection`, depth)
    this.recordDecision({
      phase: LoopPhase.REFLECTING,
      action: "self_reflection",
      reasoning: `Reflection found ${reflection.insights.length} insights`,
      confidence: 0.8,
      expectedOutcome: "Improve subsequent actions",
    })
    if (reflection.strategyAdjustments.length > 0) {
      this.recordDecision({
        phase: LoopPhase.REFLECTING,
        action: "adjust_strategy",
        reasoning: `Strategy adjustments: ${reflection.strategyAdjustments.length} items`,
        confidence: 0.7,
        expectedOutcome: "More effective execution",
      })
    }
    if (reflection.newHypotheses.length > 0) {
      this.loopState.activeHypotheses.push(...reflection.newHypotheses)
    }
    if (this.config.enableExperienceLearning) {
      this.experienceLearning.learnFromReflection(
        {
          insights: reflection.insights,
          strategyAdjustments: reflection.strategyAdjustments.map((a) => `${a.previousStrategy} -> ${a.newStrategy}`),
          newHypotheses: reflection.newHypotheses.map((h) => h.statement),
        },
        this.loopState.context,
      )
    }
  }

  private determineReflectionDepth(): "shallow" | "moderate" | "deep" {
    const state = this.monitor.getState()
    if (state.consecutiveErrors >= 3 || state.confidence < 0.3) {
      return "deep"
    }
    if (state.consecutiveErrors >= 1 || state.confidence < 0.6) {
      return "moderate"
    }
    return "shallow"
  }

  async learn(): Promise<void> {
    this.monitor.transitionState(AgentState.LEARNING)
    this.loopState.phase = LoopPhase.LEARNING
    if (!this.config.enableExperienceLearning) return
    const contextualLearning: ContextualLearning = {
      taskType: this.loopState.context.taskType as string,
      complexity: this.loopState.context.complexity as "simple" | "moderate" | "complex",
    }
    const applicableInsights = this.experienceLearning.getApplicableInsights(contextualLearning)
    if (applicableInsights.length > 0) {
      this.recordDecision({
        phase: LoopPhase.LEARNING,
        action: "apply_insights",
        reasoning: `Applying ${applicableInsights.length} relevant insights`,
        confidence: 0.75,
        expectedOutcome: "Leverage historical experience",
      })
    }
  }

  async adapt(): Promise<void> {
    this.monitor.transitionState(AgentState.THINKING)
    this.loopState.phase = LoopPhase.ADAPTING
    if (this.monitor.getState().confidence < this.config.adaptationThreshold) {
      const adaptations = this.goalManager.adaptGoals("Confidence below threshold")
      if (adaptations.length > 0) {
        this.recordDecision({
          phase: LoopPhase.ADAPTING,
          action: "adapt_goals",
          reasoning: `Triggered ${adaptations.length} goal adjustments`,
          confidence: 0.6,
          expectedOutcome: "More achievable goals",
        })
        this.monitor.recordGoalAdaptation()
      }
    }
    if (this.loopState.consecutiveSamePhase >= 3) {
      this.loopState.phase = LoopPhase.SENSING
      this.loopState.consecutiveSamePhase = 0
    }
    this.loopState.consecutiveSamePhase++
  }

  private recordDecision(decision: LoopDecision): void {
    this.decisionHistory.push(decision)
    this.loopState.pendingDecisions.push(decision)
    if (this.decisionHistory.length > 100) {
      this.decisionHistory.shift()
    }
    if (this.loopState.pendingDecisions.length > 10) {
      this.loopState.pendingDecisions.shift()
    }
  }

  shouldReflect(): boolean {
    const shouldAutoReflect =
      this.config.enableAutomaticReflection &&
      this.stepCount - this.loopState.lastReflection >= this.config.reflectionInterval
    return shouldAutoReflect || this.monitor.shouldReflect()
  }

  shouldRequestUserInput(): boolean {
    return this.monitor.shouldRequestHelp()
  }

  async executeCycle(context?: Record<string, unknown>): Promise<LoopPhase> {
    await this.sense()
    if (context) {
      await this.perceive(context)
    }
    await this.plan()
    if (this.shouldReflect()) {
      await this.reflect()
    }
    if (this.config.enableExperienceLearning) {
      await this.learn()
    }
    await this.adapt()
    return this.loopState.phase
  }

  getCurrentState(): LoopState {
    return { ...this.loopState }
  }

  getGoalManager(): GoalManager {
    return this.goalManager
  }

  getExperienceLearning(): ExperienceLearning {
    return this.experienceLearning
  }

  getMetacognition(): MetacognitionEngine {
    return this.metacognition
  }

  getDecisionHistory(): LoopDecision[] {
    return [...this.decisionHistory]
  }

  isComplete(): boolean {
    if (!this.loopState.currentGoal) return true
    const goal = this.goalManager.getGoal(this.loopState.currentGoal.id)
    return goal?.status === GoalStatus.COMPLETED
  }

  getProgress(): number {
    if (!this.loopState.currentGoal) return 1
    const goal = this.goalManager.getGoal(this.loopState.currentGoal.id)
    return goal?.progress ?? 0
  }

  generateDiagnosticReport(): string {
    const goalReport = this.goalManager.getGoalStatusReport()
    const metacogReport = this.metacognition.getMetacognitiveReport()
    const expReport = this.experienceLearning.getExperienceReport()
    return `
# Agent Self-Driving Diagnostic Report

## Current Loop State
- Phase: ${this.loopState.phase}
- Step Count: ${this.stepCount}
- Current Goal: ${this.loopState.currentGoal?.title ?? "None"}
- Progress: ${(this.getProgress() * 100).toFixed(1)}%

## Decision History (Last 5)
${this.decisionHistory
  .slice(-5)
  .map((d) => `- [${d.phase}] ${d.action}: ${d.reasoning}`)
  .join("\n")}

${goalReport}

${metacogReport}

${expReport}
`
  }

  detectRemainingWork(): RemainingWorkReport {
    const goal = this.loopState.currentGoal
    if (!goal) return { hasRemaining: false, items: [], progress: 1, suggestedActions: [] }

    const completed = this.getCompletedCriteria()
    const remaining = goal.successCriteria.filter((c) => !completed.includes(c))

    const progress = completed.length / goal.successCriteria.length

    return {
      hasRemaining: remaining.length > 0,
      items: remaining,
      progress,
      suggestedActions: remaining.map((c) => `Address: ${c}`),
    }
  }

  private getCompletedCriteria(): string[] {
    return []
  }

  setupAutoContinueHooks(session: Session) {
    session.on("tool_complete", async (result: any) => {
      const remaining = this.detectRemainingWork()
      if (remaining.hasRemaining && remaining.progress > 0.5) {
        await this.autoContinue(remaining.suggestedActions[0])
      }
    })
  }

  private async autoContinue(action: string) {
    this.monitor.transitionState(AgentState.EXECUTING)

    const decision: LoopDecision = {
      phase: LoopPhase.ACTING,
      action,
      reasoning: `Auto-continue triggered: progress > 50%`,
      expectedOutcome: `Continue with ${action}`,
    }

    await this.act()
  }

  getProgress(): number {
    const goal = this.loopState.currentGoal
    if (!goal) return 0

    const completed = this.getCompletedCriteria()
    return completed.length / goal.successCriteria.length
  }

  private persistProgress(): void {
    if (!this.loopState.currentGoal) return

    const state: GoalProgressState = {
      goalId: this.loopState.currentGoal.id,
      progress: this.getProgress(),
      completedCriteria: this.getCompletedCriteria(),
      timestamp: Date.now(),
    }

    this.progressHistory.push(state)
  }

  private loadProgress(goalId: string): GoalProgressState | null {
    const state = this.progressHistory.find((s) => s.goalId === goalId)
    return state || null
  }

  async saveGoalState(): Promise<void> {
    await this.persistProgress()
  }

  async loadGoalState(goalId: string): Promise<void> {
    const state = await this.loadProgress(goalId)
    if (state) {
      this.restoreFromState(state)
    }
  }

  private restoreFromState(state: GoalProgressState) {
    this.loopState.currentGoal = {
      ...state,
      progress: state.progress,
      completedCriteria: state.completedCriteria,
    }
    this.decisionHistory = []
    this.stepCount = 0
  }

  reset(): void {
    this.monitor = new SelfMonitor()
    this.metacognition = new MetacognitionEngine(this.monitor)
    this.goalManager = new GoalManager()
    this.experienceLearning = new ExperienceLearning()
    this.loopState = {
      phase: LoopPhase.SENSING,
      stepCount: 0,
      phaseDuration: 0,
      currentGoal: null,
      activeHypotheses: [],
      pendingDecisions: [],
      context: {},
      lastReflection: 0,
      consecutiveSamePhase: 0,
    }
    this.decisionHistory = []
    this.stepCount = 0
    this.progressHistory = []
  }
}
    this.decisionHistory = []
    this.stepCount = 0
  }

  detectRemainingWork(): RemainingWorkReport {
    const goal = this.loopState.currentGoal
    if (!goal) return { hasRemaining: false, items: [], progress: 1, suggestedActions: [] }

    const completed = this.getCompletedCriteria()
    const remaining = goal.successCriteria.filter((c) => !completed.includes(c))
    const progress = completed.length / goal.successCriteria.length

    return {
      hasRemaining: remaining.length > 0,
      items: remaining,
      progress,
      suggestedActions: remaining.map((r) => `Address: ${r}`),
    }
  }

  private getCompletedCriteria(): string[] {
    const completed: string[] = []
    const goal = this.loopState.currentGoal
    if (!goal) return completed

    for (const criterion of goal.successCriteria) {
      if (this.isCriterionMet(criterion)) {
        completed.push(criterion)
      }
    }
    return completed
  }

  private isCriterionMet(criterion: string): boolean {
    const state = this.monitor.getState()
    if (criterion.includes("complete") || criterion.includes("done")) {
      return state.confidence > 0.8 && state.consecutiveErrors === 0
    }
    return false
  }

  setupAutoContinueHooks(session: { on: (event: string, handler: (result: any) => Promise<void>) => void }) {
    session.on("tool_complete", async (result) => {
      const remaining = this.detectRemainingWork()
      if (remaining.hasRemaining && remaining.progress > 0.5) {
        await this.autoContinue(remaining.suggestedActions[0])
      }
    })
  }

  private async autoContinue(action: string) {
    await this.act()
  }
}

export interface RemainingWorkReport {
  hasRemaining: boolean
  items: string[]
  progress: number
  suggestedActions: string[]
}
