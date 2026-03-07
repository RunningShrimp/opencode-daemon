import { SelfMonitor } from "./self-monitor"
import { Hypothesis, Evidence } from "./evidence"

export enum ReasoningStrategy {
  DEDUCTIVE = "deductive",
  INDUCTIVE = "inductive",
  ABDUCTIVE = "abductive",
  ANALOGICAL = "analogical",
  CAUSAL = "causal",
  HYPOTHETICAL = "hypothetical",
}

export const ReasoningStrategyWeights: Record<ReasoningStrategy, number> = {
  [ReasoningStrategy.DEDUCTIVE]: 1.0,
  [ReasoningStrategy.INDUCTIVE]: 0.9,
  [ReasoningStrategy.ABDUCTIVE]: 0.7,
  [ReasoningStrategy.ANALOGICAL]: 0.8,
  [ReasoningStrategy.CAUSAL]: 0.85,
  [ReasoningStrategy.HYPOTHETICAL]: 0.75,
}

export interface CognitivePattern {
  id: string
  name: string
  description: string
  frequency: number
  successRate: number
  lastUsed: number
  applicableContexts: string[]
  effectiveness: number
}

export interface ReflectionResult {
  id: string
  timestamp: number
  trigger: string
  focusAreas: string[]
  insights: string[]
  strategyAdjustments: StrategyAdjustment[]
  newHypotheses: Hypothesis[]
  confidenceDelta: number
  depth: "shallow" | "moderate" | "deep"
}

export interface StrategyAdjustment {
  previousStrategy: ReasoningStrategy
  newStrategy: ReasoningStrategy
  reason: string
  expectedImpact: string
}

export interface MetacognitiveInsight {
  type: "strength" | "weakness" | "opportunity" | "threat" | "pattern"
  description: string
  evidence: string[]
  confidence: number
  actionableRecommendations: string[]
}

export class MetacognitionEngine {
  private monitor: SelfMonitor
  private reasoningHistory: ReasoningStrategy[] = []
  private cognitivePatterns: Map<string, CognitivePattern> = new Map()
  private reflections: ReflectionResult[] = []
  private currentHypotheses: Hypothesis[] = []
  private insights: MetacognitiveInsight[] = []
  private reasoningDepth: number = 0
  private maxReasoningDepth: number = 5

  constructor(monitor: SelfMonitor) {
    this.monitor = monitor
    this.initializePatterns()
  }

  private initializePatterns(): void {
    const defaultPatterns: CognitivePattern[] = [
      {
        id: "pattern-1",
        name: "Tool Chain Analysis",
        description: "Analyze problem through tool call sequences",
        frequency: 0,
        successRate: 0.7,
        lastUsed: 0,
        applicableContexts: ["debugging", "implementation"],
        effectiveness: 0.7,
      },
      {
        id: "pattern-2",
        name: "Evidence-Driven Reasoning",
        description: "Make decisions based on collected evidence",
        frequency: 0,
        successRate: 0.85,
        lastUsed: 0,
        applicableContexts: ["review", "exploration", "implementation"],
        effectiveness: 0.85,
      },
      {
        id: "pattern-3",
        name: "Divide and Conquer",
        description: "Break complex problems into sub-problems",
        frequency: 0,
        successRate: 0.8,
        lastUsed: 0,
        applicableContexts: ["implementation", "debugging"],
        effectiveness: 0.8,
      },
      {
        id: "pattern-4",
        name: "Analogical Transfer",
        description: "Use solutions from similar problems",
        frequency: 0,
        successRate: 0.75,
        lastUsed: 0,
        applicableContexts: ["implementation", "exploration"],
        effectiveness: 0.75,
      },
      {
        id: "pattern-5",
        name: "Hypothesis Validation",
        description: "Build and validate hypotheses through tool calls",
        frequency: 0,
        successRate: 0.8,
        lastUsed: 0,
        applicableContexts: ["debugging", "exploration"],
        effectiveness: 0.8,
      },
    ]

    for (const p of defaultPatterns) {
      this.cognitivePatterns.set(p.id, p)
    }
  }

  selectReasoningStrategy(context: string): ReasoningStrategy {
    const patterns = Array.from(this.cognitivePatterns.values())
      .filter((p) => p.applicableContexts.includes(context))
      .sort((a, b) => b.effectiveness - a.effectiveness)

    if (patterns.length === 0) {
      return ReasoningStrategy.DEDUCTIVE
    }

    const state = this.monitor.getState()

    if (state.confidence < 0.4) {
      return ReasoningStrategy.ABDUCTIVE
    }

    if (state.consecutiveErrors > 1) {
      return ReasoningStrategy.HYPOTHETICAL
    }

    const topPattern = patterns[0]
    this.updatePatternFrequency(topPattern.id)
    this.reasoningHistory.push(ReasoningStrategy.DEDUCTIVE)

    if (this.reasoningHistory.length > 50) {
      this.reasoningHistory.shift()
    }

    return ReasoningStrategy.DEDUCTIVE
  }

