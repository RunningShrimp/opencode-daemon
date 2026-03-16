import { Log } from "@/util/log"
import { Global } from "@/global"
import {
  EMBEDDING_OUTPUT_DIMENSIONS,
  embeddingService,
  TransformersEmbeddingProvider,
  type ExternalEmbeddingConfig,
  type EmbeddingRuntimeState,
} from "./embedding"
import { BackgroundServiceManager, type IBackgroundService, type ServiceStatus } from "@/util/background-service"
import { rebuildRegisteredProjects } from "./indexer"
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

type EmbeddingBootstrapConfig =
  | { mode: "fallback"; source: "env" | "default"; targetProvider: "fallback" }
  | { mode: "transformers"; source: "env" | "default"; targetProvider: "transformers" }
  | { mode: "external"; source: "env"; targetProvider: "openai" | "cohere" | "voyage"; config: ExternalEmbeddingConfig }

function shouldUseFallbackEmbeddingByDefault() {
  return typeof Bun !== "undefined"
}

function resolveEmbeddingBootstrapConfig(): EmbeddingBootstrapConfig {
  const provider = process.env.OPENCODE_EMBEDDING_PROVIDER?.trim().toLowerCase()
  if (!provider) {
    if (shouldUseFallbackEmbeddingByDefault()) {
      return { mode: "fallback", source: "default", targetProvider: "fallback" }
    }
    return { mode: "transformers", source: "default", targetProvider: "transformers" }
  }

  if (provider === "fallback") {
    return { mode: "fallback", source: "env", targetProvider: "fallback" }
  }

  if (provider === "transformers") {
    return { mode: "transformers", source: "env", targetProvider: "transformers" }
  }

  const model = process.env.OPENCODE_EMBEDDING_MODEL?.trim() || undefined
  const baseUrl = process.env.OPENCODE_EMBEDDING_BASE_URL?.trim() || undefined
  const dimensionsValue = process.env.OPENCODE_EMBEDDING_DIMENSIONS?.trim()
  const dimensions = dimensionsValue ? Number.parseInt(dimensionsValue, 10) : undefined

  if (dimensionsValue && (!Number.isFinite(dimensions) || (dimensions ?? 0) <= 0)) {
    throw new Error(`Invalid OPENCODE_EMBEDDING_DIMENSIONS: ${dimensionsValue}`)
  }

  if (provider === "openai") {
    const apiKey =
      process.env.OPENCODE_OPENAI_API_KEY?.trim() ||
      process.env.OPENAI_API_KEY?.trim() ||
      process.env.OPENCODE_EMBEDDING_API_KEY?.trim()
    if (!apiKey) {
      throw new Error("OPENCODE_EMBEDDING_PROVIDER=openai requires OPENCODE_OPENAI_API_KEY or OPENAI_API_KEY")
    }
    return {
      mode: "external",
      source: "env",
      targetProvider: "openai",
      config: {
        provider: "openai",
        apiKey,
        model,
        baseUrl,
        dimensions,
      },
    }
  }

  if (provider === "cohere") {
    const apiKey =
      process.env.OPENCODE_COHERE_API_KEY?.trim() ||
      process.env.COHERE_API_KEY?.trim() ||
      process.env.OPENCODE_EMBEDDING_API_KEY?.trim()
    if (!apiKey) {
      throw new Error("OPENCODE_EMBEDDING_PROVIDER=cohere requires OPENCODE_COHERE_API_KEY or COHERE_API_KEY")
    }
    return {
      mode: "external",
      source: "env",
      targetProvider: "cohere",
      config: {
        provider: "cohere",
        apiKey,
        model,
        baseUrl,
        dimensions,
      },
    }
  }

  if (provider === "voyage") {
    const apiKey =
      process.env.OPENCODE_VOYAGE_API_KEY?.trim() ||
      process.env.VOYAGE_API_KEY?.trim() ||
      process.env.OPENCODE_EMBEDDING_API_KEY?.trim()
    if (!apiKey) {
      throw new Error("OPENCODE_EMBEDDING_PROVIDER=voyage requires OPENCODE_VOYAGE_API_KEY or VOYAGE_API_KEY")
    }
    return {
      mode: "external",
      source: "env",
      targetProvider: "voyage",
      config: {
        provider: "voyage",
        apiKey,
        model,
        baseUrl,
        dimensions,
      },
    }
  }

  throw new Error(`Unsupported OPENCODE_EMBEDDING_PROVIDER=${provider}`)
}

export interface EmbeddingRuntimeContext {
  serviceStatus: ServiceStatus
  targetProvider: string
  source: "env" | "default"
  activeProvider: string
  activeProviderKind: string
  mode: EmbeddingRuntimeState["mode"]
  lastError?: string
}

