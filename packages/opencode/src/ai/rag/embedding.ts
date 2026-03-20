import { rankHealthyEndpoints } from "@/util/network-probe"
import { Log } from "@/util/log"
import { EMBEDDING_MODEL, MIRRORS } from "@/util/hf-mirror"
import { resolveTransformersDevicePreference } from "@/util/transformers-device"

const MAX_CACHE_SIZE = 10000
const TTL_MS = 24 * 60 * 60 * 1000
const DEFAULT_DIMENSIONS = 512
const DEFAULT_TEXT_EMBEDDING_MODEL = "onnx-community/Qwen3-Embedding-0.6B-ONNX"
const DEFAULT_IMAGE_EMBEDDING_MODEL = "onnx-community/clip-vit-base-patch32"
const TRANSFORMERS_REMOTE_PATH_TEMPLATE = "{model}/resolve/{revision}/"

const log = Log.create({ service: "embedding" })

export const EMBEDDING_OUTPUT_DIMENSIONS = DEFAULT_DIMENSIONS
export const RETRIEVAL_DIMENSIONS = {
  coarse: DEFAULT_DIMENSIONS,
  code: 1536,
  text: 1024,
} as const

export type RetrievalEmbeddingProfile = Exclude<keyof typeof RETRIEVAL_DIMENSIONS, "coarse">

export interface RetrievalEmbeddingBundle {
  coarse: number[]
  fine: number[]
  profile: RetrievalEmbeddingProfile
  coarseDimensions: number
  fineDimensions: number
}

export interface QueryEmbeddingBundle {
  coarse: number[]
  fineByProfile: Record<RetrievalEmbeddingProfile, number[]>
}

export type EmbeddingModality = "text" | "document" | "image"

export interface EmbeddingInput {
  content: string | Uint8Array | ArrayBuffer
  modality?: EmbeddingModality
  mimeType?: string
  path?: string
  metadata?: Record<string, unknown>
}

export interface EmbeddingProvider {
  name: string
  dimensions: number
  kind: "fallback" | "transformers"
  initialize?(): Promise<void>
  embed(input: EmbeddingInput): Promise<number[]>
  embedBatch?(input: EmbeddingInput[]): Promise<number[][]>
  supports(input: EmbeddingInput): boolean
}

export interface CachedEmbedding {
  embedding: number[]
  timestamp: number
}

export type EmbeddingRuntimeMode = "fallback" | "provider"

export interface EmbeddingRuntimeState {
  mode: EmbeddingRuntimeMode
  activeProvider: string
  configuredProvider?: string
  activeProviderKind: EmbeddingProvider["kind"]
  lastError?: string
  updatedAt: number
}

function computeRollingHash(input: string): number {
  let hash = 2166136261 >>> 0
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return hash >>> 0
}

function normalizeVector(vector: number[]): number[] {
  let norm = 0
  for (const value of vector) norm += value * value
  norm = Math.sqrt(norm)
  if (!norm) return vector
  return vector.map((value) => value / norm)
}

function resizeVector(vector: number[], dimensions: number) {
  if (dimensions <= 0) return []
  if (vector.length === dimensions) return normalizeVector(vector)

  const projected = new Array(dimensions).fill(0)
  if (vector.length === 0) return projected

  for (let index = 0; index < vector.length; index++) {
    const targetIndex = Math.min(dimensions - 1, Math.floor((index * dimensions) / vector.length))
    projected[targetIndex] += vector[index]
  }

  return normalizeVector(projected)
}

function sanitizeVector(vector: number[], dimensions: number) {
  const cleaned = vector
    .map((value) => (Number.isFinite(value) ? value : 0))
  return resizeVector(cleaned, dimensions)
}

function mergeVectors(primary: number[], secondary: number[], primaryWeight: number) {
  const merged = primary.map((value, index) => value * primaryWeight + (secondary[index] ?? 0) * (1 - primaryWeight))
  return normalizeVector(merged)
}

function normalizeInput(input: string | EmbeddingInput): EmbeddingInput {
  if (typeof input === "string") {
    return { content: input, modality: "text" }
  }
  return {
    ...input,
    modality: input.modality ?? "text",
  }
}

