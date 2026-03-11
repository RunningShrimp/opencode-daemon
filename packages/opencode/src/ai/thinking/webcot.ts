export interface WebCoTThoughtNode {
  id: string
  thought: string
  action?: string
  observation?: string
  score: number
  depth: number
  parentId: string | null
  children: string[]
  status: "pending" | "evaluated" | "selected" | "discarded"
  reflection?: string
  evaluation?: ThoughtEvaluation
}

export interface ThoughtEvaluation {
  correctness: number
  completeness: number
  efficiency: number
  overall: number
  strengths: string[]
  weaknesses: string[]
  suggestions: string[]
}

export interface BranchPoint {
  nodeId: string
  alternativeThoughts: string[]
  selectedAlternative?: string
  reasoning: string
}

export interface WebCoTConfig {
  maxDepth: number
  maxBranches: number
  reflectionInterval: number
  enableLookahead: boolean
  enableRollback: boolean
  weights: {
    correctness: number
    completeness: number
    efficiency: number
  }
  selectionThreshold: number
}

const DEFAULT_WEBCOT_CONFIG: WebCoTConfig = {
  maxDepth: 5,
  maxBranches: 3,
  reflectionInterval: 3,
  enableLookahead: true,
  enableRollback: true,
  weights: {
    correctness: 0.5,
    completeness: 0.3,
    efficiency: 0.2,
  },
  selectionThreshold: 0.6,
}

export class WebCoT {
  private config: WebCoTConfig
  private nodes: Map<string, WebCoTThoughtNode> = new Map()
  private rootId: string | null = null
  private currentId: string | null = null
  private branchPoints: BranchPoint[] = []
  private stepCount: number = 0

  constructor(config: Partial<WebCoTConfig> = {}) {
    this.config = { ...DEFAULT_WEBCOT_CONFIG, ...config }
  }

  initialize(initialThought: string): string {
    const id = this.createNode({
      thought: initialThought,
      depth: 0,
      parentId: null,
    })

    this.rootId = id
    this.currentId = id
    this.stepCount = 0

    return id
  }

  addThought(thought: string, action?: string, observation?: string): string {
    if (!this.currentId) {
      throw new Error("WebCoT not initialized")
    }

    const currentNode = this.nodes.get(this.currentId)
    if (!currentNode) {
      throw new Error("Current node not found")
    }

    if (currentNode.depth >= this.config.maxDepth) {
      return this.currentId
    }

    const id = this.createNode({
      thought,
      action,
      observation,
      depth: currentNode.depth + 1,
      parentId: this.currentId,
    })

    currentNode.children.push(id)
    this.currentId = id
    this.stepCount++

    if (this.stepCount % this.config.reflectionInterval === 0) {
      this.reflect()
    }

    return id
  }

  private createNode(data: {
    thought: string
    action?: string
    observation?: string
    depth: number
    parentId: string | null
  }): string {
    const id = `node-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`

    const node: WebCoTThoughtNode = {
      id,
      thought: data.thought,
      action: data.action,
      observation: data.observation,
      score: 0.5,
      depth: data.depth,
      parentId: data.parentId,
      children: [],
      status: "pending",
    }

    this.nodes.set(id, node)

    return id
  }

  reflect(): string | null {
    if (!this.currentId) return null

    const path = this.getCurrentPath()
    const evaluation = this.evaluatePath(path)

    const currentNode = this.nodes.get(this.currentId)
    if (currentNode) {
      currentNode.evaluation = evaluation
      currentNode.score = evaluation.overall
      currentNode.status = "evaluated"
      currentNode.reflection = this.generateReflectionText(evaluation)
    }

    if (evaluation.overall < this.config.selectionThreshold && this.config.enableLookahead) {
      return this.branch()
    }

    if (this.config.enableRollback && this.shouldRollback(evaluation)) {
      return this.rollback()
    }

    return this.currentId
  }

