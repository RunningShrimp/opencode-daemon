import {
  ensureEmbeddingBackgroundServiceStarted,
  embeddingBackgroundService,
} from "@/ai/rag/embedding-bg-service"
import {
  parseEmbedRequest,
  parseEmbedResponse,
  type AIRuntimeStats,
  type EmbedRequest,
  type EmbedResponse,
} from "@/daemon/ai-runtime/ai-runtime-protocol"

export interface AIRuntimeClient {
  start?(): Promise<void>
  stop?(): Promise<void>
  warm(model: string): Promise<void>
  embed(request: EmbedRequest): Promise<EmbedResponse>
  stats?(): Promise<Partial<AIRuntimeStats>>
  shrinkPool(target: { maxResidentModels: number }): Promise<void>
}

export interface AIRuntimeSupervisorOptions {
  client?: AIRuntimeClient
  fallbackEmbed?: (request: EmbedRequest) => Promise<EmbedResponse>
  now?: () => number
}

function normalizeVectorDimensions(vector: number[], dimensions?: number): number[] {
  if (!dimensions || dimensions <= 0) return vector
  if (vector.length === dimensions) return vector

  if (vector.length === 0) {
    return new Array(dimensions).fill(0)
  }

  const projected = new Array(dimensions).fill(0)
  for (let index = 0; index < vector.length; index += 1) {
    const target = Math.min(dimensions - 1, Math.floor((index * dimensions) / vector.length))
    projected[target] += vector[index] ?? 0
  }

  let norm = 0
  for (const value of projected) {
    norm += value * value
  }

  if (norm <= 0) return projected
  const sqrtNorm = Math.sqrt(norm)
  return projected.map((value) => value / sqrtNorm)
}

async function defaultFallbackEmbed(request: EmbedRequest): Promise<EmbedResponse> {
  await ensureEmbeddingBackgroundServiceStarted().catch(() => undefined)
  const vectors = await Promise.all(request.input.map((item) => embeddingBackgroundService.embed(item)))
  return {
    model: request.model,
    vectors: vectors.map((vector) => normalizeVectorDimensions(vector, request.dimensions)),
  }
}

export class AIRuntimeSupervisor {
  private readonly fallbackEmbed: (request: EmbedRequest) => Promise<EmbedResponse>
  private readonly now: () => number
  private clientStarted = false
  private degradedToFallback = false
  private startingClient?: Promise<void>
  private readonly warmedModels = new Set<string>()
  private embedRequests = 0
  private sidecarEmbeds = 0
  private fallbackEmbeds = 0
  private failures = 0
  private lastFailure?: string
  private lastFailureAt?: number

  constructor(private readonly options: AIRuntimeSupervisorOptions = {}) {
    this.fallbackEmbed = options.fallbackEmbed ?? defaultFallbackEmbed
    this.now = options.now ?? (() => Date.now())
  }

  private recordFailure(error: unknown): void {
    this.failures += 1
    this.lastFailure = error instanceof Error ? error.message : String(error)
    this.lastFailureAt = this.now()
    this.degradedToFallback = true
  }

  private async ensureClientStarted(): Promise<void> {
    const client = this.options.client
    if (!client || this.clientStarted) return
    if (this.startingClient) {
      await this.startingClient
      return
    }

    this.startingClient = (async () => {
      await client.start?.()
      this.clientStarted = true
    })()

    try {
      await this.startingClient
    } finally {
      this.startingClient = undefined
    }
  }

  async warm(model: string): Promise<void> {
    const normalized = model.trim()
    if (!normalized) {
      throw new Error("model is required")
    }

    if (!this.options.client || this.degradedToFallback) {
      this.warmedModels.add(normalized)
      return
    }

    try {
      await this.ensureClientStarted()
      await this.options.client.warm(normalized)
      this.warmedModels.add(normalized)
    } catch (error) {
      this.recordFailure(error)
      throw error
    }
  }

  async embed(input: unknown): Promise<EmbedResponse> {
    const request = parseEmbedRequest(input)
    this.embedRequests += 1

    if (this.options.client && !this.degradedToFallback) {
      try {
        await this.ensureClientStarted()
        const response = parseEmbedResponse(await this.options.client.embed(request))
        this.sidecarEmbeds += 1
        this.warmedModels.add(request.model)
        return {
          ...response,
          vectors: response.vectors.map((vector) => normalizeVectorDimensions(vector, request.dimensions)),
        }
      } catch (error) {
        this.recordFailure(error)
      }
    }

    this.fallbackEmbeds += 1
    return this.fallbackEmbed(request)
  }

  async shrinkPool(target: { maxResidentModels: number }): Promise<void> {
    if (!this.options.client || this.degradedToFallback) {
      return
    }

    try {
      await this.ensureClientStarted()
      await this.options.client.shrinkPool(target)
    } catch (error) {
      this.recordFailure(error)
    }
  }

  async stats(): Promise<AIRuntimeStats> {
    let mode: AIRuntimeStats["mode"] = this.degradedToFallback || !this.options.client ? "fallback" : "sidecar"
    let warmedModels = [...this.warmedModels]

    if (this.options.client && !this.degradedToFallback && this.options.client.stats) {
      try {
        await this.ensureClientStarted()
        const clientStats = await this.options.client.stats()
        if (clientStats.mode) mode = clientStats.mode
        if (Array.isArray(clientStats.warmedModels)) {
          warmedModels = [...new Set([...warmedModels, ...clientStats.warmedModels])]
        }
      } catch (error) {
        this.recordFailure(error)
        mode = "fallback"
      }
    }

    return {
      mode,
      embedRequests: this.embedRequests,
      sidecarEmbeds: this.sidecarEmbeds,
      fallbackEmbeds: this.fallbackEmbeds,
      warmedModels,
      failures: this.failures,
      lastFailure: this.lastFailure,
      lastFailureAt: this.lastFailureAt,
    }
  }
}
