import { SelfMonitor, AgentState } from "./self-monitor"
import { MetacognitionEngine } from "./metacognition"
import { GoalManager, GoalStatus, GoalPriority } from "./goal-manager"
import type { Goal } from "./goal-manager"
import { ExperienceLearning } from "./experience-learning"
import type { Hypothesis } from "./evidence"
import type { TaskIntent } from "./intent"
import { Log } from "@/util/log"

const log = Log.create({ service: "self-driving-loop" })

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
  confidence?: number
  expectedOutcome?: string
}

export interface SelfDrivingConfig {
  enableAutonomousGoalSetting: boolean
  enableAutomaticReflection: boolean
  maxCycles: number
  cycleTimeout: number
  enableKillSwitch: boolean
}

export const DEFAULT_SELF_DRIVING_CONFIG: SelfDrivingConfig = {
  enableAutonomousGoalSetting: true,
  enableAutomaticReflection: true,
  maxCycles: 100,
  cycleTimeout: 30000,
  enableKillSwitch: true,
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

export interface RemainingWorkReport {
  hasRemaining: boolean
  items: string[]
  progress: number
  suggestedActions: string[]
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
  private progressHistory: GoalProgressState[] = []

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
        description: userInput,
        priority: this.determinePriority(intent),
        successCriteria: this.extractSuccessCriteria(intent),
      })
      this.loopState.currentGoal = goal
      log.info("Created autonomous goal", { goalId: goal.id, title: goal.title })
    }
  }

  private extractGoalTitle(intent: TaskIntent): string {
    return `Complete ${intent.type} task`
  }
  private determinePriority(_intent: TaskIntent): GoalPriority {
    return GoalPriority.HIGH
  }
  private extractSuccessCriteria(_intent: TaskIntent): string[] {
    const criteria: string[] = []
    criteria.push("Task completed successfully")
    criteria.push("All requirements met")
    criteria.push("Quality standards maintained")
    return criteria
  }
  async sense(): Promise<void> {
    this.monitor.transitionState(AgentState.THINKING)
  }
  async perceive(): Promise<void> {
    this.monitor.transitionState(AgentState.THINKING)
  }
  async plan(): Promise<void> {
    this.monitor.transitionState(AgentState.THINKING)
  }
  async act(): Promise<void> {
    this.monitor.transitionState(AgentState.EXECUTING)
  }
  async reflect(): Promise<void> {
    this.monitor.transitionState(AgentState.REFLECTING)
  }
  async learn(): Promise<void> {
    this.monitor.transitionState(AgentState.LEARNING)
  }
  async adapt(): Promise<void> {
    this.monitor.transitionState(AgentState.LEARNING)
  }
  async runStep(): Promise<LoopDecision> {
    const decision: LoopDecision = {
      phase: this.loopState.phase,
      action: "Continue",
      reasoning: "Proceeding with current phase",
      confidence: 0.8,
      expectedOutcome: "Progress to next phase",
    }
    this.decisionHistory.push(decision)
    return decision
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
    const goal = this.loopState.currentGoal
    if (!goal) return 0

    const completed = this.getCompletedCriteria()
    return completed.length / goal.successCriteria.length
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

    return {
      hasRemaining: remaining.length > 0,
      items: remaining,
      progress: this.getProgress(),
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
    session.on("tool_complete", async (_result) => {
      const remaining = this.detectRemainingWork()
      if (remaining.hasRemaining && remaining.progress > 0.5) {
        await this.autoContinue(remaining.suggestedActions[0])
      }
    })
  }
  private async autoContinue(_action: string) {
    this.monitor.transitionState(AgentState.EXECUTING)
    await this.act()
  }
  async saveGoalState(): Promise<void> {
    if (!this.loopState.currentGoal) return

    const state: GoalProgressState = {
      goalId: this.loopState.currentGoal.id,
      progress: this.getProgress(),
      completedCriteria: this.getCompletedCriteria(),
      timestamp: Date.now(),
    }

    this.progressHistory.push(state)
  }
  async loadGoalState(goalId: string): Promise<void> {
    const state = this.progressHistory.find((s) => s.goalId === goalId)
    if (state) {
      this.restoreFromState(state)
    }
  }
  private restoreFromState(state: GoalProgressState) {
    if (this.loopState.currentGoal) {
      this.loopState.currentGoal.progress = state.progress
    }
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

export interface GoalProgressState {
  goalId: string
  progress: number
  completedCriteria: string[]
  timestamp: number
}
