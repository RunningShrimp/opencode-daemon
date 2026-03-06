export interface PromptCacheEntry {
  prompt: string
  response: string
  timestamp: number
  tokensUsed: number
}

export class PromptCache {
  private cache: Map<string, PromptCacheEntry> = new Map()
  private maxSize: number
  private ttlMs: number

  constructor(maxSize: number = 1000, ttlMs: number = 60 * 60 * 1000) {
    this.maxSize = maxSize
    this.ttlMs = ttlMs
  }

  get(prompt: string): PromptCacheEntry | undefined {
    const entry = this.cache.get(prompt)
    if (!entry) return undefined
    if (Date.now() - entry.timestamp > this.ttlMs) {
      this.cache.delete(prompt)
      return undefined
    }
    return entry
  }

  set(prompt: string, response: string, tokensUsed: number = 0): void {
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value
      if (firstKey !== undefined) this.cache.delete(firstKey)
    }

    this.cache.set(prompt, {
      prompt,
      response,
      timestamp: Date.now(),
      tokensUsed,
    })
  }

  has(prompt: string): boolean {
    const entry = this.get(prompt)
    return entry !== undefined
  }

  delete(prompt: string): boolean {
    return this.cache.delete(prompt)
  }

  clear(): void {
    this.cache.clear()
  }

  size(): number {
    return this.cache.size
  }
}

export const promptCache = new PromptCache()
