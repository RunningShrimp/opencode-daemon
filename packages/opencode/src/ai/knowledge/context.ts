import path from "node:path"
import { Instance } from "@/project/instance"
import { refreshDerivedKnowledgeGraphSafe } from "./derived"
import { knowledgeGraph, type KnowledgeEdge, type KnowledgeGraph, type KnowledgeNode } from "./index"

export namespace KnowledgeContext {
  export interface RenderOptions {
    graph?: KnowledgeGraph
    rootDir?: string
    limit?: number
    maxRelated?: number
    maxPathDepth?: number
  }

  interface RankedNode {
    node: KnowledgeNode
    score: number
    matchedTerms: string[]
    path?: string
    related: string[]
  }

  export async function renderPromptContext(query: string, options: RenderOptions = {}) {
    const graph = options.graph ?? knowledgeGraph
    await ensureGraphReady(graph, options.rootDir)
    const ranked = getRelevantContext(query, {
      ...options,
      graph,
    })
    if (ranked.length === 0) return undefined

    const lines = [
      "<knowledge_graph>",
      "Derived project graph hints. Use them as structural evidence and short path explanations, but confirm against source files when exact details matter.",
    ]

    for (const item of ranked) {
      lines.push("")
      lines.push(`Node: [${item.node.type}] ${describeNode(item.node)}`)
      if (item.matchedTerms.length > 0) {
        lines.push(`Matched terms: ${item.matchedTerms.join(", ")}`)
      }
      if (item.path) {
        lines.push(`Path: ${item.path}`)
      }
      for (const related of item.related) {
        lines.push(`Related: ${related}`)
      }
    }

    lines.push("</knowledge_graph>")
    return lines.join("\n")
  }

  export function getRelevantContext(query: string, options: RenderOptions = {}) {
    const graph = options.graph ?? knowledgeGraph
    const nodes = rankNodes(graph, query, options.limit ?? 4)
    if (nodes.length === 0) return []
    const projectRoots = findProjectRoots(graph)
    return nodes.map((item) => ({
      ...item,
      path: findPathSummary(graph, projectRoots, item.node.id, options.maxPathDepth ?? 3),
      related: summarizeRelated(graph, item.node, options.maxRelated ?? 2),
    }))
  }

  async function ensureGraphReady(graph: KnowledgeGraph, rootDir = Instance.project?.worktree ?? Instance.worktree) {
    if (graph.getStats().nodeCount > 0) return
    if (!rootDir) return
    await refreshDerivedKnowledgeGraphSafe(graph, rootDir)
  }

  function rankNodes(graph: KnowledgeGraph, query: string, limit: number) {
    const raw = query.trim().toLowerCase()
    const terms = tokenize(query)
    if (!raw || terms.length === 0) return []

    const candidates = new Map<string, KnowledgeNode>()
    for (const term of terms.slice(0, 10)) {
      for (const node of graph.query({ text: term, limit: 16 })) {
        candidates.set(node.id, node)
      }
    }
    for (const node of graph.query({ text: raw.slice(0, 120), limit: 12 })) {
      candidates.set(node.id, node)
    }

    return [...candidates.values()]
      .map((node) => ({ node, ...scoreNode(node, raw, terms) }))
      .filter((item) => item.score > 0)
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
  }

  function scoreNode(node: KnowledgeNode, raw: string, terms: string[]) {
    const name = node.name.toLowerCase()
    const content = node.content.toLowerCase()
    const tags = node.tags.map((tag) => tag.toLowerCase())
    const metadata = Object.values(node.metadata)
      .filter((value): value is string | number | boolean => ["string", "number", "boolean"].includes(typeof value))
      .map((value) => String(value).toLowerCase())

    let score = 0
    const matchedTerms = new Set<string>()

    if (name.includes(raw) || content.includes(raw)) {
      score += 8
      matchedTerms.add(raw)
    }

    for (const term of terms) {
      if (name === term) {
        score += 7
        matchedTerms.add(term)
        continue
      }
      if (name.includes(term)) {
        score += 5
        matchedTerms.add(term)
        continue
      }
      if (content.includes(term)) {
        score += 3
        matchedTerms.add(term)
        continue
      }
      if (tags.some((tag) => tag.includes(term))) {
        score += 2
        matchedTerms.add(term)
        continue
      }
      if (metadata.some((value) => value.includes(term))) {
        score += 1
        matchedTerms.add(term)
      }
    }

    if (node.tags.includes("doc-heading")) score += 1.5
    if (node.tags.includes("file")) score += 1
    if (node.tags.includes("dependency")) score += 0.5

    return {
      score,
      matchedTerms: [...matchedTerms],
    }
  }

