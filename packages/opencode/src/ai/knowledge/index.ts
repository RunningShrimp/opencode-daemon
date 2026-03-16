import { Log } from "@/util/log"
import { Global } from "@/global"
import path from "node:path"
import { Instance } from "@/project/instance"
import fs from "node:fs/promises"
import { existsSync, readFileSync } from "node:fs"
import { CacheStrategyFactory, type ManagedCache } from "@/util/cache"

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
  private activeProjectId: string
  private backupDir = path.join(Global.Path.data, "knowledge-graph")
  private snapshotCache: ManagedCache<{ nodes?: KnowledgeNode[]; edges?: KnowledgeEdge[] }>
  private persistenceSettled = false
  private backendInit?: Promise<void>
  private version = 0
  private syncedVersion = -1
  private syncTask?: Promise<void>

  constructor() {
    this.snapshotCache = CacheStrategyFactory.createCache<{ nodes?: KnowledgeNode[]; edges?: KnowledgeEdge[] }>({
      name: `knowledge-snapshot:${cacheSegment(this.backupDir)}`,
      kind: "graph",
      maxSize: 256,
      ttl: 30 * 24 * 60 * 60 * 1000,
      sochNamespace: `knowledge-snapshot-${cacheSegment(this.backupDir)}`,
      jsonDir: this.backupDir,
    })
    this.activeProjectId = this.projectKey()
    this.restoreBackup(this.activeProjectId)
  }

  addNode(node: Omit<KnowledgeNode, "id" | "timeCreated" | "lastAccessed" | "accessCount">): string {
    this.ensureProjectContext()
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
    this.bumpVersion()
    this.queueSync()

    return id
  }

  getNode(id: string): KnowledgeNode | undefined {
    this.ensureProjectContext()
    const node = this.nodes.get(id)
    if (node) {
      node.lastAccessed = Date.now()
      node.accessCount++
    }
    return node
  }

  updateNode(id: string, updates: Partial<KnowledgeNode>): boolean {
    this.ensureProjectContext()
    const node = this.nodes.get(id)
    if (!node) return false

    Object.assign(node, updates)
    this.bumpVersion()
    this.queueSync()
    return true
  }

  removeNode(id: string): boolean {
    this.ensureProjectContext()
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

    this.bumpVersion()
    this.queueSync()

    return true
  }

  addEdge(
    sourceId: string,
    targetId: string,
    relation: string,
    weight: number = 1.0,
    metadata: Record<string, unknown> = {},
  ): string | null {
    this.ensureProjectContext()
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
    this.bumpVersion()
    this.queueSync()

    return id
  }

  getEdges(nodeId: string, direction: "out" | "in" | "both" = "both"): KnowledgeEdge[] {
    this.ensureProjectContext()
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
    this.ensureProjectContext()
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
    this.ensureProjectContext()
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
    this.ensureProjectContext()
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
    this.ensureProjectContext()
    this.nodes.clear()
    this.edges.clear()
    this.tagIndex.clear()
    log.info("knowledge graph cleared")
    this.bumpVersion()
    this.queueSync()
  }

  export(): { nodes: KnowledgeNode[]; edges: KnowledgeEdge[] } {
    this.ensureProjectContext()
    return this.createSnapshot()
  }

  import(data: { nodes?: KnowledgeNode[]; edges?: KnowledgeEdge[] }): void {
    this.ensureProjectContext()
    this.nodes.clear()
    this.edges.clear()
    this.tagIndex.clear()

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
    this.bumpVersion()
    this.queueSync()
  }

  private projectKey() {
    try {
      return Instance.project.id
    } catch {
      return this.activeProjectId || "global"
    }
  }

  private ensureProjectContext() {
    this.ensurePersistenceStarted()
    const nextProjectId = this.projectKey()
    if (nextProjectId === this.activeProjectId) {
      return
    }

    const previousProjectId = this.activeProjectId
    if (this.nodes.size > 0 || this.edges.size > 0) {
      this.queueSync(previousProjectId, this.createSnapshot(), this.version)
    }

    this.nodes.clear()
    this.edges.clear()
    this.tagIndex.clear()
    this.activeProjectId = nextProjectId
    this.restoreBackup(nextProjectId)

    if (this.persistenceSettled) {
      void this.hydrateProject(nextProjectId).catch((error) => {
        log.warn("knowledge graph deferred hydration failed", {
          projectId: nextProjectId,
          error: String(error),
        })
      })
    }
  }

  private ensurePersistenceStarted() {
    if (this.backendInit) return
    this.backendInit = this.snapshotCache
      .whenPersistentReady()
      .then(async () => {
        this.persistenceSettled = true
        await this.hydrateProject(this.activeProjectId)
      })
      .catch((error) => {
        log.warn("knowledge graph backend init failed", { error: String(error) })
      })
  }

  private async hydrateProject(projectId: string) {
    const snapshot = await this.snapshotCache.getPersistent(projectId).catch(() => undefined)
    if (!snapshot) {
      if (projectId === this.activeProjectId) {
        this.queueSync(projectId)
      }
      return
    }

    if (projectId !== this.activeProjectId) {
      return
    }

    this.restoreSnapshot(snapshot as { nodes?: KnowledgeNode[]; edges?: KnowledgeEdge[] })
    this.syncedVersion = this.version
  }

  private backupFile(projectId: string) {
    return path.join(this.backupDir, `${encodeURIComponent(projectId)}.json`)
  }

  private restoreBackup(projectId: string) {
    const file = this.backupFile(projectId)
    if (!existsSync(file)) {
      return
    }

    try {
      const raw = readFileSync(file, "utf-8")
      const snapshot = JSON.parse(raw) as { nodes?: KnowledgeNode[]; edges?: KnowledgeEdge[] }
      if (projectId === this.activeProjectId) {
        this.restoreSnapshot(snapshot)
      }
    } catch (error) {
      log.warn("knowledge graph backup restore failed", { projectId, error: String(error) })
    }
  }

  private restoreSnapshot(data: { nodes?: KnowledgeNode[]; edges?: KnowledgeEdge[] }) {
    this.nodes.clear()
    this.edges.clear()
    this.tagIndex.clear()

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
  }

  private createSnapshot() {
    return {
      nodes: Array.from(this.nodes.values()),
      edges: Array.from(this.edges.values()),
    }
  }

  private bumpVersion() {
    this.version += 1
  }

  private queueSync(
    projectId = this.activeProjectId,
    snapshot = this.createSnapshot(),
    version = this.version,
  ) {
    const backupTask = this.snapshotCache.set(projectId, snapshot).catch((error) => {
      log.warn("knowledge graph backup sync failed", { projectId, error: String(error) })
    })

    if (!this.persistenceSettled || this.syncTask) return
    this.syncTask = (async () => {
      await backupTask
      if (projectId === this.activeProjectId) {
        this.syncedVersion = version
      }
    })()
      .catch((error) => {
        log.warn("knowledge graph sync failed", { error: String(error) })
      })
      .finally(() => {
        this.syncTask = undefined
        if (projectId === this.activeProjectId && this.syncedVersion < this.version) {
          this.queueSync()
        }
      })
  }
}

export const globalKnowledgeGraph = new KnowledgeGraph()
export const knowledgeGraph = globalKnowledgeGraph

export function createKnowledgeGraph(): KnowledgeGraph {
  return new KnowledgeGraph()
}

function cacheSegment(value: string) {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_") || "default"
}
