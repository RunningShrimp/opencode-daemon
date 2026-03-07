import { Log } from "@/util/log"
import { Global } from "@/global"
import { vectorStore, type VectorEntry, type VectorSearchResult } from "./vector-store"
import { BackgroundServiceManager, type IBackgroundService, type ServiceStatus } from "@/util/background-service"
import path from "node:path"
import { existsSync, mkdirSync } from "node:fs"

const log = Log.create({ service: "vector-store-bg" })

interface InMemoryVectorRecord {
  id: string
  project_id: string
  project_path: string
  file_path: string
  content: string
  embedding: number[]
  time_created: number
}

class PerProjectMemoryStore {
  private projectStores: Map<string, Map<string, InMemoryVectorRecord>> = new Map()
  private maxPerProject = 50000

  private getProjectStore(projectPath: string): Map<string, InMemoryVectorRecord> {
    if (!this.projectStores.has(projectPath)) {
      this.projectStores.set(projectPath, new Map())
    }
    return this.projectStores.get(projectPath)!
  }

  async upsert(record: InMemoryVectorRecord): Promise<void> {
    const store = this.getProjectStore(record.project_path)

    if (store.size >= this.maxPerProject) {
      let oldestKey: string | null = null
      let oldestTime = Infinity
      for (const [key, rec] of store) {
        if (rec.time_created < oldestTime) {
          oldestTime = rec.time_created
          oldestKey = key
        }
      }
      if (oldestKey) {
        store.delete(oldestKey)
      }
    }
    store.set(record.id, record)
  }

  async search(
    projectPath: string,
    queryEmbedding: number[],
    options: { limit?: number } = {},
  ): Promise<VectorSearchResult[]> {
    const store = this.projectStores.get(projectPath)
    if (!store) {
      return []
    }

    const { limit = 10 } = options
    const results = Array.from(store.values())

    const queryNorm = Math.sqrt(queryEmbedding.reduce((sum, v) => sum + v * v, 0))

    const scored = results.map((r) => {
      let dotProduct = 0
      for (let i = 0; i < queryEmbedding.length; i++) {
        dotProduct += queryEmbedding[i] * (r.embedding[i] || 0)
      }
      const norm = Math.sqrt(r.embedding.reduce((sum, v) => sum + v * v, 0))
      const similarity = queryNorm > 0 && norm > 0 ? dotProduct / (queryNorm * norm) : 0

      return {
        id: r.id,
        sessionId: r.project_id,
        path: r.file_path,
        content: r.content,
        score: similarity,
      }
    })

    scored.sort((a, b) => b.score - a.score)

    return scored.slice(0, limit)
  }

  async deleteByProject(projectPath: string): Promise<number> {
    const store = this.projectStores.get(projectPath)
    if (!store) return 0
    const count = store.size
    this.projectStores.delete(projectPath)
    return count
  }

  get size(): number {
    let total = 0
    for (const store of this.projectStores.values()) {
      total += store.size
    }
    return total
  }

  getProjectSize(projectPath: string): number {
    return this.projectStores.get(projectPath)?.size ?? 0
  }

  clear(): void {
    this.projectStores.clear()
  }

  hasProjectData(projectPath: string): boolean {
    const store = this.projectStores.get(projectPath)
    return store !== undefined && store.size > 0
  }
}

export class VectorStoreBackgroundService implements IBackgroundService {
  name = "vector-store"
  priority = 20
  private status: ServiceStatus = "idle"
  private memoryStore: PerProjectMemoryStore = new PerProjectMemoryStore()
  private useMemoryStore = true

  async start(): Promise<void> {
    log.info("starting vector store service in background")

    const vectorStoreDir = path.join(Global.Path.data, "vector-store")
    if (!existsSync(vectorStoreDir)) {
      mkdirSync(vectorStoreDir, { recursive: true })
    }

    this.status = "ready"
    log.info("vector store ready (memory mode)")
  }

  async stop(): Promise<void> {
    this.useMemoryStore = true
    this.status = "idle"
    this.memoryStore.clear()
    log.info("vector store stopped")
  }

  getStatus(): ServiceStatus {
    return this.status
  }

  isReady(): boolean {
    return this.status === "ready" || this.status === "fallback"
  }

  async hasExistingData(_projectId: string, projectPath: string): Promise<boolean> {
    return this.memoryStore.hasProjectData(projectPath)
  }

  async upsert(
    id: string,
    projectId: string,
    projectRoot: string,
    filePath: string,
    content: string,
    embedding: number[],
  ): Promise<void> {
    const now = Date.now()

    const record: InMemoryVectorRecord = {
      id,
      project_id: projectId,
      project_path: projectRoot,
      file_path: filePath,
      content,
      embedding,
      time_created: now,
    }

    await this.memoryStore.upsert(record)

    const entry: VectorEntry = {
      id,
      sessionId: projectId,
      path: filePath,
      content,
      embedding,
      timestamp: now,
    }

    await vectorStore.addVector(entry)
  }

  async search(
    _projectId: string,
    projectPath: string,
    queryEmbedding: number[],
    options: { limit?: number; minScore?: number } = {},
  ): Promise<VectorSearchResult[]> {
    return this.memoryStore.search(projectPath, queryEmbedding, {
      limit: options.limit || 10,
    })
  }

  async deleteByProject(_projectId: string, projectPath: string): Promise<number> {
    return this.memoryStore.deleteByProject(projectPath)
  }

  async getProjectDataSize(projectPath: string): Promise<number> {
    return this.memoryStore.getProjectSize(projectPath)
  }
}

export const vectorStoreBackgroundService = new VectorStoreBackgroundService()

export function initVectorStoreBackgroundService(): void {
  const manager = BackgroundServiceManager.getInstance()
  manager.register(vectorStoreBackgroundService)
}