  function summarizeRelated(graph: KnowledgeGraph, node: KnowledgeNode, maxRelated: number) {
    const related = graph
      .getEdges(node.id, "both")
      .slice(0, Math.max(0, maxRelated))
      .map((edge) => formatRelation(graph, edge, node.id))
      .filter(Boolean)
    return [...new Set(related)]
  }

  function findProjectRoots(graph: KnowledgeGraph) {
    return graph
      .query({ tags: ["project"], limit: 8 })
      .filter((node) => node.metadata.kind === "project")
      .map((node) => node.id)
  }

  function findPathSummary(graph: KnowledgeGraph, rootIds: string[], targetId: string, maxDepth: number) {
    if (rootIds.includes(targetId)) {
      const node = graph.getNode(targetId)
      return node ? describeNode(node) : undefined
    }

    const visited = new Set(rootIds)
    const queue: { nodeId: string; edges: KnowledgeEdge[] }[] = rootIds.map((nodeId) => ({ nodeId, edges: [] }))

    while (queue.length > 0) {
      const current = queue.shift()!
      if (current.edges.length >= maxDepth) continue
      for (const edge of graph.getEdges(current.nodeId, "out")) {
        if (visited.has(edge.targetId)) continue
        const nextEdges = [...current.edges, edge]
        if (edge.targetId === targetId) {
          return formatPath(graph, nextEdges)
        }
        visited.add(edge.targetId)
        queue.push({
          nodeId: edge.targetId,
          edges: nextEdges,
        })
      }
    }

    return undefined
  }

  function formatPath(graph: KnowledgeGraph, edges: KnowledgeEdge[]) {
    if (edges.length === 0) return undefined
    const pieces: string[] = []
    for (const [index, edge] of edges.entries()) {
      const source = graph.getNode(edge.sourceId)
      const target = graph.getNode(edge.targetId)
      if (!source || !target) continue
      if (index === 0) {
        pieces.push(describeNode(source))
      }
      pieces.push(`--${edge.relation}-->`)
      pieces.push(describeNode(target))
    }
    return pieces.join(" ")
  }

  function formatRelation(graph: KnowledgeGraph, edge: KnowledgeEdge, focusNodeId: string) {
    const source = graph.getNode(edge.sourceId)
    const target = graph.getNode(edge.targetId)
    if (!source || !target) return undefined
    if (edge.sourceId === focusNodeId) {
      return `${describeNode(source)} --${edge.relation}--> ${describeNode(target)}`
    }
    return `${describeNode(source)} --${edge.relation}--> ${describeNode(target)}`
  }

  function describeNode(node: KnowledgeNode) {
    const pathValue = typeof node.metadata.path === "string" ? node.metadata.path : undefined
    const anchor = typeof node.metadata.anchor === "string" ? node.metadata.anchor : undefined
    const version = typeof node.metadata.version === "string" ? node.metadata.version : undefined
    const locator = pathValue ? pathValue + (anchor ? `#${anchor}` : "") : undefined
    const extras = [locator, version].filter(Boolean)
    return extras.length > 0 ? `${node.name} (${extras.join(", ")})` : node.name
  }

  function tokenize(text: string) {
    return [...new Set(text.toLowerCase().split(/[^a-z0-9_./#-]+/g).filter((item) => item.length > 1))]
  }
}

export function defaultProjectName(rootDir = Instance.project?.worktree ?? Instance.worktree) {
  return rootDir ? path.basename(rootDir) : "project"
}