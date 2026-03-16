import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "@/global"
import { Log } from "@/util/log"
import { openSochDatabase, sochDelete, sochGetJson, sochPutJson } from "@/util/sochdb"

const log = Log.create({ service: "cache" })

export interface CacheEntry<T> {
  value: T
  timestamp: number
  ttl: number
}

interface CacheStats {
  size: number
  maxSize: number
  hitRate: number
}

interface CacheBackend<T> {
  readonly name: string
  initialize(): Promise<void>
  isReady(): boolean
  get(key: string): Promise<CacheEntry<T> | undefined>
  set(key: string, entry: CacheEntry<T>): Promise<void>
  delete(key: string): Promise<void>
  clear(): Promise<void>
}

class MemoryCache<T> {
  private cache = new Map<string, CacheEntry<T>>()

  constructor(
    private readonly maxSize: number = 10000,
    private readonly defaultTtl: number = 3600000,
  ) {}

  get(key: string): T | undefined {
    return this.getEntry(key)?.value
  }

  getEntry(key: string): CacheEntry<T> | undefined {
    const entry = this.cache.get(key)
    if (!entry) return undefined
    if (Date.now() - entry.timestamp > entry.ttl) {
      this.cache.delete(key)
      return undefined
    }

    this.cache.delete(key)
    this.cache.set(key, entry)
    return entry
  }

  set(key: string, value: T, ttl?: number) {
    this.setEntry(key, {
      value,
      timestamp: Date.now(),
      ttl: ttl ?? this.defaultTtl,
    })
  }

  setEntry(key: string, entry: CacheEntry<T>) {
    if (this.cache.has(key)) {
      this.cache.delete(key)
    }

    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value
      if (firstKey) {
        this.cache.delete(firstKey)
      }
    }

    this.cache.set(key, entry)
  }

  has(key: string) {
    return this.getEntry(key) !== undefined
  }

  delete(key: string) {
    return this.cache.delete(key)
  }

  clear() {
    this.cache.clear()
  }

  size() {
    return this.cache.size
  }

  getStats(): CacheStats {
    return {
      size: this.cache.size,
      maxSize: this.maxSize,
      hitRate: 0,
    }
  }
}

class SochDBCacheBackend<T> implements CacheBackend<T> {
  private db: any
  private ready = false
  private initTask?: Promise<void>

  constructor(
    readonly name: string,
    private readonly dbPath: string,
  ) {}

  initialize(): Promise<void> {
    if (this.initTask) return this.initTask
    this.initTask = (async () => {
      await fs.mkdir(path.dirname(this.dbPath), { recursive: true })
      this.db = await openSochDatabase(this.dbPath)
      this.ready = true
    })().catch((error) => {
      this.ready = false
      this.initTask = undefined
      throw error
    })
    return this.initTask
  }

  isReady() {
    return this.ready
  }

  async get(key: string) {
    if (!this.ready || !this.db) return undefined
    return sochGetJson<CacheEntry<T>>(this.db, key)
  }

  async set(key: string, entry: CacheEntry<T>) {
    if (!this.ready || !this.db) return
    await sochPutJson(this.db, key, entry)
  }

  async delete(key: string) {
    if (!this.ready || !this.db) return
    await sochDelete(this.db, key).catch(() => undefined)
  }

  async clear() {
    this.ready = false
    this.db = undefined
    this.initTask = undefined
    await fs.rm(this.dbPath, { recursive: true, force: true }).catch(() => undefined)
    await this.initialize().catch((error) => {
      log.warn("sochdb cache backend clear reinit failed", {
        backend: this.name,
        error: String(error),
      })
    })
  }
}

class JsonFileCacheBackend<T> implements CacheBackend<T> {
  private ready = false
  private initTask?: Promise<void>

  constructor(
    readonly name: string,
    private readonly dir: string,
  ) {}