  private updatePatternFrequency(patternId: string): void {
    const pattern = this.cognitivePatterns.get(patternId)
    if (pattern) {
      pattern.frequency++
      pattern.lastUsed = Date.now()
    }
  }

  recordStrategySuccess(strategy: ReasoningStrategy): void {
    const pattern = Array.from(this.cognitivePatterns.values()).find((p) =>
      p.applicableContexts.includes(strategy.toString()),
    )
    if (pattern) {
      pattern.successRate = (pattern.successRate * pattern.frequency + 1) / (pattern.frequency + 1)
      this.updatePatternEffectiveness(pattern.id, 0.05)
    }
  }

  recordStrategyFailure(strategy: ReasoningStrategy): void {
    const pattern = Array.from(this.cognitivePatterns.values()).find((p) =>
      p.applicableContexts.includes(strategy.toString()),
    )
    if (pattern) {
      pattern.successRate = (pattern.successRate * pattern.frequency) / (pattern.frequency + 1)
      this.updatePatternEffectiveness(pattern.id, -0.1)
    }
  }

  private updatePatternEffectiveness(patternId: string, delta: number): void {
    const pattern = this.cognitivePatterns.get(patternId)
    if (pattern) {
      pattern.effectiveness = Math.max(0, Math.min(1, pattern.effectiveness + delta))
    }
  }

  addHypothesis(hypothesis: Hypothesis): void {
    this.currentHypotheses.push(hypothesis)
    this.reasoningDepth++
  }

  validateHypotheses(evidence: Evidence[]): Hypothesis[] {
    const evidenceMap = new Map(evidence.map((e) => [e.id, e]))

    return this.currentHypotheses.filter((h) => {
      const evidenceIds = new Set(h.evidenceIds)
      const hasEvidence = h.evidenceIds.every((id) => evidenceIds.has(id))

      if (!hasEvidence) {
        h.confidence *= 0.5
      }

      const supportingEvidence = evidence.filter((e) => !e.contradicts && h.evidenceIds.includes(e.id)).length

      if (supportingEvidence > 0) {
        h.confidence = Math.min(1, h.confidence + 0.1 * supportingEvidence)
      }

      return h.confidence > 0.3
    })
  }

  getActiveHypotheses(): Hypothesis[] {
    return [...this.currentHypotheses]
  }

  clearHypotheses(): void {
    this.currentHypotheses = []
    this.reasoningDepth = 0
  }

  async reflect(trigger: string, depth: "shallow" | "moderate" | "deep" = "moderate"): Promise<ReflectionResult> {
    const state = this.monitor.getState()
    const metrics = this.monitor.getMetrics()
    const previousConfidence = state.confidence

    const insights = await this.generateInsights(depth)
    const strategyAdjustments = this.determineStrategyAdjustments()
    const newHypotheses = this.generateNewHypotheses(insights)

    const reflection: ReflectionResult = {
      id: `reflection-${Date.now()}`,
      timestamp: Date.now(),
      trigger,
      focusAreas: this.determineFocusAreas(),
      insights: insights.map((i) => i.description),
      strategyAdjustments,
      newHypotheses,
      confidenceDelta: state.confidence - previousConfidence,
      depth,
    }

    this.reflections.push(reflection)
    this.insights.push(...insights)
    this.monitor.recordReflection()

    if (this.reflections.length > 100) {
      this.reflections.shift()
    }

    if (newHypotheses.length > 0) {
      this.currentHypotheses.push(...newHypotheses)
    }

    return reflection
  }

  private async generateInsights(depth: "shallow" | "moderate" | "deep"): Promise<MetacognitiveInsight[]> {
    const insights: MetacognitiveInsight[] = []
    const state = this.monitor.getState()
    const metrics = this.monitor.getMetrics()

    if (state.confidence < 0.5) {
      insights.push({
        type: "threat",
        description: "Current confidence below threshold, strategy adjustment needed",
        evidence: [`Confidence: ${state.confidence}`],
        confidence: 0.8,
        actionableRecommendations: [
          "Consider requesting user clarification",
          "Try more conservative approach",
          "Increase evidence collection",
        ],
      })
    }

    if (state.consecutiveErrors > 1) {
      insights.push({
        type: "weakness",
        description: "Consecutive errors indicate systematic issue with current approach",
        evidence: [`Consecutive errors: ${state.consecutiveErrors}`],
        confidence: 0.9,
        actionableRecommendations: [
          "Re-evaluate problem decomposition",
          "Check tool selection",
          "Consider misunderstanding requirements",
        ],
      })
    }

    if (metrics.selfCorrectionRate / Math.max(1, state.totalSteps) > 0.3) {
      insights.push({
        type: "strength",
        description: "High self-correction rate indicates good error recovery capability",
        evidence: [`Self-correction rate: ${metrics.selfCorrectionRate / Math.max(1, state.totalSteps)}`],
        confidence: 0.85,
        actionableRecommendations: ["Continue this self-checking habit"],
      })
    }

    if (metrics.evidenceCollectionRate / Math.max(1, state.totalSteps) < 0.2) {
      insights.push({
        type: "opportunity",
        description: "Low evidence collection rate may impact decision quality",
        evidence: [`Evidence collection rate: ${metrics.evidenceCollectionRate}`],
        confidence: 0.7,
        actionableRecommendations: [
          "Increase search and code exploration frequency",
          "Collect more evidence before conclusions",
        ],
      })
    }

    if (depth === "deep") {
      const patterns = this.analyzeCognitivePatterns()
      insights.push(...patterns)
    }

    return insights
  }

