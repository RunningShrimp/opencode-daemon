import { SelfDrivingLoop, type SelfDrivingConfig, DEFAULT_SELF_DRIVING_CONFIG } from "./self-driving-loop"
import type { TaskIntent } from "./intent"
import { IntentDetection } from "./intent"
import type { Provider } from "@/provider/provider"
import { OpencodeLLMAdapter } from "./llm-adapter"

export interface SelfDrivenAgentConfig {
  selfDriving: SelfDrivingConfig
  enableDebugOutput?: boolean
}

export interface AgentContext {
  userInput: string
  intent: TaskIntent
  history: Array<{
    role: "user" | "assistant" | "tool"
    content: string
  }>
  model: Provider.Model
  sessionID: string
}

export interface BeforeLLMResult {
  enhancedContext: Record<string, unknown>
  promptGuidance?: string
}

export interface AfterToolResult {
  shouldReflect: boolean
  adaptation?: string
}

export class SelfDrivenAgent {
  private loop: SelfDrivingLoop
  private config: SelfDrivenAgentConfig
  private initialized: boolean = false

  constructor(config?: Partial<SelfDrivenAgentConfig>) {
    this.config = {
      selfDriving: { ...DEFAULT_SELF_DRIVING_CONFIG, ...config?.selfDriving },
      enableDebugOutput: config?.enableDebugOutput ?? false,
    }
    this.loop = new SelfDrivingLoop(this.config.selfDriving)
  }

  async initialize(context: AgentContext): Promise<void> {
    if (this.initialized) {
      this.loop.reset()
    }

    // Initialize LLM for Thinking
    const llmAdapter = new OpencodeLLMAdapter(context.model, context.sessionID)
    this.loop.setLLM(llmAdapter)

    const intent = IntentDetection.detect(context.userInput)
    await this.loop.initialize(context.userInput, intent)
    this.initialized = true
  }

  async onBeforeLLMCall(): Promise<BeforeLLMResult> {
    const state = this.loop.getCurrentState()

    await this.loop.sense()

    if (this.loop.shouldReflect()) {
      await this.loop.reflect()
    }

    // Capture current execution strategy from the driving loop
    const actGuidance = await this.loop.act()

    const needsUserInput = this.loop.shouldRequestUserInput()
    const enhancedContext: Record<string, unknown> = {
      ...state.context,
      selfDrivingEnabled: true,
      agentPhase: state.phase,
      hasActiveGoal: !!state.currentGoal,
      goalProgress: this.loop.getProgress(),
      needsUserInput,
    }

    if (actGuidance) {
      enhancedContext.executionStrategy = actGuidance
    }

    if (state.pendingDecisions.length > 0) {
      const recentDecisions = state.pendingDecisions.slice(-3)
      enhancedContext.recentDecisions = recentDecisions.map((d) => ({
        phase: d.phase,
        action: d.action,
        reasoning: d.reasoning,
      }))
    }

    const goalManager = this.loop.getGoalManager()
    const activeGoals = goalManager.getActiveGoals()
    if (activeGoals.length > 0) {
      enhancedContext.activeGoals = activeGoals.map((g) => ({
        id: g.id,
        title: g.title,
        progress: g.progress,
        status: g.status,
        blockers: g.blockers,
      }))
    }

    const promptGuidance = needsUserInput
      ? "Repeated tool failures or low confidence detected. Stop autonomous exploration, summarize the current blocker, and ask the user one focused clarification before more tool calls."
      : undefined

    return { enhancedContext, promptGuidance }
  }

  async onAfterToolExecution(toolName: string, success: boolean, result?: string): Promise<AfterToolResult> {
    this.loop.onToolResult(success, result)

    const context = {
      toolName,
      success,
      taskType: this.loop.getCurrentState().context.taskType,
    }

    await this.loop.perceive(context)

    const shouldReflect = this.loop.shouldReflect()

    let adaptation: string | undefined
    if (!success) {
      await this.loop.adapt()
      const state = this.loop.getCurrentState()
      if (state.pendingDecisions.length > 0) {
        const lastDecision = state.pendingDecisions[state.pendingDecisions.length - 1]
        adaptation = lastDecision.reasoning
      }
      if (this.loop.shouldRequestUserInput()) {
        adaptation = adaptation
          ? `${adaptation} Ask the user for a focused clarification before continuing.`
          : "Ask the user for a focused clarification before continuing."
      }
    }

    return { shouldReflect, adaptation }
  }

  async onStepComplete(): Promise<void> {
    const state = this.loop.getCurrentState()

    await this.loop.perceive({
      stepComplete: true,
      phase: state.phase,
      taskType: state.context.taskType,
    })

    if (this.loop.shouldReflect()) {
      await this.loop.reflect()
    }
  }

  async onTaskComplete(success: boolean): Promise<string> {
    const goalManager = this.loop.getGoalManager()
    const currentGoal = this.loop.getCurrentState().currentGoal

    if (currentGoal) {
      if (success) {
        goalManager.completeGoal(currentGoal.id)
      } else {
        goalManager.failGoal(currentGoal.id, "Task not completed successfully")
      }
    }

    return this.loop.generateDiagnosticReport()
  }

  isComplete(): boolean {
    return this.loop.isComplete()
  }

  getProgress(): number {
    return this.loop.getProgress()
  }

  getDiagnosticReport(): string {
    return this.loop.generateDiagnosticReport()
  }

  getDecisionHistory() {
    return this.loop.getDecisionHistory()
  }

  getState() {
    return this.loop.getCurrentState()
  }

  getGoalManager() {
    return this.loop.getGoalManager()
  }

  getExperienceLearning() {
    return this.loop.getExperienceLearning()
  }

  getMetacognition() {
    return this.loop.getMetacognition()
  }

  shouldRequestUserInput(): boolean {
    return this.loop.shouldRequestUserInput()
  }

  detectRemainingWork() {
    return this.loop.detectRemainingWork()
  }
}

export function createSelfDrivenAgent(config?: Partial<SelfDrivenAgentConfig>): SelfDrivenAgent {
  return new SelfDrivenAgent(config)
}

export function integrateSmartPromptWithSelfDriving(basePrompt: string, agent: SelfDrivenAgent): string {
  const state = agent.getState()
  const decisions = agent.getDecisionHistory().slice(-3)

  let additionalInstructions = ""

  if (decisions.length > 3) {
    additionalInstructions += `\n\n- Multiple pending decisions, consider prioritizing`
  }

  if (decisions.length > 0) {
    const recentActions = decisions.map((d) => d.action).join(", ")
    additionalInstructions += `\n\n- Recent decisions: ${recentActions}`
  }

  if (state.pendingDecisions.length > 5) {
    additionalInstructions += `\n\n- High decision backlog, consider focusing on key actions`
  }

  return basePrompt + additionalInstructions
}
