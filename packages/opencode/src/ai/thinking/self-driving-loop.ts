import { TreeOfThought, type LLMClient } from "./tree-of-thought"
import { SelfMonitor, AgentState } from "./self-monitor"
import { MetacognitionEngine, ReasoningStrategy } from "./metacognition"
import { GoalManager, GoalStatus, GoalPriority } from "./goal-manager"
import type { Goal } from "./goal-manager"
import { ExperienceLearning } from "./experience-learning"
import type { Hypothesis } from "./evidence"
import type { TaskIntent } from "./intent"
import { Log } from "@/util/log"
import { QualityGate } from "@/ai/workflow/quality-gate"

// import { SelfReviewWorkflow } from "@/ai/workflow/self-review-workflow"
// import { ThoughtNodeStorage } from "@/ai/thinking/thought-storage"
// import { ThinkTreeUI } from "@/cli/cmd/tui/components/think-tree-ui"

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

const NON_ACTIONABLE_COMPLETION_CRITERIA = [
  /^task completed successfully$/i,
  /^all requirements met$/i,
  /^quality standards maintained$/i,
]

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
  private qualityGate: QualityGate
  // private workflow: SelfReviewWorkflow
  // private thoughtStorage: ThoughtNodeStorage
  // private thinkTreeUI: ThinkTreeUI
  private tot: TreeOfThought

  constructor(config?: Partial<SelfDrivingConfig>) {
    this.config = { ...DEFAULT_SELF_DRIVING_CONFIG, ...config }
    this.monitor = new SelfMonitor()
    this.metacognition = new MetacognitionEngine(this.monitor)
    this.goalManager = new GoalManager()
    this.experienceLearning = new ExperienceLearning()
    this.qualityGate = new QualityGate()
    // this.workflow = new SelfReviewWorkflow()
    // this.thoughtStorage = new ThoughtNodeStorage()
    // this.thinkTreeUI = new ThinkTreeUI()
    this.tot = new TreeOfThought()
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

  private setPhase(phase: LoopPhase) {
    if (this.loopState.phase === phase) {
      this.loopState.consecutiveSamePhase += 1
    } else {
      this.loopState.consecutiveSamePhase = 0
    }
    this.loopState.phase = phase
    this.loopState.stepCount = this.stepCount
  }

  async initialize(userInput: string, intent: TaskIntent): Promise<void> {
    this.setPhase(LoopPhase.SENSING)
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

  setLLM(llm: LLMClient) {
    this.tot.setLLM(llm)
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
    this.setPhase(LoopPhase.SENSING)
    this.monitor.transitionState(AgentState.SENSING)
  }
  
  async perceive(context?: Record<string, unknown>): Promise<void> {
    this.setPhase(LoopPhase.PERCEIVING)
    this.monitor.transitionState(AgentState.PERCEIVING)
    if (context) {
        this.loopState.context = { ...this.loopState.context, ...context }
    }
  }
  
  async plan(): Promise<void> {
    this.setPhase(LoopPhase.PLANNING)
    this.monitor.transitionState(AgentState.PLANNING)

    if (this.loopState.currentGoal) {
        try {
            // Initialize thinking if needed
            if (!this.tot.getCurrentState().root) {
                await this.tot.startThinking(this.loopState.currentGoal.description)
            }

            // Expand thoughts to find best path
            await this.tot.expandFrontier(JSON.stringify(this.loopState.context))
            
            // Make a decision based on current thoughts
            const decision = this.tot.makeDecision(JSON.stringify(this.loopState.context))
            
            if (decision.selectedNode && decision.selectedNode.content !== this.loopState.currentGoal.description) {
                // If the selected thought is a refinement/step, add it as a pending decision or subgoal
                log.info("ToT planned next step", { step: decision.selectedNode.content, score: decision.selectedNode.score })
                
                this.loopState.pendingDecisions.push({
                    phase: LoopPhase.ACTING,
                    action: decision.selectedNode.content,
                    reasoning: decision.reasoning,
                    confidence: decision.confidence,
                    expectedOutcome: "Step completion"
                })
            }
        } catch (error) {
            log.error("ToT planning failed", { error })
        }
    }
  }
  async act(): Promise<string | undefined> {
    this.setPhase(LoopPhase.ACTING)
    this.monitor.transitionState(AgentState.EXECUTING)
    // Surface the most recent high-confidence decision as execution guidance
    const pending = this.loopState.pendingDecisions
    if (pending.length > 0) {
      const latest = pending[pending.length - 1]
      if ((latest.confidence ?? 0) >= 0.6 && latest.reasoning) {
        return latest.reasoning
      }
    }
    // Fall back to surfacing recent metacognitive insights
    const recentInsights = this.loopState.context["recentInsights"] as string[] | undefined
    if (recentInsights?.length) {
      return `Strategy: ${recentInsights.slice(-2).join("; ")}`
    }
    return undefined
  }
  
  async reflect(): Promise<void> {
    this.setPhase(LoopPhase.REFLECTING)
    this.monitor.transitionState(AgentState.REFLECTING)
    try {
      const reflection = await this.metacognition.reflect("Periodic reflection")
      this.loopState.lastReflection = Date.now()
      this.loopState.context["recentInsights"] = reflection.insights

      // Apply strategy adjustments: switch the active reasoning strategy
      if (reflection.strategyAdjustments.length > 0) {
        const latest = reflection.strategyAdjustments[reflection.strategyAdjustments.length - 1]
        this.loopState.context["activeStrategy"] = latest.newStrategy
        log.info("Reasoning strategy switched", {
          from: latest.previousStrategy,
          to: latest.newStrategy,
          reason: latest.reason,
        })

        // Record adjustment outcome into metacognition so future selections are informed
        if (latest.previousStrategy !== latest.newStrategy) {
          this.metacognition.recordStrategyFailure(latest.previousStrategy)
          this.metacognition.recordStrategySuccess(latest.newStrategy)
        }
      }

      // Learn from reflection using updated strategy labels
      this.experienceLearning.learnFromReflection(
        {
          insights: reflection.insights,
          strategyAdjustments: reflection.strategyAdjustments.map((s) => `${s.previousStrategy} -> ${s.newStrategy}`),
          newHypotheses: reflection.newHypotheses.map((h) => h.statement),
        },
        this.loopState.context,
      )
    } catch (error) {
      log.error("Reflection failed", { error })
    }
  }
  
  async learn(): Promise<void> {
    this.setPhase(LoopPhase.LEARNING)
    this.monitor.transitionState(AgentState.LEARNING)
  }
  
  async adapt(): Promise<void> {
    this.setPhase(LoopPhase.ADAPTING)
    this.monitor.transitionState(AgentState.ADAPTING)
    try {
      const adaptations = this.goalManager.adaptGoals("Automatic adaptation triggered")
      if (adaptations.length > 0) {
        log.info("Goals adapted", { adaptations })
        this.loopState.context["lastAdaptation"] = adaptations

        // If goals were split or refined, update current goal reference if needed
        if (this.loopState.currentGoal) {
          const updated = this.goalManager.getGoal(this.loopState.currentGoal.id)
          if (updated) this.loopState.currentGoal = updated
        }
      }

      // Gate check: evaluate quality of the current loop progress
      const monitorState = this.monitor.getState()
      const completenessScore = Math.round(
        Math.min(100, this.getProgress() * 70 + (monitorState.confidence ?? 0) * 30),
      )
      const findings: Array<{ severity: string; message?: string }> = []
      if (monitorState.consecutiveErrors > 0) {
        findings.push({ severity: "error", message: `${monitorState.consecutiveErrors} consecutive tool error(s)` })
      }
      if (this.getProgress() < 0.3 && this.stepCount > 10) {
        findings.push({ severity: "critical", message: "Low progress after many steps — possible stuck loop" })
      }
      const gateDecision = this.qualityGate.check({ completenessScore, findings })
      this.loopState.context["gateDecision"] = gateDecision

      if (!gateDecision.pass) {
        log.warn("Quality gate failed during adaptation", { reason: gateDecision.reason, score: completenessScore })
        // Switch to a more conservative strategy if gate fails
        const currentStrategy = (this.loopState.context["activeStrategy"] as ReasoningStrategy | undefined) ?? ReasoningStrategy.DEDUCTIVE
        if (currentStrategy !== ReasoningStrategy.HYPOTHETICAL) {
          this.loopState.context["activeStrategy"] = ReasoningStrategy.HYPOTHETICAL
          log.info("Falling back to HYPOTHETICAL strategy after gate failure")
        }
        // Escalate by requesting user input when stuck
        if (findings.some((f) => f.severity === "critical")) {
          this.monitor.transitionState(AgentState.WAITING_FOR_INPUT)
        }
      }
    } catch (error) {
      log.error("Adaptation failed", { error })
    }
  }
  
  async runStep(): Promise<LoopDecision> {
    this.stepCount++
    this.loopState.stepCount = this.stepCount
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
    const actionableRemaining = remaining.filter((criterion) => this.isActionableCriterion(criterion))

    return {
      hasRemaining: actionableRemaining.length > 0,
      items: actionableRemaining,
      progress: this.getProgress(),
      suggestedActions: actionableRemaining.map((r) => `Address: ${r}`),
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
    const normalizedCriterion = criterion.trim().toLowerCase()
    if (
      normalizedCriterion.includes("complete") ||
      normalizedCriterion.includes("completed") ||
      normalizedCriterion.includes("done") ||
      normalizedCriterion.includes("met") ||
      normalizedCriterion.includes("maintained") ||
      normalizedCriterion.includes("successful")
    ) {
      return state.confidence > 0.8 && state.consecutiveErrors === 0
    }
    return false
  }
  private isActionableCriterion(criterion: string): boolean {
    return !NON_ACTIONABLE_COMPLETION_CRITERIA.some((pattern) => pattern.test(criterion.trim()))
  }
  setupAutoContinueHooks(session: { on: (event: string, handler: (result: unknown) => Promise<void>) => void }) {
    session.on("tool_complete", async (_result) => {
      const remaining = this.detectRemainingWork()
      if (remaining.hasRemaining && remaining.progress > 0.5) {
        await this.autoContinue(remaining.suggestedActions[0])
      }
    })
  }
  private async autoContinue(action: string) {
    this.monitor.transitionState(AgentState.EXECUTING)
    log.info("Auto-continuing with action", { action })
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

  // --- New Methods for SelfDrivenAgent Compatibility ---

  getCurrentState(): LoopState {
    return this.loopState
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

  shouldReflect(): boolean {
    // Reflect if monitoring says so, or based on config
    return this.config.enableAutomaticReflection && (this.monitor.shouldReflect() || this.stepCount % 5 === 0)
  }

  shouldRequestUserInput(): boolean {
    return this.monitor.shouldRequestHelp()
  }

  onToolResult(success: boolean, result?: string): void {
     if (success) {
         this.monitor.recordSuccess(result?.substring(0, 50) ?? "Tool execution")
     } else {
         this.monitor.recordError(result ?? "Tool execution failed")
     }
     // Optionally update context with result
     if (result) {
         this.loopState.context["lastToolResult"] = result
     }
  }
}

export interface GoalProgressState {
  goalId: string
  progress: number
  completedCriteria: string[]
  timestamp: number
}
