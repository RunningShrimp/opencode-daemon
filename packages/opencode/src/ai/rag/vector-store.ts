import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "@/global"
import { Log } from "@/util/log"
import { loadSochDBModule } from "@/util/sochdb"
import { CacheStrategyFactory, type ManagedCache } from "@/util/cache"
import type { QueryEmbeddingBundle, RetrievalEmbeddingProfile } from "./embedding"

export interface VectorEntry {
  id: string
  sessionId: string
  path: string
  content: string
  embedding?: number[]
  coarseQuantized?: number[]
  fineQuantized?: number[]
  fineDimensions?: number
  retrievalProfile?: RetrievalEmbeddingProfile
  quantized?: boolean
  timestamp: number
  startLine?: number
  endLine?: number
}

export interface VectorSearchResult {
  id: string
  sessionId: string
  path: string
  content: string
  score: number
  coarseScore?: number
  fineScore?: number
  retrievalProfile?: RetrievalEmbeddingProfile
  startLine?: number
  endLine?: number
}

export interface VectorSearchOptions {
  projectId?: string
  limit?: number
  minScore?: number
  rerankLimit?: number
}

type VectorSearchQuery = number[] | QueryEmbeddingBundle

const MAX_VECTORS_PER_PROJECT = 50000
const MIN_IMPORTANCE = 0.3
const log = Log.create({ service: "vector-store" })

interface VectorDatabaseBackend {
  initialize(): Promise<void>
  isReady(): boolean
  replaceProject(projectId: string, entries: VectorEntry[]): Promise<void>
  deleteProject(projectId: string): Promise<void>
}

class SochVectorBackend implements VectorDatabaseBackend {
  private mod: Awaited<ReturnType<typeof loadSochDBModule>> | undefined
  private ready = false

  constructor(private readonly rootDir = path.join(Global.Path.data, "sochdb", "vectors")) {}

  async initialize(): Promise<void> {
    if (this.ready) return

    await fs.mkdir(this.rootDir, { recursive: true })
    this.mod = await loadSochDBModule()
    this.ready = true
  }

  isReady(): boolean {
    return this.ready
  }

  async replaceProject(projectId: string, entries: VectorEntry[]): Promise<void> {
    if (!this.ready) return
    await this.rebuildIndex(projectId, entries).catch((error) => {
      log.warn("sochdb vector index rebuild failed", { projectId, error: String(error) })
    })
  }

  async deleteProject(projectId: string): Promise<void> {
    if (!this.ready) return
    await fs.rm(this.indexPath(projectId), { recursive: true, force: true }).catch(() => undefined)
  }

  private indexPath(projectId: string): string {
    return path.join(this.rootDir, "indexes", this.slug(projectId))
  }

  private slug(projectId: string): string {
    return projectId.replace(/[^A-Za-z0-9_]+/g, "_").slice(0, 48) || "default"
  }

  private createIndex(indexPath: string, dimension: number) {
    const VectorIndex = this.mod?.VectorIndex
    if (!VectorIndex) {
      throw new Error("@sochdb/sochdb does not export VectorIndex")
    }

    const config = {
      dimension,
      metric: "cosine",
      m: 16,
      efConstruction: 100,
    }

    try {
      return new VectorIndex(indexPath, config)
    } catch {
      try {
        return new VectorIndex({ path: indexPath, ...config })
      } catch {
        return new VectorIndex(config)
      }
    }
  }

  private async rebuildIndex(projectId: string, entries: VectorEntry[]) {
    if (!entries.length || !this.mod?.VectorIndex) {
      await fs.rm(this.indexPath(projectId), { recursive: true, force: true }).catch(() => undefined)
      return
    }

    const indexPath = this.indexPath(projectId)
    await fs.rm(indexPath, { recursive: true, force: true }).catch(() => undefined)
    await fs.mkdir(path.dirname(indexPath), { recursive: true })

    const sample = dequantizedCoarse(entries[0])
    const index = this.createIndex(indexPath, sample.length)
    const vectors = entries.map((entry) => dequantizedCoarse(entry))
    const labels = entries.map((entry) => String(entry.id))

    if (typeof index.bulkBuild === "function") {
      await Promise.resolve(index.bulkBuild(vectors, labels))
    } else if (typeof index.insertBatch === "function") {
      try {
        await Promise.resolve(index.insertBatch(vectors, labels))
      } catch {
        await Promise.resolve(index.insertBatch(labels, vectors))
      }
      if (typeof index.build === "function") {
        await Promise.resolve(index.build())
      }
    } else {
      if (typeof index.add === "function") {
        for (const entry of entries) {
          await Promise.resolve(index.add(String(entry.id), dequantizedCoarse(entry)))
        }
      }
      if (typeof index.build === "function") {
        await Promise.resolve(index.build())
      }
    }

    if (typeof index.close === "function") {
      await Promise.resolve(index.close())
    }
  }
}

