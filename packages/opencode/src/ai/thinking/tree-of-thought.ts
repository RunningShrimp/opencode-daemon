import { Log } from "@/util/log"

export interface ToTConfig {
  enabled: boolean
  beamWidth: number
  maxDepth: number
  evaluationThreshold: number
  enableBacktracking: boolean
  expansionsPerStep: number
}

export const DEFAULT_TOT_CONFIG: ToTConfig = {
  enabled: true,
  beamWidth: 3,
  maxDepth: 5,
  evaluationThreshold: 0.6,
  enableBacktracking: true,
  expansionsPerStep: 3,
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
  reasoning?: string
  evaluations?: {
    score: number
    reasoning: string
  }[]
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

export interface LLMClient {
  generate(prompt: string, system?: string): Promise<string>
}

export class TreeOfThought {
  private config: ToTConfig
  private state: ToTState
  private initialized: boolean = false
  private llm: LLMClient | null = null
  private log = Log.create({ service: "ai.thinking.tot" })

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

  setLLM(llm: LLMClient) {
    this.llm = llm
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
      this.initialize()
    }

    const rootNode: ThoughtNode = {
      id: this.generateId(),
      content: initialPrompt,
      score: 1.0,
      confidence: 1.0,
      parentId: null,
      children: [],
      depth: 0,
      isLeaf: false,
      createdAt: Date.now(),
      reasoning: "Root problem statement",
    }

    this.state.root = rootNode
    this.state.nodes.set(rootNode.id, rootNode)
    this.state.frontier = [rootNode]
    this.state.bestPath = [rootNode]
    this.state.bestScore = 1.0

    return rootNode
  }

  async expandFrontier(context?: string): Promise<void> {
    if (!this.initialized || !this.llm) {
      throw new Error("ToT not initialized or LLM not set")
    }

    const newFrontier: ThoughtNode[] = []
    // Process current frontier nodes
    // If frontier is empty but we have nodes, we might need to backtrack or we are done
    if (this.state.frontier.length === 0 && this.config.enableBacktracking) {
        // Simple backtracking: find non-leaf nodes that haven't been fully expanded? 
        // For now, we assume frontier contains the active candidates.
        return
    }

    const nodesToExpand = this.state.frontier.filter(n => !n.isLeaf && n.depth < this.config.maxDepth)
    
    if (nodesToExpand.length === 0) {
        this.log.info("No nodes to expand in frontier")
        return
    }

    this.log.info(`Expanding ${nodesToExpand.length} nodes from frontier`)

    for (const node of nodesToExpand) {
      // Generate expansions
      const expansions = await this.generateExpansions(node, context)
      
      for (const expansionContent of expansions) {
        // Evaluate each expansion
        const evaluation = await this.evaluateThought(expansionContent, node, context)
        
        if (evaluation.score >= this.config.evaluationThreshold) {
          const newNode: ThoughtNode = {
            id: this.generateId(),
            content: expansionContent,
            score: evaluation.score,
            confidence: evaluation.confidence,
            parentId: node.id,
            children: [],
            depth: node.depth + 1,
            isLeaf: false,
            createdAt: Date.now(),
            reasoning: evaluation.reasoning,
            evaluations: [{ score: evaluation.score, reasoning: evaluation.reasoning }]
          }

          node.children.push(newNode.id)
          this.state.nodes.set(newNode.id, newNode)
          newFrontier.push(newNode)
          
          // Check if this path is the new best path
          const pathScore = this.calculatePathScore(newNode)
          if (pathScore > this.state.bestScore) {
             this.state.bestScore = pathScore
             this.state.bestPath = this.getPathToNode(newNode)
          }
        }
      }
      
      // Mark parent as expanded/processed for this round (removed from next frontier)
    }

    // Prune and select new frontier based on beam width
    newFrontier.sort((a, b) => b.score - a.score)
    this.state.frontier = newFrontier.slice(0, this.config.beamWidth)
    
    this.log.info(`New frontier size: ${this.state.frontier.length}`)
  }

  private calculatePathScore(node: ThoughtNode): number {
      // Simple path score: average of node scores along the path
      const path = this.getPathToNode(node)
      if (path.length === 0) return 0
      const sum = path.reduce((acc, n) => acc + n.score, 0)
      return sum / path.length
  }

  private async generateExpansions(node: ThoughtNode, context?: string): Promise<string[]> {
    if (!this.llm) return []

    const prompt = `
You are an intelligent agent solving a complex problem.
Current Goal/Thought: "${node.content}"
${context ? `Additional Context: ${context}` : ""}

Generate ${this.config.expansionsPerStep} distinct next steps or sub-thoughts to advance towards the solution.
Each thought should be a concrete, actionable step or a specific reasoning path.
Avoid vague statements.

Output Format:
- [Thought 1]
- [Thought 2]
...
`
    try {
      const response = await this.llm.generate(prompt)
      return response
        .split("\n")
        .map(line => line.trim())
        .filter(line => line.startsWith("-"))
        .map(line => line.replace(/^-\s*/, "").trim())
        .filter(line => line.length > 0)
        .slice(0, this.config.expansionsPerStep)
    } catch (e) {
      this.log.error("Failed to generate expansions", { error: e })
      return []
    }
  }

  private async evaluateThought(
    thought: string,
    parent: ThoughtNode,
    context?: string,
  ): Promise<{ score: number; confidence: number; reasoning: string }> {
    if (!this.llm) return { score: 0.5, confidence: 0.5, reasoning: "No LLM" }

    const prompt = `
Evaluate the following thought/step in the context of solving the parent problem.

Parent Thought: "${parent.content}"
Proposed Step: "${thought}"
${context ? `Context: ${context}` : ""}

Assess the potential of this step to lead to a correct solution.
Rate it from 0.0 to 1.0 (1.0 being excellent/certain).
Provide a brief reasoning.

Output Format:
Score: <0.0-1.0>
Reasoning: <one sentence reasoning>
`
    try {
        const response = await this.llm.generate(prompt)
        const scoreMatch = response.match(/Score:\s*([\d.]+)/i)
        const reasoningMatch = response.match(/Reasoning:\s*(.+)/i)
        
        const score = scoreMatch ? parseFloat(scoreMatch[1]) : 0.5
        const reasoning = reasoningMatch ? reasoningMatch[1] : "Parsed from evaluation"
        
        return {
            score: Math.min(1, Math.max(0, score)),
            confidence: score, // Using score as confidence for now
            reasoning
        }
    } catch (e) {
        this.log.error("Failed to evaluate thought", { error: e })
        return { score: 0.5, confidence: 0.5, reasoning: "Evaluation failed" }
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
      // If frontier empty, fallback to best path leaf
      if (this.state.bestPath.length > 0) {
          const best = this.state.bestPath[this.state.bestPath.length - 1]
          return {
              selectedNode: best,
              alternatives: [],
              reasoning: "Frontier empty, selecting best known path leaf",
              confidence: best.confidence
          }
      }
      return this.backtrack(context)
    }

    // Sort frontier by score
    const sorted = [...this.state.frontier].sort((a, b) => b.score - a.score)
    const selected = sorted[0]
    const alternatives = sorted.slice(1)

    return {
      selectedNode: selected,
      alternatives,
      reasoning: `Selected highest scoring branch (score: ${selected.score.toFixed(2)})`,
      confidence: selected.confidence,
    }
  }

  private backtrack(_context?: string): ToTDecision {
      // Fallback logic
      if (this.state.root) {
          return {
              selectedNode: this.state.root,
              alternatives: [],
              reasoning: "Backtracked to root",
              confidence: 0.1
          }
      }
      throw new Error("Cannot backtrack, no root")
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
