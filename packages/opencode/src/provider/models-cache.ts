import { Log } from "@/util/log"
import { snapshot } from "@/provider/models-snapshot"
import fs from "fs/promises"
import path from "path"

const log = Log.create({ service: "models.cache" })

/**
 * Model capability from models.dev API
 */
export interface ModelCapability {
  /** Model ID (e.g., "openai/gpt-4o") */
  id: string
  /** Model name */
  name: string
  /** Provider ID */
  provider: string
  /** Whether the model supports reasoning */
  reasoning: boolean
  /** Whether the model supports tool calling */
  toolCall: boolean
  /** Whether the model supports structured output */
  structuredOutput: boolean
  /** Whether the model supports file attachments */
  attachment: boolean
  /** Supported input modalities */
  inputModalities: string[]
  /** Supported output modalities */
  outputModalities: string[]
  /** Context window size */
  contextLimit: number
  /** Output token limit */
  outputLimit: number
  /** Input cost per 1M tokens */
  inputCost: number
  /** Output cost per 1M tokens */
  outputCost: number
  /** Cache read cost per 1M tokens */
  cacheReadCost?: number
  /** Cache write cost per 1M tokens */
  cacheWriteCost?: number
  /** Whether model has open weights */
  openWeights: boolean
  /** Model release date */
  releaseDate: string
  /** Last updated timestamp */
  lastUpdated: string
}

/**
 * Cache metadata
 */
interface CacheMetadata {
  /** When the cache was last updated */
  lastUpdated: number
  /** When the cache will expire */
  expiresAt: number
  /** Number of models in cache */
  modelCount: number
}

/**
 * ModelsCache provides runtime caching for model capabilities from models.dev
 */
export class ModelsCache {
  private cache: Map<string, ModelCapability> = new Map()
  private metadata: CacheMetadata | null = null
  private cacheDir: string
  private cacheTTL: number
  private apiUrl: string
  private timeout: number
  private initialized = false
  private initializing = false

  /**
   * Create a new ModelsCache instance
   * @param options - Cache configuration options
   */
  constructor(options?: {
    /** Cache directory path */
    cacheDir?: string
    /** Cache TTL in milliseconds */
    cacheTTL?: number
    /** models.dev API URL */
    apiUrl?: string
    /** Request timeout in milliseconds */
    timeout?: number
  }) {
    this.cacheDir = options?.cacheDir || this.getDefaultCacheDir()
    this.cacheTTL = options?.cacheTTL || 24 * 60 * 60 * 1000 // 24 hours
    this.apiUrl = (options?.apiUrl as string) || "https://models.dev"
    this.timeout = options?.timeout || 10000
  }

  /**
   * Get the default cache directory
   */
  private getDefaultCacheDir(): string {
    const dataDir = process.env.OPENCODE_DATA || process.env.XDG_DATA_HOME || path.join(process.env.HOME || "", ".local/share")
    return path.join(dataDir, "opencode", "models-cache")
  }

  /**
   * Initialize the cache - load from disk or fetch from API
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return
    }

    if (this.initializing) {
      // Wait for initialization to complete
      while (this.initializing) {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
      return
    }

    this.initializing = true

    try {
      // Try to load from local cache first
      await this.loadFromDisk()

      // Check if cache is expired
      if (this.isCacheExpired()) {
        log.info("cache expired, refreshing from API")
        await this.refresh()
      }

      this.initialized = true
    } catch (error) {
      log.error("failed to initialize cache", { error })
      // Fall back to static snapshot
      this.loadFromSnapshot()
      this.initialized = true
    } finally {
      this.initializing = false
    }
  }

  /**
   * Load model capabilities from static snapshot
   */
  private loadFromSnapshot(): void {
    this.cache.clear()

    for (const [providerID, providerData] of Object.entries(snapshot as Record<string, any>)) {
      if (!providerData.models) continue

      for (const [modelID, modelData] of Object.entries(providerData.models as Record<string, any>)) {
        const fullModelID = `${providerID}/${modelID}`

        this.cache.set(fullModelID, {
          id: fullModelID,
          name: modelData.name || modelID,
          provider: providerID,
          reasoning: modelData.reasoning || false,
          toolCall: modelData.tool_call || false,
          structuredOutput: false,
          attachment: modelData.attachment || false,
          inputModalities: modelData.modalities?.input || ["text"],
          outputModalities: modelData.modalities?.output || ["text"],
          contextLimit: modelData.limit?.context || 32000,
          outputLimit: modelData.limit?.output || 4096,
          inputCost: modelData.cost?.input || 0,
          outputCost: modelData.cost?.output || 0,
          cacheReadCost: modelData.cost?.cache_read,
          cacheWriteCost: modelData.cost?.cache_write,
          openWeights: modelData.open_weights || false,
          releaseDate: modelData.release_date || "unknown",
          lastUpdated: modelData.last_updated || "unknown",
        })
      }
    }

    log.info("loaded models from snapshot", { count: this.cache.size })
  }

