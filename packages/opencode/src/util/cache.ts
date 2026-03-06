interface CacheEntry<T> {
  value: T
  timestamp: number
  ttl: number
}

class SimpleCache<T> {
  private cache = new Map<string, CacheEntry<T>>()
  private maxSize: number
  private defaultTtl: number

  constructor(maxSize: number = 10000, defaultTtl: number = 3600000) {
    this.maxSize = maxSize
    this.defaultTtl = defaultTtl
  }

  get(key: string): T | undefined {
    const entry = this.cache.get(key)
    if (!entry) return undefined

    if (Date.now() - entry.timestamp > entry.ttl) {
      this.cache.delete(key)
      return undefined
    }

    return entry.value
  }

  set(key: string, value: T, ttl?: number): void {
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value
      if (firstKey) this.cache.delete(firstKey)
    }

    this.cache.set(key, {
      value,
      timestamp: Date.now(),
      ttl: ttl ?? this.defaultTtl,
    })
  }

  has(key: string): boolean {
    const entry = this.cache.get(key)
    if (!entry) return false

    if (Date.now() - entry.timestamp > entry.ttl) {
      this.cache.delete(key)
      return false
    }

    return true
  }

  delete(key: string): boolean {
    return this.cache.delete(key)
  }

  clear(): void {
    this.cache.clear()
  }

  size(): number {
    return this.cache.size
  }
}

export type CacheName = "vector" | "idempotency" | "entity" | "relationship" | "prompt"

const CACHE_CONFIGS: Record<CacheName, { maxSize: number; ttl: number }> = {
  vector: { maxSize: 1000, ttl: 86400000 },
  idempotency: { maxSize: 10000, ttl: 3600000 },
  entity: { maxSize: 5000, ttl: 1800000 },
  relationship: { maxSize: 5000, ttl: 1800000 },
  prompt: { maxSize: 10000, ttl: 3600000 },
}

const caches = {
  vector: new SimpleCache<unknown>(CACHE_CONFIGS.vector.maxSize, CACHE_CONFIGS.vector.ttl),
  idempotency: new SimpleCache<unknown>(CACHE_CONFIGS.idempotency.maxSize, CACHE_CONFIGS.idempotency.ttl),
  entity: new SimpleCache<unknown>(CACHE_CONFIGS.entity.maxSize, CACHE_CONFIGS.entity.ttl),
  relationship: new SimpleCache<unknown>(CACHE_CONFIGS.relationship.maxSize, CACHE_CONFIGS.relationship.ttl),
  prompt: new SimpleCache<unknown>(CACHE_CONFIGS.prompt.maxSize, CACHE_CONFIGS.prompt.ttl),
}

export function getCache(name: CacheName): SimpleCache<unknown> {
  return caches[name]
}

export const vectorCache = caches.vector
export const idempotencyCache = caches.idempotency
export const entityCache = caches.entity
export const relationshipCache = caches.relationship
export const promptCache = caches.prompt

export async function getOrSet<T>(
  cacheName: CacheName,
  key: string,
  factory: () => Promise<T>,
  options?: { ttl?: number },
): Promise<T> {
  const cache = getCache(cacheName)
  const cached = cache.get(key) as T | undefined
  if (cached !== undefined) {
    return cached
  }

  const value = await factory()
  cache.set(key, value, options?.ttl)
  return value
}

export async function set<T>(
  cacheName: CacheName,
  key: string,
  value: T,
  options?: { ttl?: number },
): Promise<boolean> {
  getCache(cacheName).set(key, value, options?.ttl)
  return true
}

export async function get<T>(cacheName: CacheName, key: string): Promise<T | undefined> {
  return getCache(cacheName).get(key) as T | undefined
}

export async function has(cacheName: CacheName, key: string): Promise<boolean> {
  return getCache(cacheName).has(key)
}

export async function del(cacheName: CacheName, key: string): Promise<boolean> {
  return getCache(cacheName).delete(key)
}

// 清除 git 相关的缓存（在执行 git commit/push/checkout 等操作后调用）
export function clearGitCache(): void {
  const cache = getCache("idempotency")
  // 遍历并删除以 "git-" 开头的缓存键
  // 由于 SimpleCache 没有提供遍历方法，这里使用 clear 清除所有
  // 实际使用时，可以考虑在调用 git 命令后手动清除特定缓存
  cache.clear()
}

export async function clearAllCaches(): Promise<void> {
  for (const cache of Object.values(caches)) {
    cache.clear()
  }
}