export class VectorStore {
  private vectors: Map<string, Map<string, VectorEntry>> = new Map()
  private loadedProjects = new Set<string>()
  private hydratedProjects = new Set<string>()
  private maxSize: number
  private ttlMs: number
  private storageDir: string
  private backend?: VectorDatabaseBackend
  private snapshotCache: ManagedCache<{ entries: VectorEntry[] }>
  private backendInit?: Promise<void>
  private persistenceInit?: Promise<void>
  private backendReady = false
  private persistenceSettled = false
  private projectVersions = new Map<string, number>()
  private syncedVersions = new Map<string, number>()
  private syncTasks = new Map<string, Promise<void>>()

  constructor(
    maxSize: number = MAX_VECTORS_PER_PROJECT,
    ttlDays: number = 7,
    storageDir?: string,
    backend?: VectorDatabaseBackend | false,
  ) {
    this.maxSize = maxSize
    this.ttlMs = ttlDays * 24 * 60 * 60 * 1000
    this.storageDir = storageDir ?? path.join(Global.Path.data, "vector-store")
    this.backend = backend === false ? undefined : backend ?? new SochVectorBackend()
    this.snapshotCache = CacheStrategyFactory.createCache<{ entries: VectorEntry[] }>({
      name: `vector-snapshot:${cacheSegment(this.storageDir)}`,
      kind: "vector",
      maxSize: 256,
      ttl: this.ttlMs,
      sochNamespace: `vectors-snapshot-${cacheSegment(this.storageDir)}`,
      jsonDir: this.storageDir,
    })
  }

  async addVector(entry: VectorEntry): Promise<void> {
    await this.addVectors([entry])
  }

  async addVectors(entries: VectorEntry[]): Promise<void> {
    this.ensurePersistenceStarted()
    const grouped = new Map<string, VectorEntry[]>()

    for (const entry of entries) {
      const projectId = entry.sessionId
      const list = grouped.get(projectId) ?? []
      list.push({
        ...entry,
        timestamp: Date.now(),
      })
      grouped.set(projectId, list)
    }

    for (const [projectId, projectEntries] of grouped) {
      await this.loadProject(projectId)
      const projectStore = this.projectStore(projectId)

      for (const entry of projectEntries) {
        projectStore.set(entry.id, normalizeStoredEntry(entry))
      }

      this.pruneExpired(projectStore)
      while (projectStore.size > this.maxSize) {
        this.evictLRU(projectStore)
      }

      this.bumpProjectVersion(projectId)
      await this.persistProject(projectId)
      this.queueBackendSync(projectId)
    }
  }

  async search(queryInput: VectorSearchQuery, limitOrOptions: number | VectorSearchOptions = 10): Promise<VectorSearchResult[]> {
    this.ensurePersistenceStarted()
    const options = typeof limitOrOptions === "number" ? { limit: limitOrOptions } : limitOrOptions
    const limit = options.limit ?? 10
    const minScore = options.minScore ?? MIN_IMPORTANCE
    const rerankLimit = options.rerankLimit ?? Math.max(limit * 6, 24)
    const query = Array.isArray(queryInput) ? { coarse: queryInput } : queryInput

    if (options.projectId) await this.loadProject(options.projectId)

    const candidates: VectorSearchResult[] = []
    const projects = options.projectId ? [options.projectId] : Array.from(this.vectors.keys())

    for (const projectId of projects) {
      const projectStore = this.vectors.get(projectId)
      if (!projectStore) continue

      this.pruneExpired(projectStore)

      for (const entry of projectStore.values()) {
        const coarseScore = this.cosineSimilarityToQuantized(query.coarse, entry.coarseQuantized ?? [])
        if (coarseScore > minScore) {
          candidates.push({
            id: entry.id,
            sessionId: entry.sessionId,
            path: entry.path,
            content: entry.content,
            score: coarseScore,
            coarseScore,
            retrievalProfile: entry.retrievalProfile,
            startLine: entry.startLine,
            endLine: entry.endLine,
          })
        }
      }
    }

    const reranked = candidates
      .sort((a, b) => (b.coarseScore ?? b.score) - (a.coarseScore ?? a.score))
      .slice(0, rerankLimit)
      .map((candidate) => {
        const entry = this.vectors.get(candidate.sessionId)?.get(candidate.id)
        const fineQuery = entry?.retrievalProfile && 'fineByProfile' in query
          ? query.fineByProfile[entry.retrievalProfile]
          : undefined
        if (!entry || !fineQuery || !entry.fineQuantized || entry.fineDimensions !== fineQuery.length) {
          return candidate
        }

        const fineScore = this.cosineSimilarityToQuantized(fineQuery, entry.fineQuantized)
        return {
          ...candidate,
          fineScore,
          score: (candidate.coarseScore ?? candidate.score) * 0.35 + fineScore * 0.65,
        }
      })

    reranked.sort((a, b) => b.score - a.score)
    return reranked.slice(0, limit)
  }