  initialize(): Promise<void> {
    if (this.initTask) return this.initTask
    this.initTask = fs.mkdir(this.dir, { recursive: true })
      .then(() => {
        this.ready = true
      })
      .catch((error) => {
        this.ready = false
        this.initTask = undefined
        throw error
      })
    return this.initTask
  }

  isReady() {
    return this.ready
  }

  async get(key: string) {
    if (!this.ready) return undefined
    const file = this.fileFor(key)
    const raw = await fs.readFile(file, "utf-8").catch(() => undefined)
    if (!raw) return undefined
    return JSON.parse(raw) as CacheEntry<T>
  }

  async set(key: string, entry: CacheEntry<T>) {
    if (!this.ready) return
    const file = this.fileFor(key)
    const tmp = `${file}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
    await fs.writeFile(tmp, JSON.stringify(entry), "utf-8")
    try {
      await fs.rename(tmp, file)
    } finally {
      await fs.rm(tmp, { force: true }).catch(() => undefined)
    }
  }

  async delete(key: string) {
    if (!this.ready) return
    await fs.rm(this.fileFor(key), { force: true }).catch(() => undefined)
  }

  async clear() {
    this.ready = false
    this.initTask = undefined
    await fs.rm(this.dir, { recursive: true, force: true }).catch(() => undefined)
    await this.initialize()
  }

  private fileFor(key: string) {
    return path.join(this.dir, `${encodeURIComponent(key)}.json`)
  }
}

export type CacheName = "vector" | "idempotency" | "entity" | "relationship" | "prompt" | "graph" | "structured"
export type CacheKind = "kv" | "vector" | "graph" | "structured"

interface ManagedCacheOptions<T> {
  name: string
  kind: CacheKind
  maxSize: number
  ttl: number
  sochNamespace?: string | false
  jsonDir?: string
}

export class ManagedCache<T> {
  private readonly memory: MemoryCache<T>
  private readonly backends: CacheBackend<T>[]
  private readonly backendInitTasks = new Map<string, Promise<void>>()
  private readonly readyCallbacks = new Set<() => void>()
  private readonly pendingEntries = new Map<string, Map<string, CacheEntry<T> | null>>()
  private readonly pendingClearBackends = new Set<string>()

  constructor(private readonly options: ManagedCacheOptions<T>) {
    this.memory = new MemoryCache<T>(options.maxSize, options.ttl)
    this.backends = []

    if (options.sochNamespace !== false) {
      const namespace = options.sochNamespace ?? options.name
      this.backends.push(
        new SochDBCacheBackend<T>(
          `sochdb:${namespace}`,
          path.join(Global.Path.data, "sochdb", "cache", sanitizeSegment(namespace)),
        ),
      )
    }

    if (options.jsonDir) {
      this.backends.push(new JsonFileCacheBackend<T>(`json:${options.name}`, options.jsonDir))
    }
  }

  getName() {
    return this.options.name
  }

  isPersistentReady() {
    return this.backends.some((backend) => backend.isReady())
  }

  onPersistentReady(callback: () => void) {
    this.ensureBackendsStarted()
    this.readyCallbacks.add(callback)
    if (this.isPersistentReady()) {
      queueMicrotask(callback)
    }
    return () => {
      this.readyCallbacks.delete(callback)
    }
  }

  async whenPersistentReady() {
    this.ensureBackendsStarted()
    await Promise.allSettled(this.backendInitTasks.values())
  }

  getMemory(key: string) {
    return this.memory.get(key)
  }

  setMemory(key: string, value: T, ttl?: number) {
    this.memory.set(key, value, ttl)
  }

  async get(key: string): Promise<T | undefined> {
    this.ensureBackendsStarted()
    const cached = this.memory.get(key)
    if (cached !== undefined) {
      return cached
    }

    const entry = await this.getPersistentEntry(key)
    if (!entry) return undefined
    this.memory.setEntry(key, entry)
    return entry.value
  }

  async getPersistent(key: string): Promise<T | undefined> {
    this.ensureBackendsStarted()
    const entry = await this.getPersistentEntry(key)
    if (!entry) return undefined
    this.memory.setEntry(key, entry)
    return entry.value
  }

  async set(key: string, value: T, options?: { ttl?: number }) {
    this.ensureBackendsStarted()
    const entry: CacheEntry<T> = {
      value,
      timestamp: Date.now(),
      ttl: options?.ttl ?? this.options.ttl,
    }
    this.memory.setEntry(key, entry)
    await Promise.all(
      this.backends.map(async (backend) => {
        if (backend.isReady()) {
          await backend.set(key, entry)
          return
        }
        this.queuePendingEntry(backend.name, key, entry)
      }),
    )
    return true
  }

  async has(key: string) {
    if (this.memory.has(key)) return true
    return (await this.get(key)) !== undefined
  }

  async delete(key: string) {
    this.ensureBackendsStarted()
    const deleted = this.memory.delete(key)
    await Promise.all(
      this.backends.map(async (backend) => {
        if (backend.isReady()) {
          await backend.delete(key)
          return
        }
        this.queuePendingEntry(backend.name, key, null)
      }),
    )
    return deleted
  }

  async clear() {
    this.ensureBackendsStarted()
    this.memory.clear()
    this.pendingEntries.clear()
    await Promise.all(
      this.backends.map(async (backend) => {
        if (backend.isReady()) {
          await backend.clear()
          return
        }
        this.pendingClearBackends.add(backend.name)
      }),
    )
  }

  size() {
    return this.memory.size()
  }

  getStats(): CacheStats {
    return this.memory.getStats()
  }

  private ensureBackendsStarted() {
    for (const backend of this.backends) {
      if (this.backendInitTasks.has(backend.name)) continue
      const task = backend.initialize()
        .then(() => {
          this.notifyReady()
        })
        .catch((error) => {
          log.warn("cache backend init failed", {
            cache: this.options.name,
            backend: backend.name,
            error: String(error),
          })
        })
      this.backendInitTasks.set(backend.name, task)
    }
  }

  private async getPersistentEntry(key: string) {
    for (const backend of this.backends) {
      if (!backend.isReady()) continue
      const entry = await backend.get(key).catch((error) => {
        log.warn("cache backend read failed", {
          cache: this.options.name,
          backend: backend.name,
          key,
          error: String(error),
        })
        return undefined
      })
      if (!entry) continue
      if (Date.now() - entry.timestamp > entry.ttl) {
        await backend.delete(key).catch(() => undefined)
        continue
      }
      return entry
    }
    return undefined
  }

  private notifyReady() {
    for (const backend of this.backends) {
      if (!backend.isReady()) continue
      void this.flushPending(backend).catch((error) => {
        log.warn("cache backend pending flush failed", {
          cache: this.options.name,
          backend: backend.name,
          error: String(error),
        })
      })
    }
    for (const callback of this.readyCallbacks) {
      callback()
    }
  }

  private async flushPending(backend: CacheBackend<T>) {
    if (!backend.isReady()) return
    if (this.pendingClearBackends.has(backend.name)) {
      await backend.clear()
      this.pendingClearBackends.delete(backend.name)
    }

    const queue = this.pendingEntries.get(backend.name)
    if (!queue) return

    const entries = Array.from(queue.entries())
    for (const [key, entry] of entries) {
      if (entry === null) {
        await backend.delete(key)
      } else {
        await backend.set(key, entry)
      }
    }
    this.pendingEntries.delete(backend.name)
  }

  private queuePendingEntry(backendName: string, key: string, entry: CacheEntry<T> | null) {
    let queue = this.pendingEntries.get(backendName)
    if (!queue) {
      queue = new Map<string, CacheEntry<T> | null>()
      this.pendingEntries.set(backendName, queue)
    }
    queue.set(key, entry)
  }
}

function sanitizeSegment(value: string) {
  return value.replace(/[^A-Za-z0-9._-]+/g, "_") || "default"
}

const CACHE_CONFIGS: Record<CacheName, { maxSize: number; ttl: number; kind: CacheKind; sochNamespace?: string | false }> = {
  vector: { maxSize: 1000, ttl: 86400000, kind: "vector" },
  idempotency: { maxSize: 10000, ttl: 3600000, kind: "kv" },
  entity: { maxSize: 5000, ttl: 1800000, kind: "graph" },
  relationship: { maxSize: 5000, ttl: 1800000, kind: "graph" },
  prompt: { maxSize: 10000, ttl: 3600000, kind: "kv" },
  graph: { maxSize: 256, ttl: 86400000, kind: "graph" },
  structured: { maxSize: 1024, ttl: 300000, kind: "structured" },
}

export class CacheStrategyFactory {
  private static stores = new Map<string, ManagedCache<unknown>>()

  static getNamedCache(name: CacheName) {
    const config = CACHE_CONFIGS[name]
    const existing = this.stores.get(name)
    if (existing) return existing
    const next = new ManagedCache<unknown>({
      name,
      kind: config.kind,
      maxSize: config.maxSize,
      ttl: config.ttl,
      sochNamespace: config.sochNamespace ?? `cache-${name}`,
    })
    this.stores.set(name, next)
    return next
  }

  static createCache<T>(options: ManagedCacheOptions<T>) {
    const key = JSON.stringify({
      name: options.name,
      kind: options.kind,
      maxSize: options.maxSize,
      ttl: options.ttl,
      sochNamespace: options.sochNamespace ?? null,
      jsonDir: options.jsonDir ?? null,
    })
    const existing = this.stores.get(key)
    if (existing) return existing as ManagedCache<T>
    const next = new ManagedCache<T>(options)
    this.stores.set(key, next as ManagedCache<unknown>)
    return next
  }

  static async clearAll() {
    await Promise.all(Array.from(this.stores.values()).map((store) => store.clear()))
  }
}

const caches = {
  vector: CacheStrategyFactory.getNamedCache("vector"),
  idempotency: CacheStrategyFactory.getNamedCache("idempotency"),
  entity: CacheStrategyFactory.getNamedCache("entity"),
  relationship: CacheStrategyFactory.getNamedCache("relationship"),
  prompt: CacheStrategyFactory.getNamedCache("prompt"),
  graph: CacheStrategyFactory.getNamedCache("graph"),
  structured: CacheStrategyFactory.getNamedCache("structured"),
}

export function getCache(name: CacheName): ManagedCache<unknown> {
  return caches[name]
}

export const vectorCache = caches.vector
export const idempotencyCache = caches.idempotency
export const entityCache = caches.entity
export const relationshipCache = caches.relationship
export const promptCache = caches.prompt
export const graphCache = caches.graph
export const structuredCache = caches.structured

export async function getOrSet<T>(
  cacheName: CacheName,
  key: string,
  factory: () => Promise<T>,
  options?: { ttl?: number },
): Promise<T> {
  const cache = getCache(cacheName)
  const cached = (await cache.get(key)) as T | undefined
  if (cached !== undefined) {
    return cached
  }

  const value = await factory()
  await cache.set(key, value, options)
  return value
}

export async function set<T>(cacheName: CacheName, key: string, value: T, options?: { ttl?: number }) {
  await getCache(cacheName).set(key, value, options)
  return true
}

export async function get<T>(cacheName: CacheName, key: string) {
  return (await getCache(cacheName).get(key)) as T | undefined
}

export async function has(cacheName: CacheName, key: string) {
  return getCache(cacheName).has(key)
}

export async function del(cacheName: CacheName, key: string) {
  return getCache(cacheName).delete(key)
}

export async function clearCache(cacheName: CacheName) {
  await getCache(cacheName).clear()
}

export function clearGitCache(): void {
  void getCache("idempotency").clear()
}

export async function clearAllCaches(): Promise<void> {
  await CacheStrategyFactory.clearAll()
}
