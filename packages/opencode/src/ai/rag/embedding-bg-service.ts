import { Log } from "@/util/log"
import { Global } from "@/global"
import { embeddingService } from "./embedding"
import { BackgroundServiceManager, type IBackgroundService, type ServiceStatus } from "@/util/background-service"
import path from "node:path"
import { existsSync, mkdirSync } from "node:fs"

const log = Log.create({ service: "embedding-bg" })

class InMemoryVectorCache {
  private cache: Map<string, number[]> = new Map()
  private maxSize = 10000

  set(key: string, value: number[]): void {
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value
      if (firstKey) {
        this.cache.delete(firstKey)
      }
    }
    this.cache.set(key, value)
  }

  get(key: string): number[] | undefined {
    return this.cache.get(key)
  }

  has(key: string): boolean {
    return this.cache.has(key)
  }

  clear(): void {
    this.cache.clear()
  }

  get size(): number {
    return this.cache.size
  }

  keys(): IterableIterator<string> {
    return this.cache.keys()
  }
}

export class EmbeddingBackgroundService implements IBackgroundService {
  name = "embedding"
  priority = 10
  private status: ServiceStatus = "idle"
  private fallbackCache: InMemoryVectorCache = new InMemoryVectorCache()
  private reindexCallbacks: Array<(embeddings: Map<string, number[]>) => void> = []
  private isReindexing = false

  async start(): Promise<void> {
    log.info("starting embedding service in background")

    const modelCacheDir = path.join(Global.Path.data, "models", "embeddings")
    if (!existsSync(modelCacheDir)) {
      mkdirSync(modelCacheDir, { recursive: true })
    }

    this.status = "ready"
    log.info("embedding service ready (using hash-based fallback)")
  }

  async stop(): Promise<void> {
    this.status = "idle"
    this.fallbackCache.clear()
    log.info("embedding service stopped")
  }

  getStatus(): ServiceStatus {
    return this.status
  }

  isReady(): boolean {
    return this.status === "ready" || this.status === "fallback"
  }

  async embed(text: string): Promise<number[]> {
    const cached = this.fallbackCache.get(text)
    if (cached) {
      return cached
    }

    try {
      const embedding = await embeddingService.getEmbedding(text)
      this.fallbackCache.set(text, embedding)
      return embedding
    } catch (error) {
      log.warn("embedding failed, using hash fallback", { error: String(error) })
      return this.generateHashEmbedding(text)
    }
  }

  private generateHashEmbedding(text: string): number[] {
    const dimensions = 384
    const embedding: number[] = new Array(dimensions).fill(0)

    let hash = 0
    for (let i = 0; i < text.length; i++) {
      const char = text.charCodeAt(i)
      hash = (hash << 5) - hash + char
      hash = hash & hash
    }

    for (let i = 0; i < dimensions; i++) {
      let h = hash
      h = (h << 5) - h + i
      h = h & h
      embedding[i] = (Math.sin(h) * 10000) % 1
    }

    let norm = 0
    for (let i = 0; i < dimensions; i++) {
      norm += embedding[i] * embedding[i]
    }
    norm = Math.sqrt(norm)

    if (norm > 0) {
      for (let i = 0; i < dimensions; i++) {
        embedding[i] /= norm
      }
    }

    return embedding
  }

  onReindex(callback: (embeddings: Map<string, number[]>) => void): void {
    this.reindexCallbacks.push(callback)

    if (this.status === "ready") {
      this.triggerReindex()
    }
  }

  private async triggerReindex(): Promise<void> {
    if (this.isReindexing || this.status !== "ready") return
    if (this.reindexCallbacks.length === 0) return

    this.isReindexing = true

    try {
      const texts: string[] = []
      for (const key of this.fallbackCache.keys()) {
        texts.push(key)
      }

      if (texts.length === 0) {
        this.isReindexing = false
        return
      }

      log.info("reindexing embeddings", { count: texts.length })

      const embeddings = new Map<string, number[]>()
      for (const text of texts) {
        const embedding = await embeddingService.getEmbedding(text)
        embeddings.set(text, embedding)
      }

      for (const callback of this.reindexCallbacks) {
        callback(embeddings)
      }

      this.fallbackCache.clear()

      log.info("reindexing complete", { count: texts.length })
    } catch (error) {
      log.error("reindexing failed", { error: String(error) })
    } finally {
      this.isReindexing = false
    }
  }
}

export const embeddingBackgroundService = new EmbeddingBackgroundService()

export function initEmbeddingBackgroundService(): void {
  const manager = BackgroundServiceManager.getInstance()
  manager.register(embeddingBackgroundService)
}