export class EmbeddingBackgroundService implements IBackgroundService {
  name = "embedding"
  priority = 10
  private status: ServiceStatus = "idle"
  private fallbackCache: InMemoryVectorCache = new InMemoryVectorCache()
  private reindexCallbacks: Array<() => void | Promise<void>> = []
  private isReindexing = false
  private providerInit?: Promise<void>
  private providerTarget = "transformers"
  private providerSource: "env" | "default" = "default"
  private initError?: string

  async start(): Promise<void> {
    log.info("starting embedding service in background")

    const modelCacheDir = path.join(Global.Path.data, "models", "embeddings")
    if (!existsSync(modelCacheDir)) {
      mkdirSync(modelCacheDir, { recursive: true })
    }

    this.status = "fallback"
    this.providerInit = this.initializeProvider().catch((error) => {
      this.status = "fallback"
      this.initError = String(error)
      embeddingService.reportProviderFailure(this.initError)
      embeddingService.useFallback()
      log.warn("real embedding provider init failed, staying on fallback", { error: String(error) })
    })
    log.info("embedding service ready (semantic fallback active, provider booting)", {
      targetProvider: this.providerTarget,
      source: this.providerSource,
    })
  }

  async stop(): Promise<void> {
    this.status = "idle"
    this.fallbackCache.clear()
    log.info("embedding service stopped")
  }

  getStatus(): ServiceStatus {
    return this.status
  }

  /**
   * Wait until the real embedding provider is ready (status === "ready").
   * Resolves true if ready within timeout, false if timed-out on fallback.
   */
  async waitForProvider(timeoutMs = 3000): Promise<boolean> {
    if (this.status === "ready") return true
    return new Promise<boolean>((resolve) => {
      const deadline = Date.now() + timeoutMs
      const check = setInterval(() => {
        if (this.status === "ready" || Date.now() >= deadline) {
          clearInterval(check)
          resolve(this.status === "ready")
        }
      }, 100)
    })
  }

  isReady(): boolean {
    return this.status === "ready" || this.status === "fallback"
  }

  getRuntimeContext(): EmbeddingRuntimeContext {
    const runtime = embeddingService.getRuntimeState()
    return {
      serviceStatus: this.status,
      targetProvider: this.providerTarget,
      source: this.providerSource,
      activeProvider: runtime.activeProvider,
      activeProviderKind: runtime.activeProviderKind,
      mode: runtime.mode,
      lastError: this.initError ?? runtime.lastError,
    }
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
      log.warn("embedding failed, using semantic fallback", { error: String(error) })
      return this.generateHashEmbedding(text)
    }
  }

  private generateHashEmbedding(text: string): number[] {
    const dimensions = EMBEDDING_OUTPUT_DIMENSIONS
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

  onReindex(callback: () => void | Promise<void>): void {
    this.reindexCallbacks.push(callback)

    if (this.status === "ready") {
      this.triggerReindex()
    }
  }

  private async initializeProvider() {
    const setup = resolveEmbeddingBootstrapConfig()
    this.providerTarget = setup.targetProvider
    this.providerSource = setup.source

    if (setup.mode === "fallback") {
      embeddingService.useFallback()
      this.status = "fallback"
      this.initError = undefined
      log.info("embedding provider configured to fallback mode", {
        source: this.providerSource,
      })
      return
    }

    if (setup.mode === "external") {
      await embeddingService.configureFromSettings(setup.config)
      this.status = "ready"
      this.initError = undefined
      log.info("embedding provider activated", {
        source: this.providerSource,
        provider: embeddingService.getProvider().name,
      })
      await this.triggerReindex()
      return
    }

    const provider = new TransformersEmbeddingProvider()
    await embeddingService.configureProvider(provider)
    this.status = "ready"
    this.initError = undefined
    log.info("embedding provider activated", {
      source: this.providerSource,
      provider: embeddingService.getProvider().name,
    })
    await this.triggerReindex()
  }

  private async triggerReindex(): Promise<void> {
    if (this.isReindexing || this.status !== "ready") return
    if (this.reindexCallbacks.length === 0) return

    this.isReindexing = true

    try {
      log.info("reindexing embeddings after provider upgrade", { cached: this.fallbackCache.size })
      for (const callback of this.reindexCallbacks) {
        await callback()
      }

      await rebuildRegisteredProjects().catch((error) => {
        log.warn("registered project rebuild failed after embedding upgrade", { error: String(error) })
      })

      this.fallbackCache.clear()

      log.info("reindexing complete after provider upgrade")
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