function normalizeConfiguredValue(value: string | undefined | null) {
  if (typeof value !== "string") return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

function isBlockedLegacyEmbeddingModel(model: string) {
  const normalized = model.trim().toLowerCase()
  return normalized.includes("all-minilm-l6-v2")
}

function isLegacyMiniLMResolutionError(error: unknown) {
  const normalized = String(error).trim().toLowerCase()
  if (!normalized) return false
  return normalized.includes("xenova/all-minilm-l6-v2") || normalized.includes("all-minilm-l6-v2")
}

function resolveSafeEmbeddingModel(
  configuredModel: string | undefined,
  fallbackModel: string,
  modelType: "text" | "image",
) {
  if (!configuredModel) return fallbackModel
  if (!isBlockedLegacyEmbeddingModel(configuredModel)) return configuredModel

  log.warn("blocked legacy embedding model override, using safe default", {
    modelType,
    configuredModel,
    fallbackModel,
  })
  return fallbackModel
}

function ensureTrailingSlash(value: string) {
  return value.endsWith("/") ? value : `${value}/`
}

function resolveTransformersTextModel() {
  const configuredModel = (
    normalizeConfiguredValue(process.env.OPENCODE_EMBEDDING_TEXT_MODEL) ??
    normalizeConfiguredValue(process.env.OPENCODE_EMBEDDING_MODEL) ??
    normalizeConfiguredValue(EMBEDDING_MODEL) ??
    DEFAULT_TEXT_EMBEDDING_MODEL
  )
  return resolveSafeEmbeddingModel(configuredModel, DEFAULT_TEXT_EMBEDDING_MODEL, "text")
}

function resolveTransformersImageModel() {
  const configuredModel = normalizeConfiguredValue(process.env.OPENCODE_EMBEDDING_IMAGE_MODEL) ?? DEFAULT_IMAGE_EMBEDDING_MODEL
  return resolveSafeEmbeddingModel(configuredModel, DEFAULT_IMAGE_EMBEDDING_MODEL, "image")
}

function resolveTransformersRemoteHost() {
  return ensureTrailingSlash(
    normalizeConfiguredValue(process.env.HF_ENDPOINT) ??
      normalizeConfiguredValue(process.env.HF_HUB_URL) ??
      MIRRORS.huggingface,
  )
}

function resolveTransformersRemoteHosts() {
  const candidates = [
    resolveTransformersRemoteHost(),
    ensureTrailingSlash(MIRRORS["hf-mirror"]),
    ensureTrailingSlash(MIRRORS.huggingface),
  ]

  const seen = new Set<string>()
  const unique: string[] = []
  for (const value of candidates) {
    if (seen.has(value)) continue
    seen.add(value)
    unique.push(value)
  }

  return unique
}

function toTextContent(input: EmbeddingInput): string {
  if (typeof input.content === "string") return input.content
  if (input.content instanceof Uint8Array) return new TextDecoder().decode(input.content)
  return new TextDecoder().decode(new Uint8Array(input.content))
}

function cacheKey(input: EmbeddingInput) {
  const content = typeof input.content === "string" ? input.content : `${input.path ?? "binary"}:${input.mimeType ?? "application/octet-stream"}`
  return `${input.modality ?? "text"}:${content}`
}

function tokenise(text: string) {
  const normalized = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]+/gu, " ")
    .replace(/\s+/g, " ")
    .trim()
  if (!normalized) return [] as string[]

  const words = normalized.split(" ").filter(Boolean)
  const bigrams: string[] = []
  for (let i = 0; i < normalized.length - 1; i++) {
    const part = normalized.slice(i, i + 2).trim()
    if (part) bigrams.push(part)
  }
  return [...words, ...bigrams]
}