  /**
   * Load cache from disk
   */
  async loadFromDisk(): Promise<void> {
    try {
      const metadataPath = path.join(this.cacheDir, "metadata.json")
      const dataPath = path.join(this.cacheDir, "models.json")

      // Check if cache files exist
      await fs.access(metadataPath)
      await fs.access(dataPath)

      // Read metadata
      const metadataContent = await fs.readFile(metadataPath, "utf-8")
      this.metadata = JSON.parse(metadataContent)

      // Read model data
      const dataContent = await fs.readFile(dataPath, "utf-8")
      const models: ModelCapability[] = JSON.parse(dataContent)

      // Populate cache
      this.cache.clear()
      for (const model of models) {
        this.cache.set(model.id, model)
      }

      log.info("loaded models from disk", { count: this.cache.size, expiresAt: this.metadata?.expiresAt })
    } catch (error) {
      // Cache doesn't exist, load from snapshot
      log.debug("no cache found on disk, using snapshot")
      this.loadFromSnapshot()
    }
  }

  /**
   * Save cache to disk
   */
  async saveToDisk(): Promise<void> {
    try {
      // Ensure directory exists
      await fs.mkdir(this.cacheDir, { recursive: true })

      const models = Array.from(this.cache.values())
      const metadata: CacheMetadata = {
        lastUpdated: Date.now(),
        expiresAt: Date.now() + this.cacheTTL,
        modelCount: models.length,
      }

      // Write metadata
      await fs.writeFile(path.join(this.cacheDir, "metadata.json"), JSON.stringify(metadata, null, 2))

      // Write model data
      await fs.writeFile(path.join(this.cacheDir, "models.json"), JSON.stringify(models, null, 2))

      this.metadata = metadata
      log.info("saved models to disk", { count: models.length })
    } catch (error) {
      log.error("failed to save cache to disk", { error })
    }
  }

  /**
   * Check if cache is expired
   */
  isCacheExpired(): boolean {
    if (!this.metadata) {
      return true
    }
    return Date.now() > this.metadata.expiresAt
  }

  /**
   * Fetch model capabilities from models.dev API
   */
  async fetchFromAPI(): Promise<ModelCapability[]> {
    const controller = new AbortController()
    const timeoutId = setTimeout(() => controller.abort(), this.timeout)

    try {
      log.info("fetching models from API", { url: this.apiUrl })

      const response = await fetch(`${this.apiUrl}/api.json`, {
        signal: controller.signal,
        headers: {
          Accept: "application/json",
          "User-Agent": "opencode/1.0",
        },
      })

      if (!response.ok) {
        throw new Error(`API request failed: ${response.status} ${response.statusText}`)
      }

      const data = await response.json()
      const models: ModelCapability[] = []

      // Parse API response
      for (const [providerID, providerData] of Object.entries(data as Record<string, any>)) {
        if (!providerData.models) continue

        for (const [modelID, modelData] of Object.entries(providerData.models as Record<string, any>)) {
          const fullModelID = `${providerID}/${modelID}`

          models.push({
            id: fullModelID,
            name: modelData.name || modelID,
            provider: providerID,
            reasoning: modelData.reasoning || false,
            toolCall: modelData.tool_call || false,
            structuredOutput: modelData.structured_output || false,
            attachment: modelData.attachment || false,
            inputModalities: modelData.modalities?.input || ["text"],
            outputModalities: modelData.modalities?.output || ["text"],
            contextLimit: modelData.limit?.context || 32000,
            outputLimit: modelData.limit?.output || 4096,
            inputCost: modelData.cost?.input || 0,
            outputCost: modelData.cost?.output || 0,
            cacheReadCost: modelData.cost?.cache_read,
            cacheWriteCost: modelData.cost?.cache_write,
            openWeights: modelData.open_weights || false,
            releaseDate: modelData.release_date || "unknown",
            lastUpdated: modelData.last_updated || "unknown",
          })
        }
      }

      log.info("fetched models from API", { count: models.length })
      return models
    } catch (error) {
      if (error instanceof Error && error.name === "AbortError") {
        log.error("API request timed out", { timeout: this.timeout })
      } else {
        log.error("failed to fetch from API", { error })
      }
      throw error
    } finally {
      clearTimeout(timeoutId)
    }
  }

