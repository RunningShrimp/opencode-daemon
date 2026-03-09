export interface ToTConfig {
  enabled: boolean
  beamWidth: number
  maxDepth: number
  evaluationThreshold: number
  enableBacktracking: boolean
  expansionsPerStep: number
}

export const DEFAULT_TOT_CONFIG: ToTConfig = {
  enabled: false,
  beamWidth: 3,
  maxDepth: 3,
  evaluationThreshold: 0.5,
  enableBacktracking: true,
  expansionsPerStep: 2,
}

export interface ThoughtNode {
  id: string
  content: string
  score: number
  confidence: number
  parentId: string | null
  children: string[]
  depth: number
  isLeaf: boolean
  createdAt: number
  toolCall?: {
    tool: string
    input: Record<string, unknown>
    output?: string
  }
}

export interface ToTState {
  root: ThoughtNode | null
  nodes: Map<string, ThoughtNode>
  frontier: ThoughtNode[]
  bestPath: ThoughtNode[]
  bestScore: number
}

export interface ToTDecision {
  selectedNode: ThoughtNode
  alternatives: ThoughtNode[]
  reasoning: string
  confidence: number
}

export class TreeOfThought {
  private config: ToTConfig
  private state: ToTState
  private initialized: boolean = false

  constructor(config: Partial<ToTConfig> = {}) {
    this.config = { ...DEFAULT_TOT_CONFIG, ...config }
    this.state = {
      root: null,
      nodes: new Map(),
      frontier: [],
      bestPath: [],
      bestScore: 0,
    }
  }

  initialize(): void {
    this.state = {
      root: null,
      nodes: new Map(),
      frontier: [],
      bestPath: [],
      bestScore: 0,
    }
    this.initialized = true
  }

  async startThinking(initialPrompt: string): Promise<ThoughtNode> {
    if (!this.initialized) {
      throw new Error("ToT not initialized")
    }

    const rootNode: ThoughtNode = {
      id: this.generateId(),
      content: initialPrompt,
      score: 1.0,
      confidence: 0.5,
      parentId: null,
      children: [],
      depth: 0,
      isLeaf: false,
      createdAt: Date.now(),
    }

    this.state.root = rootNode
    this.state.nodes.set(rootNode.id, rootNode)
    this.state.frontier = [rootNode]

    return rootNode
  }

  async expandFrontier(context?: string): Promise<void> {
    if (!this.initialized) {
      throw new Error("ToT not initialized")
    }

    const newFrontier: ThoughtNode[] = []

    for (const node of this.state.frontier) {
      if (node.depth >= this.config.maxDepth) {
        node.isLeaf = true
        continue
      }

      const expansions = await this.generateExpansions(node, context)

      for (const expansion of expansions) {
        const evaluation = await this.evaluateThought(expansion, node, context)

        if (evaluation.isValid && evaluation.score >= this.config.evaluationThreshold) {
          const newNode: ThoughtNode = {
            id: this.generateId(),
            content: expansion,
            score: evaluation.score,
            confidence: evaluation.confidence,
            parentId: node.id,
            children: [],
            depth: node.depth + 1,
            isLeaf: false,
            createdAt: Date.now(),
          }

          node.children.push(newNode.id)
          this.state.nodes.set(newNode.id, newNode)
          newFrontier.push(newNode)

          if (newNode.score > this.state.bestScore) {
            this.state.bestScore = newNode.score
            this.state.bestPath = this.getPathToNode(newNode)
          }
        }
      }
    }

    newFrontier.sort((a, b) => b.score - a.score)
    this.state.frontier = newFrontier.slice(0, this.config.beamWidth)
  }

  private async generateExpansions(_node: ThoughtNode, _context?: string): Promise<string[]> {
    try {
      const expansions: string[] = []
      const lines = [
        "Approach 1: Consider breaking the problem into smaller sub-problems",
        "Approach 2: Try a different algorithm or data structure",
        "Approach 3: Focus on edge cases and error handling",
      ]

      for (const line of lines) {
        const approach = line.replace(/Approach \d+: /, "").trim()
        if (approach) expansions.push(approach)
      }

      return expansions.slice(0, this.config.expansionsPerStep)
    } catch (_error) {
      return []
    }
  }