function tokeniseForProfile(text: string, profile: RetrievalEmbeddingProfile) {
  const tokens = new Set(tokenise(text))
  if (profile === "code") {
    for (const match of text.matchAll(/[A-Za-z_][A-Za-z0-9_]*/g)) {
      const token = match[0]
      tokens.add(token.toLowerCase())
      const camelParts = token.split(/(?=[A-Z])/).map((part) => part.toLowerCase()).filter(Boolean)
      for (const part of camelParts) {
        if (part.length > 1) tokens.add(part)
      }
    }
    for (const match of text.matchAll(/(::|=>|->|\.|#|\/|\{|\}|\(|\)|\[|\])/g)) {
      tokens.add(match[0])
    }
  }
  return [...tokens]
}

function lexicalHashVector(text: string, dimensions: number, profile: RetrievalEmbeddingProfile) {
  const vector = new Array(dimensions).fill(0)
  const tokens = tokeniseForProfile(text, profile)
  if (tokens.length === 0) return vector

  for (const token of tokens) {
    const seed = computeRollingHash(`${profile}:${token}`)
    const index = seed % dimensions
    const sign = seed & 1 ? 1 : -1
    const magnitude = profile === "code" ? 1.1 + ((seed >>> 10) % 9) / 10 : 0.8 + ((seed >>> 10) % 7) / 10
    vector[index] += sign * magnitude
  }

  return normalizeVector(vector)
}

function inferRetrievalProfile(input: EmbeddingInput): RetrievalEmbeddingProfile {
  const chunkType = typeof input.metadata?.chunkType === "string" ? input.metadata.chunkType : undefined
  const filePath = input.path?.toLowerCase() ?? ""
  if (/\.(md|mdx|txt|rst|adoc)$/i.test(filePath) || input.modality === "document") return "text"
  if (chunkType === "code") return "code"
  if (chunkType === "text") return "text"
  if (/\.(ts|tsx|js|jsx|mjs|cjs|py|rs|go|java|cpp|c|h|hpp|cs|php|swift|kt|scala|vue|svelte)$/i.test(filePath)) {
    return chunkType === "mixed" ? "text" : "code"
  }
  return "text"
}

function retrievalText(input: EmbeddingInput) {
  const text = input.modality === "image"
    ? `${input.path ?? "image"} ${JSON.stringify(input.metadata ?? {})}`
    : toTextContent(input)
  return `${input.path ?? ""}\n${text}`.trim()
}

function buildFineEmbedding(input: EmbeddingInput, coarse: number[], profile: RetrievalEmbeddingProfile) {
  const dimensions = RETRIEVAL_DIMENSIONS[profile]
  const semantic = resizeVector(coarse, dimensions)
  const lexical = lexicalHashVector(retrievalText(input), dimensions, profile)
  return mergeVectors(semantic, lexical, profile === "code" ? 0.58 : 0.7)
}

class SemanticFallbackEmbeddingProvider implements EmbeddingProvider {
  name = "semantic-fallback"
  dimensions = DEFAULT_DIMENSIONS
  kind = "fallback" as const

  supports() {
    return true
  }

  async embed(input: EmbeddingInput): Promise<number[]> {
    const text = input.modality === "image"
      ? `${input.path ?? "image"} ${JSON.stringify(input.metadata ?? {})}`
      : toTextContent(input)
    const vector = new Array(this.dimensions).fill(0)
    const tokens = tokenise(text)
    if (tokens.length === 0) return vector

    for (const token of tokens) {
      const seed = computeRollingHash(`${input.modality}:${token}`)
      const index = seed % this.dimensions
      const sign = seed & 1 ? 1 : -1
      const magnitude = 1 + ((seed >>> 8) % 7) / 10
      vector[index] += sign * magnitude
    }

    if (input.modality === "document") {
      vector[0] += Math.min(3, Math.max(1, text.length / 2048))
    }
    if (input.modality === "image") {
      vector[1] += 1.5
    }

    return normalizeVector(vector)
  }
}

function extractEmbeddingArray(output: any): number[] {
  if (!output) return []
  if (Array.isArray(output)) {
    if (Array.isArray(output[0])) return Array.from(output[0] as number[])
    return Array.from(output as number[])
  }
  if (output.data && typeof output.data.length === "number") {
    return Array.from(output.data as Iterable<number>)
  }
  if (output.tolist instanceof Function) {
    const listed = output.tolist()
    if (Array.isArray(listed?.[0])) return Array.from(listed[0] as number[])
    if (Array.isArray(listed)) return Array.from(listed as number[])
  }
  return []
}

export class TransformersEmbeddingProvider implements EmbeddingProvider {
  name = "transformers-multimodal"
  dimensions = 768
  kind = "transformers" as const
  private initialized = false
  private textPipeline: any
  private imagePipeline?: any
  private readonly textModel = resolveTransformersTextModel()
  private readonly imageModel = resolveTransformersImageModel()
  private readonly textPooling = /qwen3-embedding/i.test(this.textModel) ? "last_token" : "mean"
  private readonly pipelineOptions: Record<string, unknown> = {
    quantized: true,
  }

  supports() {
    return true
  }

  async initialize() {
    if (this.initialized) return

    await rankHealthyEndpoints([MIRRORS.modelscope, MIRRORS["hf-mirror"], MIRRORS.huggingface], 2000).catch(() => [])
    const transformers = await import("@huggingface/transformers")
    const { pipeline, env } = transformers
    const remoteHosts = resolveTransformersRemoteHosts()
    if (env) {
      env.allowRemoteModels = true
      env.allowLocalModels = true
      env.remotePathTemplate = TRANSFORMERS_REMOTE_PATH_TEMPLATE
    }

    const devicePreference = await resolveTransformersDevicePreference()
    if (devicePreference.device === "webgpu") {
      this.pipelineOptions.device = "webgpu"
    }
    log.info("transformers device resolved", {
      device: devicePreference.device ?? "wasm",
      reason: devicePreference.reason,
      runtimeWebGPU: devicePreference.hasRuntimeWebGPU,
      systemGPU: devicePreference.hasSystemGPU,
      evidence: devicePreference.evidence,
    })

    let lastTextError: unknown
    for (const remoteHost of remoteHosts) {
      if (env) {
        env.remoteHost = remoteHost
      }

      try {
        this.textPipeline = await pipeline("feature-extraction", this.textModel, {
          ...this.pipelineOptions,
        })
        break
      } catch (error) {
        if (isLegacyMiniLMResolutionError(error)) {
          lastTextError = new Error(
            "Detected legacy MiniLM dependency path during transformers initialization; aborting retries and falling back.",
          )
          log.warn("transformers text model init hit legacy MiniLM dependency path", {
            model: this.textModel,
            remoteHost,
            error: String(error),
          })
          break
        }

        lastTextError = error
        log.warn("transformers text model init failed", {
          model: this.textModel,
          remoteHost,
          error: String(error),
        })
      }
    }

    if (!this.textPipeline) {
      throw (lastTextError ?? new Error("Transformers text pipeline init failed"))
    }

    try {
      this.imagePipeline = await pipeline("image-feature-extraction", this.imageModel, {
        ...this.pipelineOptions,
      })
    } catch (error) {
      this.imagePipeline = undefined
      log.warn("transformers image model init failed, continuing with text-only embeddings", {
        model: this.imageModel,
        error: String(error),
      })
    }

    this.initialized = true
  }

  async embed(input: EmbeddingInput): Promise<number[]> {
    if (!this.initialized) {
      await this.initialize()
    }

    if (input.modality === "image") {
      if (this.imagePipeline) {
        const output = await this.imagePipeline(input.content, {
          pooling: "mean",
          normalize: true,
        })
        return extractEmbeddingArray(output)
      }

      const fallbackText = `${input.path ?? "image"} ${JSON.stringify(input.metadata ?? {})}`.trim() || "image"
      const output = await this.textPipeline(fallbackText, {
        pooling: this.textPooling,
        normalize: true,
      })
      return extractEmbeddingArray(output)
    }

    const output = await this.textPipeline(toTextContent(input), {
      pooling: this.textPooling,
      normalize: true,
    })
    return extractEmbeddingArray(output)
  }
}

// ---------------------------------------------------------------------------
// External embedding providers (OpenAI, Cohere) — configurable via settings.
// These call remote APIs so they are only activated when credentials are set.
// ---------------------------------------------------------------------------

export interface ExternalEmbeddingConfig {
  provider: "openai" | "cohere" | "voyage"
  apiKey: string
  model?: string
  dimensions?: number
  baseUrl?: string
}

export class OpenAIEmbeddingProvider implements EmbeddingProvider {
  name: string
  dimensions: number
  kind = "transformers" as const // treated as a real provider (not fallback)
  private config: Required<Pick<ExternalEmbeddingConfig, "apiKey" | "model" | "dimensions" | "baseUrl">>

  constructor(config: ExternalEmbeddingConfig) {
    this.config = {
      apiKey: config.apiKey,
      model: config.model ?? "text-embedding-3-small",
      dimensions: config.dimensions ?? 1536,
      baseUrl: config.baseUrl ?? "https://api.openai.com/v1",
    }
    this.name = `openai:${this.config.model}`
    this.dimensions = this.config.dimensions
  }

  supports() {
    return true
  }

  async embed(input: EmbeddingInput): Promise<number[]> {
    const text = toTextContent(input)
    const response = await fetch(`${this.config.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: this.config.model, input: text }),
    })
    if (!response.ok) {
      const body = await response.text().catch(() => response.statusText)
      throw new Error(`OpenAI embeddings API error ${response.status}: ${body.slice(0, 200)}`)
    }
    const json = (await response.json()) as { data: Array<{ embedding: number[] }> }
    const embedding = json.data[0]?.embedding
    if (!embedding?.length) throw new Error("OpenAI embeddings API returned empty embedding")
    return embedding
  }

  async embedBatch(inputs: EmbeddingInput[]): Promise<number[][]> {
    const texts = inputs.map(toTextContent)
    const response = await fetch(`${this.config.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: this.config.model, input: texts }),
    })
    if (!response.ok) {
      const body = await response.text().catch(() => response.statusText)
      throw new Error(`OpenAI embeddings batch API error ${response.status}: ${body.slice(0, 200)}`)
    }
    const json = (await response.json()) as { data: Array<{ embedding: number[]; index: number }> }
    // API returns objects sorted by index; rebuild in original order
    const result = new Array<number[]>(inputs.length)
    for (const item of json.data) {
      result[item.index] = item.embedding
    }
    return result
  }
}