  private evaluatePath(path: WebCoTThoughtNode[]): ThoughtEvaluation {
    const strengths: string[] = []
    const weaknesses: string[] = []
    const suggestions: string[] = []

    let totalCorrectness = 0
    let totalCompleteness = 0
    let totalEfficiency = 0

    for (const node of path) {
      if (node.observation) {
        totalCorrectness += 0.7
        totalCompleteness += 0.6
      } else {
        totalCompleteness += 0.4
      }

      const depthScore = 1 - node.depth / this.config.maxDepth
      totalEfficiency += depthScore

      if (node.thought.includes("error") || node.thought.includes("fail")) {
        weaknesses.push("Detected error-related thought")
        suggestions.push("Consider alternative approach")
      }

      if (node.thought.includes("try") || node.thought.includes("attempt")) {
        strengths.push("Proactive exploration")
      }

      if (node.action && node.observation) {
        strengths.push("Completed action with observation")
      }
    }

    const pathLength = path.length || 1
    const correctness = Math.min(1, totalCorrectness / pathLength)
    const completeness = Math.min(1, totalCompleteness / pathLength)
    const efficiency = Math.min(1, totalEfficiency / pathLength)

    const overall =
      correctness * this.config.weights.correctness +
      completeness * this.config.weights.completeness +
      efficiency * this.config.weights.efficiency

    if (overall < 0.5) {
      suggestions.push("Consider generating alternative reasoning paths")
      suggestions.push("Review previous successful reasoning patterns")
    }

    return {
      correctness,
      completeness,
      efficiency,
      overall,
      strengths,
      weaknesses,
      suggestions,
    }
  }

  private generateReflectionText(evaluation: ThoughtEvaluation): string {
    const parts: string[] = []

    parts.push(`Overall Score: ${(evaluation.overall * 100).toFixed(0)}%`)
    parts.push(`Correctness: ${(evaluation.correctness * 100).toFixed(0)}%`)
    parts.push(`Completeness: ${(evaluation.completeness * 100).toFixed(0)}%`)
    parts.push(`Efficiency: ${(evaluation.efficiency * 100).toFixed(0)}%`)

    if (evaluation.strengths.length > 0) {
      parts.push("")
      parts.push("Strengths:")
      for (const s of evaluation.strengths) {
        parts.push(`- ${s}`)
      }
    }

    if (evaluation.weaknesses.length > 0) {
      parts.push("")
      parts.push("Weaknesses:")
      for (const w of evaluation.weaknesses) {
        parts.push(`- ${w}`)
      }
    }

    if (evaluation.suggestions.length > 0) {
      parts.push("")
      parts.push("Suggestions:")
      for (const s of evaluation.suggestions) {
        parts.push(`- ${s}`)
      }
    }

    return parts.join("\n")
  }

  branch(): string | null {
    if (!this.currentId) return null

    const currentNode = this.nodes.get(this.currentId)
    if (!currentNode) return null

    const branchPoint: BranchPoint = {
      nodeId: this.currentId,
      alternativeThoughts: [],
      reasoning: "Current path below threshold, generating alternatives",
    }

    const alternatives = this.generateAlternatives(currentNode.thought)

    branchPoint.alternativeThoughts = alternatives

    if (alternatives.length > 0) {
      const bestAlternative = alternatives[0]
      branchPoint.selectedAlternative = bestAlternative

      const branchId = this.createNode({
        thought: bestAlternative,
        depth: currentNode.depth,
        parentId: currentNode.parentId,
      })

      if (currentNode.parentId) {
        const parent = this.nodes.get(currentNode.parentId)
        if (parent) {
          parent.children.push(branchId)
        }
      }

      currentNode.status = "discarded"
      this.currentId = branchId

      this.branchPoints.push(branchPoint)

      return branchId
    }

    return null
  }

  private generateAlternatives(thought: string): string[] {
    const alternatives: string[] = []

    if (thought.includes("try")) {
      alternatives.push("Use a different approach: " + thought.replace("try", "consider"))
    }

    if (thought.includes("error")) {
      alternatives.push("Handle error case: " + thought.replace("error", "success"))
    }

    if (thought.includes("first")) {
      alternatives.push("Reverse order: " + thought.replace("first", "last"))
    }

    alternatives.push("Simplify: " + thought.split(" ").slice(0, 5).join(" "))
    alternatives.push("Detailed: " + thought + " (with more context)")

    return alternatives.slice(0, this.config.maxBranches)
  }

