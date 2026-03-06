const createHash = (input: string): number[] => {
  const hash: number[] = new Array(384).fill(0)
  for (let i = 0; i < input.length; i++) {
    const char = input.charCodeAt(i)
    for (let j = 0; j < 384; j++) {
      hash[j] = (hash[j] * 31 + char) % 384
    }
  }
  return hash
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