export class CohereEmbeddingProvider implements EmbeddingProvider {
  name: string
  dimensions: number
  kind = "transformers" as const
  private config: Required<Pick<ExternalEmbeddingConfig, "apiKey" | "model" | "dimensions" | "baseUrl">>

  constructor(config: ExternalEmbeddingConfig) {
    this.config = {
      apiKey: config.apiKey,
      model: config.model ?? "embed-english-v3.0",
      dimensions: config.dimensions ?? 1024,
      baseUrl: config.baseUrl ?? "https://api.cohere.com/v1",
    }
    this.name = `cohere:${this.config.model}`
    this.dimensions = this.config.dimensions
  }

  supports() {
    return true
  }

  async embed(input: EmbeddingInput): Promise<number[]> {
    const result = await this.embedBatch([input])
    return result[0]
  }

  async embedBatch(inputs: EmbeddingInput[]): Promise<number[][]> {
    const texts = inputs.map(toTextContent)
    const inputType = inputs[0]?.modality === "document" ? "search_document" : "search_query"
    const response = await fetch(`${this.config.baseUrl}/embed`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: this.config.model, texts, input_type: inputType, embedding_types: ["float"] }),
    })
    if (!response.ok) {
      const body = await response.text().catch(() => response.statusText)
      throw new Error(`Cohere embed API error ${response.status}: ${body.slice(0, 200)}`)
    }
    const json = (await response.json()) as { embeddings: { float: number[][] } }
    return json.embeddings.float
  }
}

