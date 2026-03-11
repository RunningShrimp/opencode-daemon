// Simple deterministic 32-bit PRNG (mulberry32).
const mulberry32 = (seed: number): (() => number) => {
  let t = seed >>> 0
  return () => {
    t += 0x6D2B79F5
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// Compute a single rolling hash over the input string.
const computeRollingHash = (input: string): number => {
  let hash = 2166136261 >>> 0 // FNV-1a 32-bit offset basis
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i)
    hash = Math.imul(hash, 16777619) >>> 0 // FNV-1a prime
  }
  return hash >>> 0
}

const createHash = (input: string): number[] => {
  const DIMENSIONS = 384
  const seed = computeRollingHash(input)
  const rand = mulberry32(seed)

  const embedding: number[] = new Array(DIMENSIONS)
  for (let i = 0; i < DIMENSIONS; i++) {
    // Generate a deterministic pseudo-random value in [0, 1)
    embedding[i] = rand()
  }

  return embedding
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

    const embedding = createHash(text)
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