  private shouldRollback(evaluation: ThoughtEvaluation): boolean {
    if (evaluation.overall < 0.3) {
      return true
    }

    const path = this.getCurrentPath()
    if (path.length >= 2) {
      const recentNodes = path.slice(-3)
      const scores = recentNodes.map((n) => n.score)
      const isDeclining = scores[scores.length - 1] < scores[0] * 0.7
      if (isDeclining) {
        return true
      }
    }

    return false
  }

  rollback(targetId?: string): string | null {
    if (!this.rootId) return null

    if (!targetId) {
      const path = this.getCurrentPath()
      let bestNode: WebCoTThoughtNode | null = null
      let bestScore = 0

      for (const node of path) {
        if (node.score > bestScore && node.status !== "discarded") {
          bestScore = node.score
          bestNode = node
        }
      }

      if (bestNode && bestNode.id !== this.currentId) {
        targetId = bestNode.id
      } else {
        targetId = this.rootId
      }
    }

    const targetNode = this.nodes.get(targetId)
    if (!targetNode) return null

    const currentPath = this.getCurrentPath()
    for (const node of currentPath) {
      if (node.depth >= targetNode.depth && node.id !== targetId) {
        node.status = "discarded"
      }
    }

    this.currentId = targetId

    return targetId
  }

  getCurrentPath(): WebCoTThoughtNode[] {
    const path: WebCoTThoughtNode[] = []
    let current = this.currentId ? this.nodes.get(this.currentId) : null

    while (current) {
      path.unshift(current)
      if (current.parentId) {
        current = this.nodes.get(current.parentId)
      } else {
        break
      }
    }

    return path
  }

  getBestNode(): WebCoTThoughtNode | null {
    let best: WebCoTThoughtNode | null = null
    let bestScore = 0

    for (const node of this.nodes.values()) {
      if (node.score > bestScore && node.status !== "discarded") {
        bestScore = node.score
        best = node
      }
    }

    return best
  }

  generateReport(): string {
    const parts: string[] = []

    parts.push("# WebCoT Reasoning Report")
    parts.push("")
    parts.push(`Total Steps: ${this.stepCount}`)
    parts.push(`Tree Size: ${this.nodes.size}`)
    parts.push(`Branch Points: ${this.branchPoints.length}`)
    parts.push("")

    const path = this.getCurrentPath()
    parts.push("## Current Reasoning Path")

    for (let i = 0; i < path.length; i++) {
      const node = path[i]
      const indent = "  ".repeat(i)
      const score = node.score.toFixed(2)
      const status = node.status
      parts.push(`${indent}[${i}] ${node.thought.slice(0, 50)}... (score: ${score}, ${status})`)
    }

    const best = this.getBestNode()
    if (best) {
      parts.push("")
      parts.push("## Best Node")
      parts.push(`Thought: ${best.thought.slice(0, 100)}`)
      parts.push(`Score: ${best.score.toFixed(2)}`)
      if (best.reflection) {
        parts.push("")
        parts.push("Reflection:")
        parts.push(best.reflection)
      }
    }

    if (this.branchPoints.length > 0) {
      parts.push("")
      parts.push("## Branch Points")
      for (const bp of this.branchPoints) {
        parts.push(`- Node: ${bp.nodeId}, Alternatives: ${bp.alternativeThoughts.length}`)
      }
    }

    return parts.join("\n")
  }

  clear(): void {
    this.nodes.clear()
    this.rootId = null
    this.currentId = null
    this.branchPoints = []
    this.stepCount = 0
  }

  getCurrentId(): string | null {
    return this.currentId
  }

  getCurrentThought(): string | null {
    const node = this.currentId ? this.nodes.get(this.currentId) : null
    return node?.thought || null
  }

  getAllNodes(): WebCoTThoughtNode[] {
    return Array.from(this.nodes.values())
  }

  getConfig(): WebCoTConfig {
    return { ...this.config }
  }

  updateConfig(config: Partial<WebCoTConfig>): void {
    this.config = { ...this.config, ...config }
  }
}

export const globalWebCoT = new WebCoT()

export function createWebCoT(config?: Partial<WebCoTConfig>): WebCoT {
  return new WebCoT(config)
}