export class VoyageEmbeddingProvider implements EmbeddingProvider {
  name: string
  dimensions: number
  kind = "transformers" as const
  private config: Required<Pick<ExternalEmbeddingConfig, "apiKey" | "model" | "dimensions" | "baseUrl">>

  constructor(config: ExternalEmbeddingConfig) {
    this.config = {
      apiKey: config.apiKey,
      model: config.model ?? "voyage-3-lite",
      dimensions: config.dimensions ?? 1024,
      baseUrl: config.baseUrl ?? "https://api.voyageai.com/v1",
    }
    this.name = `voyage:${this.config.model}`
    this.dimensions = this.config.dimensions
  }

  supports() {
    return true
  }

  async embed(input: EmbeddingInput): Promise<number[]> {
    const result = await this.embedBatch([input])
    return result[0]
  }

  async embedBatch(inputs: EmbeddingInput[]): Promise<number[][]> {
    const texts = inputs.map(toTextContent)
    const inputType = inputs[0]?.modality === "document" ? "document" : "query"
    const response = await fetch(`${this.config.baseUrl}/embeddings`, {
      method: "POST",
      headers: {
        "Authorization": `Bearer ${this.config.apiKey}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({ model: this.config.model, input: texts, input_type: inputType }),
    })
    if (!response.ok) {
      const body = await response.text().catch(() => response.statusText)
      throw new Error(`Voyage embeddings API error ${response.status}: ${body.slice(0, 200)}`)
    }
    const json = (await response.json()) as { data: Array<{ embedding: number[]; index: number }> }
    const result = new Array<number[]>(inputs.length)
    for (const item of json.data) {
      result[item.index] = item.embedding
    }
    return result
  }
}

export class EmbeddingService {
  private cache: Map<string, CachedEmbedding> = new Map()
  private maxSize: number
  private ttlMs: number
  private readonly fallbackProvider: EmbeddingProvider
  private activeProvider: EmbeddingProvider
  private configuredProvider?: EmbeddingProvider
  private upgradeCallbacks: Array<(provider: EmbeddingProvider) => void> = []
  private runtimeState: EmbeddingRuntimeState

  constructor(maxSize: number = MAX_CACHE_SIZE, ttlMs: number = TTL_MS) {
    this.maxSize = maxSize
    this.ttlMs = ttlMs
    this.fallbackProvider = new SemanticFallbackEmbeddingProvider()
    this.activeProvider = this.fallbackProvider
    this.runtimeState = {
      mode: "fallback",
      activeProvider: this.activeProvider.name,
      configuredProvider: undefined,
      activeProviderKind: this.activeProvider.kind,
      updatedAt: Date.now(),
    }
  }

  private updateRuntimeState(partial: Partial<EmbeddingRuntimeState>) {
    this.runtimeState = {
      ...this.runtimeState,
      ...partial,
      activeProvider: this.activeProvider.name,
      configuredProvider: this.configuredProvider?.name,
      activeProviderKind: this.activeProvider.kind,
      mode: this.activeProvider === this.fallbackProvider ? "fallback" : "provider",
      updatedAt: Date.now(),
    }
  }

  private finalizeEmbedding(vector: number[]) {
    return sanitizeVector(vector, EMBEDDING_OUTPUT_DIMENSIONS)
  }

  private async embedWithFallback(input: EmbeddingInput) {
    try {
      return this.finalizeEmbedding(await this.activeProvider.embed(input))
    } catch (error) {
      if (this.activeProvider === this.fallbackProvider) {
        throw error
      }

      log.warn("embedding provider failed, falling back to semantic provider", {
        provider: this.activeProvider.name,
        error: String(error),
      })
      this.activeProvider = this.fallbackProvider
      this.updateRuntimeState({
        lastError: `provider=${this.configuredProvider?.name ?? "unknown"}: ${String(error)}`,
      })
      return this.finalizeEmbedding(await this.fallbackProvider.embed(input))
    }
  }

  async getEmbedding(input: string | EmbeddingInput): Promise<number[]> {
    const normalized = normalizeInput(input)
    const key = cacheKey(normalized)
    const cached = this.cache.get(key)
    if (cached && Date.now() - cached.timestamp < this.ttlMs) {
      return cached.embedding
    }

    const embedding = await this.embedWithFallback(normalized)
    this.cache.set(key, {
      embedding,
      timestamp: Date.now(),
    })

    if (this.cache.size > this.maxSize) {
      const firstKey = this.cache.keys().next().value
      if (firstKey !== undefined) this.cache.delete(firstKey)
    }

    return embedding
  }

  async getBatchEmbeddings(texts: Array<string | EmbeddingInput>): Promise<number[][]> {
    const normalized = texts.map((text) => normalizeInput(text))
    const cached = normalized.map((input) => {
      const key = cacheKey(input)
      const entry = this.cache.get(key)
      return entry && Date.now() - entry.timestamp < this.ttlMs ? entry.embedding : undefined
    })

    const missing = normalized
      .map((input, index) => ({ input, index }))
      .filter(({ index }) => !cached[index])

    if (missing.length === 0) {
      return cached as number[][]
    }

    let generated: number[][]
    if (this.activeProvider.embedBatch) {
      try {
        generated = (await this.activeProvider.embedBatch(missing.map((item) => item.input))).map((item) =>
          this.finalizeEmbedding(item),
        )
      } catch (error) {
        if (this.activeProvider !== this.fallbackProvider) {
          log.warn("batch embedding provider failed, falling back to semantic provider", {
            provider: this.activeProvider.name,
            error: String(error),
          })
          this.activeProvider = this.fallbackProvider
          this.updateRuntimeState({
            lastError: `provider=${this.configuredProvider?.name ?? "unknown"}: ${String(error)}`,
          })
          generated = await Promise.all(missing.map((item) => this.embedWithFallback(item.input)))
        } else {
          throw error
        }
      }
    } else {
      generated = await Promise.all(missing.map((item) => this.embedWithFallback(item.input)))
    }

    const result = [...cached]
    missing.forEach((item, index) => {
      const embedding = generated[index]
      result[item.index] = embedding
      this.cache.set(cacheKey(item.input), {
        embedding,
        timestamp: Date.now(),
      })
    })

    if (this.cache.size > this.maxSize) {
      while (this.cache.size > this.maxSize) {
        const firstKey = this.cache.keys().next().value
        if (firstKey === undefined) break
        this.cache.delete(firstKey)
      }
    }

    return result as number[][]
  }

  async getRetrievalEmbedding(input: string | EmbeddingInput): Promise<RetrievalEmbeddingBundle> {
    const normalized = normalizeInput(input)
    const coarse = await this.getEmbedding(normalized)
    const profile = inferRetrievalProfile(normalized)
    const fine = buildFineEmbedding(normalized, coarse, profile)
    return {
      coarse,
      fine,
      profile,
      coarseDimensions: RETRIEVAL_DIMENSIONS.coarse,
      fineDimensions: RETRIEVAL_DIMENSIONS[profile],
    }
  }

  async getQueryEmbeddings(input: string | EmbeddingInput): Promise<QueryEmbeddingBundle> {
    const normalized = normalizeInput(input)
    const coarse = await this.getEmbedding(normalized)
    return {
      coarse,
      fineByProfile: {
        code: buildFineEmbedding(normalized, coarse, "code"),
        text: buildFineEmbedding(normalized, coarse, "text"),
      },
    }
  }

  async configureProvider(provider: EmbeddingProvider): Promise<void> {
    this.configuredProvider = provider
    await provider.initialize?.()
    this.activeProvider = provider
    this.updateRuntimeState({ lastError: undefined })
    this.clear()
    for (const callback of this.upgradeCallbacks) {
      callback(provider)
    }
  }

  /**
   * Configure the embedding service from external settings.
   * Constructs the appropriate provider from the supplied config and activates it.
   */
  async configureFromSettings(config: ExternalEmbeddingConfig): Promise<void> {
    let provider: EmbeddingProvider
    switch (config.provider) {
      case "openai":
        provider = new OpenAIEmbeddingProvider(config)
        break
      case "cohere":
        provider = new CohereEmbeddingProvider(config)
        break
      case "voyage":
        provider = new VoyageEmbeddingProvider(config)
        break
      default:
        throw new Error(`Unsupported external embedding provider: ${config.provider}`)
    }
    await this.configureProvider(provider)
  }

  useFallback(): void {
    this.activeProvider = this.fallbackProvider
    this.updateRuntimeState({
      lastError: this.runtimeState.lastError,
    })
    this.clear()
  }

  getProvider(): EmbeddingProvider {
    return this.activeProvider
  }

  getConfiguredProvider(): EmbeddingProvider | undefined {
    return this.configuredProvider
  }

  getRuntimeState(): EmbeddingRuntimeState {
    return { ...this.runtimeState }
  }

  reportProviderFailure(error: string): void {
    this.updateRuntimeState({ lastError: error })
  }

  onUpgrade(callback: (provider: EmbeddingProvider) => void): () => void {
    this.upgradeCallbacks.push(callback)
    return () => {
      const index = this.upgradeCallbacks.indexOf(callback)
      if (index >= 0) this.upgradeCallbacks.splice(index, 1)
    }
  }

  clear(): void {
    this.cache.clear()
  }
}

export const embeddingService = new EmbeddingService()