  private cosineSimilarityToQuantized(query: number[], quantized: number[]): number {
    if (query.length !== quantized.length || query.length === 0) return 0
    let dotProduct = 0
    let normQuery = 0
    let normStored = 0
    for (let i = 0; i < query.length; i++) {
      const stored = quantized[i] / 127
      dotProduct += query[i] * stored
      normQuery += query[i] * query[i]
      normStored += stored * stored
    }
    if (normQuery === 0 || normStored === 0) return 0
    return dotProduct / (Math.sqrt(normQuery) * Math.sqrt(normStored))
  }

  private evictLRU(projectStore: Map<string, VectorEntry>): void {
    let oldest: VectorEntry | null = null
    let oldestKey: string | null = null

    for (const [key, entry] of projectStore) {
      if (!oldest || entry.timestamp < oldest.timestamp) {
        oldest = entry
        oldestKey = key
      }
    }

    if (oldestKey) {
      projectStore.delete(oldestKey)
    }
  }

  async deleteBySession(sessionId: string): Promise<void> {
    this.ensurePersistenceStarted()
    this.vectors.delete(sessionId)
    this.loadedProjects.delete(sessionId)
    this.hydratedProjects.delete(sessionId)
    await this.snapshotCache.delete(sessionId).catch(() => undefined)
    await this.backendInit
    if (this.backendReady) {
      await this.backend?.deleteProject(sessionId).catch(() => undefined)
    }
  }

  async deleteByPath(projectId: string, filePath: string): Promise<number> {
    this.ensurePersistenceStarted()
    await this.loadProject(projectId)
    const projectStore = this.projectStore(projectId)
    let removed = 0
    for (const [key, entry] of projectStore) {
      if (entry.path === filePath) {
        projectStore.delete(key)
        removed++
      }
    }
    if (removed > 0) {
      this.bumpProjectVersion(projectId)
      await this.persistProject(projectId)
      this.queueBackendSync(projectId)
    }
    return removed
  }

  async clear(projectId?: string): Promise<void> {
    this.ensurePersistenceStarted()
    if (projectId) {
      this.vectors.delete(projectId)
      this.loadedProjects.delete(projectId)
      this.hydratedProjects.delete(projectId)
      this.projectVersions.delete(projectId)
      this.syncedVersions.delete(projectId)
      await this.snapshotCache.delete(projectId).catch(() => undefined)
      await this.backendInit
      if (this.backendReady) {
        await this.backend?.deleteProject(projectId).catch(() => undefined)
      }
      return
    }

    this.vectors.clear()
    this.loadedProjects.clear()
    this.hydratedProjects.clear()
    await this.snapshotCache.clear().catch(() => undefined)
  }

  async getProjectSize(projectId: string): Promise<number> {
    this.ensurePersistenceStarted()
    await this.loadProject(projectId)
    const projectStore = this.vectors.get(projectId)
    if (!projectStore) return 0
    this.pruneExpired(projectStore)
    return projectStore.size
  }

  private async loadProject(projectId: string): Promise<void> {
    if (this.loadedProjects.has(projectId)) return

    const store = new Map<string, VectorEntry>()
    const snapshot = await this.snapshotCache.get(projectId).catch((error) => {
      log.warn("failed to load vector snapshot from cache", { projectId, error: String(error) })
      return undefined
    })
    if (snapshot?.entries) {
      for (const entry of snapshot.entries) {
        store.set(entry.id, normalizeStoredEntry(entry))
      }
      this.pruneExpired(store)
    }

    this.vectors.set(projectId, store)
    this.loadedProjects.add(projectId)
    this.projectVersions.set(projectId, 0)

    if (this.persistenceSettled) {
      void this.hydrateFromPersistent(projectId).catch((error) => {
        log.warn("vector persistent hydration failed", { projectId, error: String(error) })
      })
    }
  }

  private projectStore(projectId: string) {
    const projectStore = this.vectors.get(projectId)
    if (!projectStore) throw new Error(`Project vector store not loaded: ${projectId}`)
    return projectStore
  }

  private pruneExpired(projectStore: Map<string, VectorEntry>) {
    const now = Date.now()
    for (const [key, entry] of projectStore) {
      if (now - entry.timestamp > this.ttlMs) {
        projectStore.delete(key)
      }
    }
  }