  /**
   * Refresh the cache from API
   */
  async refresh(): Promise<void> {
    try {
      const models = await this.fetchFromAPI()

      // Update cache
      this.cache.clear()
      for (const model of models) {
        this.cache.set(model.id, model)
      }

      // Save to disk
      await this.saveToDisk()

      log.info("cache refreshed", { count: models.length })
    } catch (error) {
      log.error("failed to refresh cache", { error })
      // Keep existing cache on failure
      if (this.cache.size === 0) {
        this.loadFromSnapshot()
      }
    }
  }

  /**
   * Get a specific model's capability
   * @param modelID - Full model ID (provider/model)
   * @returns Model capability or null if not found
   */
  getModelCapability(modelID: string): ModelCapability | null {
    return this.cache.get(modelID) || null
  }

  /**
   * Get all models that support image input
   * @returns Array of vision-capable models
   */
  getVisionModels(): ModelCapability[] {
    return Array.from(this.cache.values()).filter((model) => model.inputModalities.includes("image"))
  }

  /**
   * Get models by capability
   * @param capability - Capability to filter by
   * @returns Array of models with the specified capability
   */
  getModelsByCapability(capability: {
    /** Filter by vision support */
    vision?: boolean
    /** Filter by audio support */
    audio?: boolean
    /** Filter by video support */
    video?: boolean
    /** Filter by PDF support */
    pdf?: boolean
    /** Filter by tool calling support */
    toolCall?: boolean
    /** Filter by reasoning support */
    reasoning?: boolean
  }): ModelCapability[] {
    return Array.from(this.cache.values()).filter((model) => {
      if (capability.vision && !model.inputModalities.includes("image")) return false
      if (capability.audio && !model.inputModalities.includes("audio")) return false
      if (capability.video && !model.inputModalities.includes("video")) return false
      if (capability.pdf && !model.inputModalities.includes("pdf")) return false
      if (capability.toolCall && !model.toolCall) return false
      if (capability.reasoning && !model.reasoning) return false
      return true
    })
  }

  /**
   * Get all available models
   * @returns Array of all model capabilities
   */
  getAllModels(): ModelCapability[] {
    return Array.from(this.cache.values())
  }

  /**
   * Get cache statistics
   */
  getStats(): {
    /** Total number of cached models */
    modelCount: number
    /** Number of vision-capable models */
    visionModelCount: number
    /** Cache last updated timestamp */
    lastUpdated: number | null
    /** Cache expiration timestamp */
    expiresAt: number | null
    /** Whether cache is expired */
    isExpired: boolean
  } {
    return {
      modelCount: this.cache.size,
      visionModelCount: this.getVisionModels().length,
      lastUpdated: this.metadata?.lastUpdated || null,
      expiresAt: this.metadata?.expiresAt || null,
      isExpired: this.isCacheExpired(),
    }
  }

  /**
   * Clear the cache
   */
  async clear(): Promise<void> {
    this.cache.clear()
    this.metadata = null

    try {
      await fs.rm(this.cacheDir, { recursive: true, force: true })
      log.info("cache cleared")
    } catch (error) {
      log.error("failed to clear cache", { error })
    }
  }
}

/**
 * Singleton instance of ModelsCache
 */
let cacheInstance: ModelsCache | null = null

/**
 * Get the singleton ModelsCache instance
 * @returns ModelsCache instance
 */
export function getModelsCache(): ModelsCache {
  if (!cacheInstance) {
    cacheInstance = new ModelsCache()
  }
  return cacheInstance
}

/**
 * Convenience function to get vision models
 * @returns Array of vision-capable models
 */
export async function getVisionModelsFromCache(): Promise<ModelCapability[]> {
  const cache = getModelsCache()
  await cache.initialize()
  return cache.getVisionModels()
}

/**
 * Convenience function to get a model capability
 * @param modelID - Full model ID
 * @returns Model capability or null
 */
export async function getModelCapabilityFromCache(modelID: string): Promise<ModelCapability | null> {
  const cache = getModelsCache()
  await cache.initialize()
  return cache.getModelCapability(modelID)
}

/**
 * Convenience function to refresh the cache
 */
export async function refreshModelsCache(): Promise<void> {
  const cache = getModelsCache()
  await cache.initialize()
  await cache.refresh()
}