  private analyzeCognitivePatterns(): MetacognitiveInsight[] {
    const insights: MetacognitiveInsight[] = []
    const patterns = Array.from(this.cognitivePatterns.values())

    const effectivePatterns = patterns.filter((p) => p.effectiveness > 0.7)
    if (effectivePatterns.length > 0) {
      insights.push({
        type: "strength",
        description: "Identified high-effectiveness cognitive patterns",
        evidence: effectivePatterns.map((p) => p.name),
        confidence: 0.8,
        actionableRecommendations: effectivePatterns.map((p) => `Prioritize: ${p.name}`),
      })
    }

    const ineffectivePatterns = patterns.filter((p) => p.effectiveness < 0.4 && p.frequency > 3)
    if (ineffectivePatterns.length > 0) {
      insights.push({
        type: "weakness",
        description: "Identified low-effectiveness cognitive patterns",
        evidence: ineffectivePatterns.map((p) => p.name),
        confidence: 0.75,
        actionableRecommendations: ineffectivePatterns.map((p) => `Reduce use: ${p.name}`),
      })
    }

    return insights
  }

  private determineStrategyAdjustments(): StrategyAdjustment[] {
    const adjustments: StrategyAdjustment[] = []
    const state = this.monitor.getState()

    if (state.consecutiveErrors >= 2) {
      adjustments.push({
        previousStrategy: ReasoningStrategy.DEDUCTIVE,
        newStrategy: ReasoningStrategy.HYPOTHETICAL,
        reason: "Consecutive errors require more hypothesis validation",
        expectedImpact: "Reduce large-scale errors through small-scale validation",
      })
    }

    if (state.confidence < 0.5) {
      adjustments.push({
        previousStrategy: ReasoningStrategy.DEDUCTIVE,
        newStrategy: ReasoningStrategy.ABDUCTIVE,
        reason: "Low confidence requires more flexible reasoning",
        expectedImpact: "Explore multiple possibilities to increase success rate",
      })
    }

    return adjustments
  }

  private determineFocusAreas(): string[] {
    const state = this.monitor.getState()
    const areas: string[] = []

    if (state.confidence < 0.6) areas.push("Confidence rebuilding")
    if (state.consecutiveErrors > 0) areas.push("Error analysis")
    if (state.energy < 0.5) areas.push("Energy management")
    if (state.focusLevel < 0.6) areas.push("Focus improvement")

    return areas
  }

  private generateNewHypotheses(insights: MetacognitiveInsight[]): Hypothesis[] {
    return insights
      .filter((i) => i.type === "opportunity" || i.type === "threat")
      .map((i) => ({
        id: `hypothesis-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`,
        statement: i.description,
        evidenceIds: [],
        confidence: i.confidence * 0.5,
        createdAt: Date.now(),
        reflectionNotes: i.actionableRecommendations.join("; "),
      }))
  }

  getReflections(): ReflectionResult[] {
    return [...this.reflections]
  }

  getInsights(): MetacognitiveInsight[] {
    return [...this.insights]
  }

  getCognitivePatterns(): CognitivePattern[] {
    return Array.from(this.cognitivePatterns.values())
  }

  getReasoningDepth(): number {
    return this.reasoningDepth
  }

  getMetacognitiveReport(): string {
    const state = this.monitor.getState()
    const patterns = this.getCognitivePatterns()
    const insights = this.getInsights()

    return `
## Metacognitive Engine Analysis Report

### Current Reasoning State
- Reasoning Depth: ${this.reasoningDepth}/${this.maxReasoningDepth}
- Active Hypotheses: ${this.currentHypotheses.length}
- Historical Reflections: ${this.reflections.length}

### Cognitive Pattern Analysis
${patterns
  .sort((a, b) => b.effectiveness - a.effectiveness)
  .slice(0, 5)
  .map(
    (p) =>
      `- ${p.name}: Effectiveness ${(p.effectiveness * 100).toFixed(0)}%, Used ${p.frequency} times, Success ${(p.successRate * 100).toFixed(0)}%`,
  )
  .join("\n")}

### Key Insights
${
  insights.length > 0
    ? insights
        .slice(-5)
        .map((i) => `- [${i.type}] ${i.description}`)
        .join("\n")
    : "None"
}

### Recommended Strategy Adjustments
${
  this.determineStrategyAdjustments().length > 0
    ? this.determineStrategyAdjustments()
        .map((a) => `- ${a.previousStrategy} → ${a.newStrategy}: ${a.reason}`)
        .join("\n")
    : "No adjustments needed"
}
`
  }
}