  private async persistProject(projectId: string) {
    const projectStore = this.vectors.get(projectId)
    if (!projectStore) return
    await this.snapshotCache.set(projectId, { entries: Array.from(projectStore.values()) })
  }

  private ensurePersistenceStarted() {
    if (!this.backendInit) {
      this.backendInit = this.initializeBackend().catch((error) => {
        log.warn("vector backend init failed", { error: String(error) })
      })
    }

    if (!this.persistenceInit) {
      this.persistenceInit = this.snapshotCache
        .whenPersistentReady()
        .then(() => {
          this.persistenceSettled = true
          return Promise.allSettled(Array.from(this.loadedProjects).map((projectId) => this.hydrateFromPersistent(projectId)))
        })
        .catch((error) => {
          log.warn("vector snapshot cache init failed", { error: String(error) })
        })
    }
  }

  private async initializeBackend() {
    if (!this.backend) return
    await this.backend.initialize()
    this.backendReady = this.backend.isReady()
    if (!this.backendReady) return

    for (const projectId of this.loadedProjects) {
      this.queueBackendSync(projectId)
    }
  }

  private async hydrateFromPersistent(projectId: string) {
    if (this.hydratedProjects.has(projectId)) return

    const snapshot = await this.snapshotCache.getPersistent(projectId).catch((error) => {
      log.warn("failed to load project from persistent vector cache", { projectId, error: String(error) })
      return undefined
    })

    if (snapshot?.entries?.length) {
      const store = new Map<string, VectorEntry>()
      for (const entry of snapshot.entries) {
        store.set(entry.id, normalizeStoredEntry(entry))
      }
      this.vectors.set(projectId, store)
      await this.persistProject(projectId)
    } else if ((this.vectors.get(projectId)?.size ?? 0) > 0) {
      this.bumpProjectVersion(projectId)
      this.queueBackendSync(projectId)
    }

    this.hydratedProjects.add(projectId)
  }

  private bumpProjectVersion(projectId: string) {
    this.projectVersions.set(projectId, (this.projectVersions.get(projectId) ?? 0) + 1)
  }

  private queueBackendSync(projectId: string) {
    if (!this.backendReady || !this.backend || this.syncTasks.has(projectId)) return

    const task = (async () => {
      while ((this.syncedVersions.get(projectId) ?? -1) < (this.projectVersions.get(projectId) ?? 0)) {
        const version = this.projectVersions.get(projectId) ?? 0
        const snapshot = Array.from(this.projectStore(projectId).values())
        await this.backend!.replaceProject(projectId, snapshot)
        this.syncedVersions.set(projectId, version)
      }
    })()
      .catch((error) => {
        log.warn("vector backend sync failed", { projectId, error: String(error) })
      })
      .finally(() => {
        this.syncTasks.delete(projectId)
        if ((this.syncedVersions.get(projectId) ?? -1) < (this.projectVersions.get(projectId) ?? 0)) {
          this.queueBackendSync(projectId)
        }
      })

    this.syncTasks.set(projectId, task)
  }
}

export const vectorStore = new VectorStore()

function clampToInt8(value: number) {
  if (!Number.isFinite(value)) return 0
  return Math.max(-127, Math.min(127, Math.round(value * 127)))
}

function quantizeNormalizedVector(vector: number[]) {
  return vector.map(clampToInt8)
}

function dequantizeVector(vector: number[]) {
  return vector.map((value) => value / 127)
}

function dequantizedCoarse(entry: VectorEntry) {
  if (entry.coarseQuantized?.length) return dequantizeVector(entry.coarseQuantized)
  if (entry.embedding?.length) return entry.embedding
  return []
}

function normalizeStoredEntry(entry: VectorEntry): VectorEntry {
  const coarseSource = entry.coarseQuantized?.length ? undefined : entry.embedding ?? []
  const fineSource = entry.fineQuantized?.length ? undefined : entry.embedding ?? []
  return {
    id: entry.id,
    sessionId: entry.sessionId,
    path: entry.path,
    content: entry.content,
    coarseQuantized: entry.coarseQuantized ?? quantizeNormalizedVector(coarseSource!),
    fineQuantized: entry.fineQuantized ?? quantizeNormalizedVector(fineSource!),
    fineDimensions: entry.fineDimensions ?? entry.fineQuantized?.length ?? fineSource!.length,
    retrievalProfile: entry.retrievalProfile ?? "text",
    quantized: true,
    timestamp: entry.timestamp,
    startLine: entry.startLine,
    endLine: entry.endLine,
  }
}

function cacheSegment(value: string) {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_") || "default"
}