  private async evaluateThought(
    thought: string,
    _parent: ThoughtNode,
    _context?: string,
  ): Promise<{ score: number; confidence: number; reasoning: string; isValid: boolean }> {
    let score = 0.5
    let confidence = 0.5

    if (thought.includes("error") || thought.includes("fail")) {
      score -= 0.2
    }

    if (thought.includes("success") || thought.includes("complete")) {
      score += 0.1
      confidence += 0.1
    }

    if (thought.includes("security") || thought.includes("vulnerability")) {
      score -= 0.1
    }

    return {
      score,
      confidence,
      reasoning: "Based on content analysis",
      isValid: true,
    }
  }

  private getPathToNode(node: ThoughtNode): ThoughtNode[] {
    const path: ThoughtNode[] = []
    let current: ThoughtNode | undefined = node

    while (current) {
      path.unshift(current)
      current = current.parentId ? this.state.nodes.get(current.parentId) : undefined
    }

    return path
  }

  makeDecision(context?: string): ToTDecision {
    if (this.state.frontier.length === 0) {
      if (this.config.enableBacktracking) {
        return this.backtrack(context)
      }

      const bestNode = this.state.bestPath[this.state.bestPath.length - 1]
      return {
        selectedNode: bestNode ?? this.state.root!,
        alternatives: [],
        reasoning: "Using best known path",
        confidence: this.state.bestScore,
      }
    }

    const selected = this.state.frontier[0]
    const alternatives = this.state.frontier.slice(1)

    return {
      selectedNode: selected,
      alternatives,
      reasoning: `Selected highest scoring branch (score: ${selected.score.toFixed(2)})`,
      confidence: selected.confidence,
    }
  }

  private backtrack(_context?: string): ToTDecision {
    return {
      selectedNode: this.state.root!,
      alternatives: [],
      reasoning: "Backtracked to root",
      confidence: 0.5,
    }
  }

  getCurrentState(): ToTState {
    return { ...this.state }
  }

  getBestPath(): ThoughtNode[] {
    return [...this.state.bestPath]
  }

  getFrontier(): ThoughtNode[] {
    return [...this.state.frontier]
  }

  visualize(): string {
    if (!this.state.root) return "(empty)"

    const lines: string[] = []
    this.visualizeNode(this.state.root, "", lines)
    return lines.join("\n")
  }

  private visualizeNode(node: ThoughtNode, prefix: string, lines: string[]): void {
    const marker = node.isLeaf ? "Leaf" : "Node"
    lines.push(`${prefix}[${marker}] ${node.content.slice(0, 50)}... (score: ${node.score.toFixed(2)})`)

    const children = node.children
      .map((id) => this.state.nodes.get(id))
      .filter((n): n is ThoughtNode => n !== undefined)

    for (let i = 0; i < children.length; i++) {
      const isLast = i === children.length - 1
      const newPrefix = prefix + (isLast ? "    " : "│   ")
      this.visualizeNode(children[i], newPrefix, lines)
    }
  }

  reset(): void {
    this.state = {
      root: null,
      nodes: new Map(),
      frontier: [],
      bestPath: [],
      bestScore: 0,
    }
    this.initialized = false
  }

  private generateId(): string {
    return `thought_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
  }
}

class ToTManager {
  private instances: Map<string, TreeOfThought> = new Map()

  getOrCreate(sessionId: string, config?: Partial<ToTConfig>): TreeOfThought {
    let tot = this.instances.get(sessionId)
    if (!tot) {
      tot = new TreeOfThought(config)
      this.instances.set(sessionId, tot)
    }
    return tot
  }

  remove(sessionId: string): void {
    const tot = this.instances.get(sessionId)
    if (tot) {
      tot.reset()
      this.instances.delete(sessionId)
    }
  }

  clear(): void {
    for (const tot of this.instances.values()) {
      tot.reset()
    }
    this.instances.clear()
  }
}

export const globalToTManager = new ToTManager()

export function getToT(sessionId: string, config?: Partial<ToTConfig>): TreeOfThought {
  return globalToTManager.getOrCreate(sessionId, config)
}
