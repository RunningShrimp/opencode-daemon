import { Log } from "@/util/log"

const log = Log.create({ service: "knowledge" })

export interface KnowledgeNode {
  id: string
  type: "concept" | "entity" | "fact" | "pattern" | "procedure"
  name: string
  content: string
  tags: string[]
  metadata: Record<string, unknown>
  timeCreated: number
  lastAccessed: number
  accessCount: number
}

export interface KnowledgeEdge {
  id: string
  sourceId: string
  targetId: string
  relation: string
  weight: number
  metadata: Record<string, unknown>
}

export interface KnowledgeQuery {
  text?: string
  types?: KnowledgeNode["type"][]
  tags?: string[]
  relation?: string
  limit?: number
}

export class KnowledgeGraph {
  private nodes: Map<string, KnowledgeNode> = new Map()
  private edges: Map<string, KnowledgeEdge> = new Map()
  private tagIndex: Map<string, Set<string>> = new Map()

  addNode(node: Omit<KnowledgeNode, "id" | "timeCreated" | "lastAccessed" | "accessCount">): string {
    const id = `node-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`

    const fullNode: KnowledgeNode = {
      ...node,
      id,
      timeCreated: Date.now(),
      lastAccessed: Date.now(),
      accessCount: 0,
    }

    this.nodes.set(id, fullNode)

    for (const tag of node.tags) {
      if (!this.tagIndex.has(tag)) {
        this.tagIndex.set(tag, new Set())
      }
      this.tagIndex.get(tag)!.add(id)
    }

    log.debug("node added", { id, type: node.type, name: node.name })

    return id
  }

  getNode(id: string): KnowledgeNode | undefined {
    const node = this.nodes.get(id)
    if (node) {
      node.lastAccessed = Date.now()
      node.accessCount++
    }
    return node
  }

  updateNode(id: string, updates: Partial<KnowledgeNode>): boolean {
    const node = this.nodes.get(id)
    if (!node) return false

    Object.assign(node, updates)
    return true
  }

  removeNode(id: string): boolean {
    const node = this.nodes.get(id)
    if (!node) return false

    for (const tag of node.tags) {
      this.tagIndex.get(tag)?.delete(id)
    }

    this.nodes.delete(id)

    for (const [edgeId, edge] of this.edges) {
      if (edge.sourceId === id || edge.targetId === id) {
        this.edges.delete(edgeId)
      }
    }

    return true
  }

  addEdge(
    sourceId: string,
    targetId: string,
    relation: string,
    weight: number = 1.0,
    metadata: Record<string, unknown> = {},
  ): string | null {
    if (!this.nodes.has(sourceId) || !this.nodes.has(targetId)) {
      return null
    }

    const id = `edge-${Date.now()}-${Math.random().toString(36).slice(2, 9)}`

    const edge: KnowledgeEdge = {
      id,
      sourceId,
      targetId,
      relation,
      weight,
      metadata,
    }

    this.edges.set(id, edge)

    log.debug("edge added", { id, sourceId, targetId, relation })

    return id
  }

  getEdges(nodeId: string, direction: "out" | "in" | "both" = "both"): KnowledgeEdge[] {
    const result: KnowledgeEdge[] = []

    for (const edge of this.edges.values()) {
      if (direction === "out" && edge.sourceId === nodeId) {
        result.push(edge)
      } else if (direction === "in" && edge.targetId === nodeId) {
        result.push(edge)
      } else if (direction === "both" && (edge.sourceId === nodeId || edge.targetId === nodeId)) {
        result.push(edge)
      }
    }

    return result
  }

  query(query: KnowledgeQuery): KnowledgeNode[] {
    let results: KnowledgeNode[] = []

    if (query.text) {
      const lowerText = query.text.toLowerCase()
      for (const node of this.nodes.values()) {
        if (node.name.toLowerCase().includes(lowerText) || node.content.toLowerCase().includes(lowerText)) {
          results.push(node)
        }
      }
    } else {
      results = Array.from(this.nodes.values())
    }

    if (query.types && query.types.length > 0) {
      results = results.filter((n) => query.types!.includes(n.type))
    }

    if (query.tags && query.tags.length > 0) {
      results = results.filter((n) => query.tags!.some((t) => n.tags.includes(t)))
    }

    results.sort((a, b) => b.accessCount - a.accessCount)

    return results.slice(0, query.limit || 50)
  }

  getRelated(nodeId: string, maxDepth: number = 2): KnowledgeNode[] {
    const visited = new Set<string>()
    const result: KnowledgeNode[] = []

    const traverse = (id: string, depth: number) => {
      if (depth > maxDepth || visited.has(id)) return
      visited.add(id)

      const edges = this.getEdges(id, "both")
      for (const edge of edges) {
        const relatedId = edge.sourceId === id ? edge.targetId : edge.sourceId
        const node = this.nodes.get(relatedId)
        if (node && !visited.has(relatedId)) {
          result.push(node)
          traverse(relatedId, depth + 1)
        }
      }
    }

    traverse(nodeId, 1)

    return result
  }

  getStats(): { nodeCount: number; edgeCount: number; typeBreakdown: Record<string, number> } {
    const typeBreakdown: Record<string, number> = {}

    for (const node of this.nodes.values()) {
      typeBreakdown[node.type] = (typeBreakdown[node.type] || 0) + 1
    }

    return {
      nodeCount: this.nodes.size,
      edgeCount: this.edges.size,
      typeBreakdown,
    }
  }

  clear(): void {
    this.nodes.clear()
    this.edges.clear()
    this.tagIndex.clear()
    log.info("knowledge graph cleared")
  }

  export(): { nodes: KnowledgeNode[]; edges: KnowledgeEdge[] } {
    return {
      nodes: Array.from(this.nodes.values()),
      edges: Array.from(this.edges.values()),
    }
  }

  import(data: { nodes?: KnowledgeNode[]; edges?: KnowledgeEdge[] }): void {
    if (data.nodes) {
      for (const node of data.nodes) {
        this.nodes.set(node.id, node)
        for (const tag of node.tags) {
          if (!this.tagIndex.has(tag)) {
            this.tagIndex.set(tag, new Set())
          }
          this.tagIndex.get(tag)!.add(node.id)
        }
      }
    }

    if (data.edges) {
      for (const edge of data.edges) {
        this.edges.set(edge.id, edge)
      }
    }

    log.info("knowledge graph imported", {
      nodes: data.nodes?.length || 0,
      edges: data.edges?.length || 0,
    })
  }
}

export const globalKnowledgeGraph = new KnowledgeGraph()

export function createKnowledgeGraph(): KnowledgeGraph {
  return new KnowledgeGraph()
}
