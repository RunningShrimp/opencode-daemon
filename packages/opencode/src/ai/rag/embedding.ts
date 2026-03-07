const mulberry32 = (seed: number) => {
  let t = seed >>> 0
  return () => {
    t += 0x6d2b79f5
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const hash = (input: string): number => {
  let hash = 2166136261 >>> 0
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619) >>> 0
  }
  return hash >>> 0
}

const embed = (input: string): number[] => {
  const rand = mulberry32(hash(input))
  return Array.from({ length: 384 }, () => rand())
}

const MAX_CACHE_SIZE = 10000
const TTL_MS = 24 * 60 * 60 * 1000

export interface CachedEmbedding {
  embedding: number[]
  timestamp: number
}

export class EmbeddingService {
  private cache: Map<string, CachedEmbedding> = new Map()
  private maxSize: number
  private ttlMs: number

  constructor(maxSize: number = MAX_CACHE_SIZE, ttlMs: number = TTL_MS) {
    this.maxSize = maxSize
    this.ttlMs = ttlMs
  }

  async getEmbedding(text: string): Promise<number[]> {
    const cached = this.cache.get(text)
    if (cached && Date.now() - cached.timestamp < this.ttlMs) {
      return cached.embedding
    }

    const embedding = embed(text)
    this.cache.set(text, {
      embedding,
      timestamp: Date.now(),
    })

    if (this.cache.size > this.maxSize) {
      const firstKey = this.cache.keys().next().value
      if (firstKey !== undefined) this.cache.delete(firstKey)
    }

    return embedding
  }

  async getBatchEmbeddings(texts: string[]): Promise<number[][]> {
    return Promise.all(texts.map((text) => this.getEmbedding(text)))
  }

  clear(): void {
    this.cache.clear()
  }
}

export const embeddingService = new EmbeddingService()
