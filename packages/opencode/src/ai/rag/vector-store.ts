export interface VectorEntry {
  id: string
  sessionId: string
  path: string
  content: string
  embedding: number[]
  timestamp: number
}

export interface VectorSearchResult {
  id: string
  sessionId: string
  path: string
  content: string
  score: number
}

const MAX_VECTORS_PER_PROJECT = 50000
const MIN_IMPORTANCE = 0.3

export class VectorStore {
  private vectors: Map<string, VectorEntry> = new Map()
  private maxSize: number
  private ttlMs: number

  constructor(maxSize: number = MAX_VECTORS_PER_PROJECT, ttlDays: number = 7) {
    this.maxSize = maxSize
    this.ttlMs = ttlDays * 24 * 60 * 60 * 1000
  }

  async addVector(entry: VectorEntry): Promise<void> {
    if (this.vectors.size >= this.maxSize) {
      this.evictLRU()
    }

    this.vectors.set(entry.id, {
      ...entry,
      timestamp: Date.now(),
    })
  }

  async search(query: number[], limit: number = 10): Promise<VectorSearchResult[]> {
    const results: VectorSearchResult[] = []
    const now = Date.now()

    for (const [id, entry] of this.vectors) {
      if (now - entry.timestamp > this.ttlMs) {
        this.vectors.delete(id)
        continue
      }

      const similarity = this.cosineSimilarity(query, entry.embedding)
      if (similarity > MIN_IMPORTANCE) {
        results.push({
          id: entry.id,
          sessionId: entry.sessionId,
          path: entry.path,
          content: entry.content,
          score: similarity,
        })
      }
    }

    results.sort((a, b) => b.score - a.score)
    return results.slice(0, limit)
  }

  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0
    let dotProduct = 0
    let normA = 0
    let normB = 0
    for (let i = 0; i < a.length; i++) {
      dotProduct += a[i] * b[i]
      normA += a[i] * a[i]
      normB += b[i] * b[i]
    }
    if (normA === 0 || normB === 0) return 0
    return dotProduct / (Math.sqrt(normA) * Math.sqrt(normB))
  }

  private evictLRU(): void {
    let oldest: VectorEntry | null = null
    let oldestKey: string | null = null

    for (const [key, entry] of this.vectors) {
      if (!oldest || entry.timestamp < oldest.timestamp) {
        oldest = entry
        oldestKey = key
      }
    }

    if (oldestKey) {
      this.vectors.delete(oldestKey)
    }
  }

  async deleteBySession(sessionId: string): Promise<void> {
    for (const [key, entry] of this.vectors) {
      if (entry.sessionId === sessionId) {
        this.vectors.delete(key)
      }
    }
  }

  async clear(): Promise<void> {
    this.vectors.clear()
  }
}

export const vectorStore = new VectorStore()
