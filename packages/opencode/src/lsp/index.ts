import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { Log } from "../util/log"
import { LSPClient } from "./client"
import path from "path"
import { pathToFileURL, fileURLToPath } from "url"
import { LSPServer } from "./server"
import z from "zod"
import { Config } from "../config/config"
import { spawn } from "child_process"
import { Instance } from "../project/instance"
import { Flag } from "@/flag/flag"
import { withTimeout } from "../util/timeout"

// Simple in-memory cache for LSP queries
interface CacheEntry<T> {
  value: T
  expiry: number
  accessCount: number
  lastAccess: number
}

// Cache configuration by operation type
interface CacheConfig {
  maxSize: number
  ttlMs: number
  priority: number // Higher = more important, evict last
}

const CACHE_CONFIGS: Record<string, CacheConfig> = {
  hover: { maxSize: 200, ttlMs: 30_000, priority: 3 },
  definition: { maxSize: 150, ttlMs: 45_000, priority: 4 },
  symbol: { maxSize: 100, ttlMs: 60_000, priority: 2 },
  references: { maxSize: 80, ttlMs: 30_000, priority: 2 },
  implementation: { maxSize: 80, ttlMs: 30_000, priority: 2 },
  diagnostics: { maxSize: 50, ttlMs: 10_000, priority: 1 },
}

class LRUCache<K, V> {
  private cache = new Map<K, CacheEntry<V>>()
  private maxSize: number
  private ttlMs: number
  private priority: number

  constructor(maxSize: number, ttlMs: number, priority: number = 1) {
    this.maxSize = maxSize
    this.ttlMs = ttlMs
    this.priority = priority
  }

  get(key: K): V | undefined {
    const entry = this.cache.get(key)
    if (!entry) return undefined

    if (Date.now() > entry.expiry) {
      this.cache.delete(key)
      return undefined
    }

    // Update access stats
    entry.accessCount++
    entry.lastAccess = Date.now()

    // Move to end (most recently used)
    this.cache.delete(key)
    this.cache.set(key, entry)
    return entry.value
  }

  set(key: K, value: V): void {
    // Check if updating existing key
    const existing = this.cache.get(key)

    // Delete oldest if at capacity
    if (!existing && this.cache.size >= this.maxSize) {
      this.evictOne()
    }

    this.cache.set(key, {
      value,
      expiry: Date.now() + this.ttlMs,
      accessCount: 1,
      lastAccess: Date.now(),
    })
  }

  // Evict least valuable entry (lowest priority, then oldest)
  private evictOne(): void {
    let bestKey: K | null = null
    let bestScore = -Infinity

    for (const [key, entry] of this.cache.entries()) {
      // Score = priority * recency (lower access count = older)
      // Higher score = better candidate for eviction
      const score = entry.accessCount / (Date.now() - entry.lastAccess + 1)
      if (score > bestScore) {
        bestScore = score
        bestKey = key
      }
    }

    if (bestKey) this.cache.delete(bestKey)
  }

  clear(): void {
    this.cache.clear()
  }

  // Invalidate entries matching a pattern
  invalidatePattern(pattern: RegExp): number {
    let count = 0
    for (const key of this.cache.keys()) {
      if (pattern.test(String(key))) {
        this.cache.delete(key)
        count++
      }
    }
    return count
  }

  // Get cache stats
  stats(): { size: number; hitRate: number } {
    return {
      size: this.cache.size,
      hitRate: 0, // Would need tracking
    }
  }
}

// Multilevel cache with memory + optional Redis
class MultilevelCache<K, V> {
  private l1: LRUCache<K, V>
  private l2?: LRUCache<K, V>
  private stats = { hits: 0, misses: 0 }

  constructor(config: CacheConfig, l2Config?: CacheConfig) {
    this.l1 = new LRUCache(config.maxSize, config.ttlMs, config.priority)
    if (l2Config) {
      this.l2 = new LRUCache(l2Config.maxSize, l2Config.ttlMs, l2Config.priority)
    }
  }

  get(key: K): V | undefined {
    // L1 check
    const l1Result = this.l1.get(key)
    if (l1Result !== undefined) {
      this.stats.hits++
      return l1Result
    }

    // L2 check
    if (this.l2) {
      const l2Result = this.l2.get(key)
      if (l2Result !== undefined) {
        this.stats.hits++
        // Promote to L1
        this.l1.set(key, l2Result)
        return l2Result
      }
    }

    this.stats.misses++
    return undefined
  }

  set(key: K, value: V): void {
    this.l1.set(key, value)
    if (this.l2) {
      this.l2.set(key, value)
    }
  }

  invalidate(key: K): void {
    this.l1.invalidatePattern(new RegExp(String(key)))
    this.l2?.invalidatePattern(new RegExp(String(key)))
  }

  getHitRate(): number {
    const total = this.stats.hits + this.stats.misses
    return total > 0 ? this.stats.hits / total : 0
  }
}

// Cache instances for different LSP operations
const hoverCache = new LRUCache<string, unknown>(200, 30_000, 3)
const definitionCache = new LRUCache<string, unknown>(150, 45_000, 4)
const symbolCache = new LRUCache<string, unknown[]>(100, 60_000, 2)
const referencesCache = new LRUCache<string, unknown[]>(80, 30_000, 2)
const implementationCache = new LRUCache<string, unknown[]>(80, 30_000, 2)
const documentSymbolCache = new LRUCache<string, unknown[]>(100, 60_000, 3)
const callHierarchyCache = new LRUCache<string, unknown[]>(50, 30_000, 2)

// Cache invalidation on file change
function invalidateCachesForFile(filePath: string): number {
  let totalInvalidated = 0
  const pattern = new RegExp(filePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))

  totalInvalidated += hoverCache.invalidatePattern(pattern)
  totalInvalidated += definitionCache.invalidatePattern(pattern)
  totalInvalidated += referencesCache.invalidatePattern(pattern)
  totalInvalidated += implementationCache.invalidatePattern(pattern)
  totalInvalidated += documentSymbolCache.invalidatePattern(pattern)
  totalInvalidated += callHierarchyCache.invalidatePattern(pattern)

  // Invalidate symbol cache for queries in the same directory
  totalInvalidated += symbolCache.invalidatePattern(new RegExp(""))

  return totalInvalidated
}

export namespace LSP {
  const log = Log.create({ service: "lsp" })

  // Throttle event publishing
  let lastEventTime = 0
  const EVENT_THROTTLE_MS = 100
  const pendingEvent = { current: false }

  // Request batching for performance
  interface PendingRequest<T> {
    resolve: (value: T) => void
    reject: (error: Error) => void
    timestamp: number
  }

  class RequestBatcher<K, T> {
    private pending = new Map<K, PendingRequest<T>[]>()
    private batchTimeout: NodeJS.Timeout | null = null
    private readonly delayMs: number
    private readonly maxBatchSize: number

    constructor(delayMs: number = 10, maxBatchSize: number = 10) {
      this.delayMs = delayMs
      this.maxBatchSize = maxBatchSize
    }

    async schedule(
      key: K,
      executor: () => Promise<T>,
    ): Promise<T> {
      return new Promise((resolve, reject) => {
        const queue = this.pending.get(key) || []
        queue.push({ resolve, reject, timestamp: Date.now() })
        this.pending.set(key, queue)

        // Process immediately if batch is full
        if (queue.length >= this.maxBatchSize) {
          this.flush(key, executor)
        } else if (!this.batchTimeout) {
          // Schedule batch flush
          this.batchTimeout = setTimeout(() => {
            this.flushAll(executor)
            this.batchTimeout = null
          }, this.delayMs)
        }
      })
    }

    private async flushAll(executor: () => Promise<T>): Promise<void> {
      for (const [key, queue] of this.pending) {
        await this.flush(key, executor)
      }
    }

    private async flush(key: K, executor: () => Promise<T>): Promise<void> {
      const queue = this.pending.get(key)
      if (!queue) return

      this.pending.delete(key)

      if (queue.length === 1) {
        // Single request, execute directly
        try {
          const result = await executor()
          queue[0].resolve(result)
        } catch (error) {
          queue[0].reject(error as Error)
        }
      } else {
        // Batch request, execute once and broadcast result
        try {
          const result = await executor()
          for (const { resolve } of queue) {
            resolve(result)
          }
        } catch (error) {
          for (const { reject } of queue) {
            reject(error as Error)
          }
        }
      }
    }
  }

  // Request deduplication
  class RequestDeduplicator<T> {
    private pending = new Map<string, Promise<T>>()

    async deduplicate<K>(
      key: K,
      executor: () => Promise<T>,
    ): Promise<T> {
      const keyStr = String(key)
      const existing = this.pending.get(keyStr)

      if (existing) {
        return existing as Promise<T>
      }

      const promise = executor()
      this.pending.set(keyStr, promise)

      try {
        return await promise
      } finally {
        this.pending.delete(keyStr)
      }
    }
  }

  // Circuit breaker for LSP operations
  interface CircuitBreakerConfig {
    failureThreshold: number
    successThreshold: number
    timeout: number
  }

  enum CircuitState {
    CLOSED = "closed",
    OPEN = "open",
    HALF_OPEN = "half_open",
  }

  class CircuitBreaker {
    private state = CircuitState.CLOSED
    private failures = 0
    private successes = 0
    private nextAttempt = 0

    constructor(
      private config: CircuitBreakerConfig,
    ) {}

    async execute<T>(operation: () => Promise<T>): Promise<T> {
      if (this.state === CircuitState.OPEN) {
        if (Date.now() < this.nextAttempt) {
          throw new Error("Circuit breaker is OPEN")
        }
        this.state = CircuitState.HALF_OPEN
        this.successes = 0
      }

      try {
        const result = await operation()
        this.onSuccess()
        return result
      } catch (error) {
        this.onFailure()
        throw error
      }
    }

    private onSuccess(): void {
      this.failures = 0
      if (this.state === CircuitState.HALF_OPEN) {
        this.successes++
        if (this.successes >= this.config.successThreshold) {
          this.state = CircuitState.CLOSED
        }
      }
    }

    private onFailure(): void {
      this.failures++
      if (this.state === CircuitState.HALF_OPEN) {
        this.state = CircuitState.OPEN
        this.nextAttempt = Date.now() + this.config.timeout
      } else if (this.failures >= this.config.failureThreshold) {
        this.state = CircuitState.OPEN
        this.nextAttempt = Date.now() + this.config.timeout
      }
    }

    getState(): CircuitState {
      return this.state
    }
  }

  // Retry decorator with exponential backoff
  async function withRetry<T>(
    operation: () => Promise<T>,
    options: {
      maxAttempts?: number
      baseDelayMs?: number
      maxDelayMs?: number
      retryableErrors?: (error: Error) => boolean
    } = {},
  ): Promise<T> {
    const {
      maxAttempts = 3,
      baseDelayMs = 100,
      maxDelayMs = 5000,
      retryableErrors = () => true,
    } = options

    let lastError: Error | undefined

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        return await operation()
      } catch (error) {
        lastError = error as Error

        if (!retryableErrors(lastError) || attempt === maxAttempts) {
          throw lastError
        }

        // Exponential backoff with jitter
        const delay = Math.min(
          baseDelayMs * Math.pow(2, attempt - 1) + Math.random() * baseDelayMs,
          maxDelayMs,
        )

        log.warn("retrying operation", {
          attempt,
          maxAttempts,
          delay,
          error: lastError.message,
        })

        await new Promise((resolve) => setTimeout(resolve, delay))
      }
    }

    throw lastError
  }

  // Circuit breakers for different operations
  const hoverCircuit = new CircuitBreaker({
    failureThreshold: 5,
    successThreshold: 2,
    timeout: 30_000,
  })

  const definitionCircuit = new CircuitBreaker({
    failureThreshold: 5,
    successThreshold: 2,
    timeout: 30_000,
  })

  const symbolCircuit = new CircuitBreaker({
    failureThreshold: 3,
    successThreshold: 2,
    timeout: 60_000,
  })

  const referencesCircuit = new CircuitBreaker({
    failureThreshold: 5,
    successThreshold: 2,
    timeout: 30_000,
  })

  const callHierarchyCircuit = new CircuitBreaker({
    failureThreshold: 3,
    successThreshold: 2,
    timeout: 30_000,
  })

  // Performance monitoring
  interface PerformanceMetrics {
    operation: string
    count: number
    totalDuration: number
    errors: number
    cacheHits: number
    cacheMisses: number
  }

  class MetricsCollector {
    private metrics = new Map<string, PerformanceMetrics>()

    record(operation: string, duration: number, success: boolean, cached: boolean = false): void {
      const existing = this.metrics.get(operation) || {
        operation,
        count: 0,
        totalDuration: 0,
        errors: 0,
        cacheHits: 0,
        cacheMisses: 0,
      }

      existing.count++
      existing.totalDuration += duration
      if (!success) existing.errors++
      if (cached) existing.cacheHits++
      else existing.cacheMisses++

      this.metrics.set(operation, existing)
    }

    get(operation: string): PerformanceMetrics | undefined {
      return this.metrics.get(operation)
    }

    getAll(): PerformanceMetrics[] {
      return Array.from(this.metrics.values())
    }

    getStats(): {
      avgDuration: number
      errorRate: number
      cacheHitRate: number
      p95Duration: number
    } {
      const all = this.getAll()
      if (all.length === 0) {
        return { avgDuration: 0, errorRate: 0, cacheHitRate: 0, p95Duration: 0 }
      }

      const totals = all.reduce(
        (acc, m) => ({
          count: acc.count + m.count,
          duration: acc.duration + m.totalDuration,
          errors: acc.errors + m.errors,
          hits: acc.hits + m.cacheHits,
          misses: acc.misses + m.cacheMisses,
        }),
        { count: 0, duration: 0, errors: 0, hits: 0, misses: 0 },
      )

      return {
        avgDuration: totals.duration / totals.count,
        errorRate: totals.errors / totals.count,
        cacheHitRate: totals.hits / (totals.hits + totals.misses),
        p95Duration: 0, // Would need histogram tracking
      }
    }

    reset(): void {
      this.metrics.clear()
    }
  }

  const metrics = new MetricsCollector()

  // Connection pool management
  interface ConnectionPoolConfig {
    minConnections: number
    maxConnections: number
    idleTimeoutMs: number
    connectionTimeoutMs: number
  }

  class ConnectionPool {
    private available: LSPClient.Info[] = []
    private inUse = new Set<LSPClient.Info>()
    private config: ConnectionPoolConfig
    private warming = false

    constructor(config: ConnectionPoolConfig) {
      this.config = config
    }

    async acquire(client: LSPClient.Info): Promise<LSPClient.Info> {
      // Find available connection for same server
      const available = this.available.find((c) => c.serverID === client.serverID)

      if (available) {
        this.available = this.available.filter((c) => c !== available)
        this.inUse.add(available)
        return available
      }

      // No available, use provided client
      this.inUse.add(client)
      return client
    }

    release(client: LSPClient.Info): void {
      if (!this.inUse.has(client)) return

      this.inUse.delete(client)

      // Keep connection if under max
      if (this.available.length + this.inUse.size < this.config.maxConnections) {
        this.available.push(client)
      } else {
        // Close excess connections
        client.shutdown().catch(() => {})
      }
    }

    async warmup(clients: LSPClient.Info[]): Promise<void> {
      if (this.warming || clients.length === 0) return

      this.warming = true
      try {
        // Pre-warm: send dummy request to establish connection
        const warmupPromises = clients.slice(0, this.config.minConnections).map(async (client) => {
          try {
            // Send a lightweight request to warm up the connection
            await client.connection.sendRequest("window/showMessageRequest", {
              type: 1,
              message: "ping",
              actions: [],
            })
          } catch {
            // Expected to fail, just establishes the connection
          }
        })

        await Promise.allSettled(warmupPromises)
      } finally {
        this.warming = false
      }
    }

    async cleanup(): Promise<void> {
      const now = Date.now()
      const toClose: LSPClient.Info[] = []

      this.available = this.available.filter((client) => {
        // Would need to track last used time - simplified here
        if (this.available.length > this.config.minConnections) {
          toClose.push(client)
          return false
        }
        return true
      })

      await Promise.allSettled(toClose.map((c) => c.shutdown()))
    }

    getStats() {
      return {
        available: this.available.length,
        inUse: this.inUse.size,
        total: this.available.length + this.inUse.size,
      }
    }
  }

  // Global connection pool
  const connectionPool = new ConnectionPool({
    minConnections: 2,
    maxConnections: 10,
    idleTimeoutMs: 60_000,
    connectionTimeoutMs: 10_000,
  })

  // Instantiate batchers and deduplicators
  const hoverBatcher = new RequestBatcher<string, unknown>(10, 5)
  const definitionBatcher = new RequestBatcher<string, unknown>(10, 5)
  const symbolBatcher = new RequestBatcher<string, unknown[]>(20, 10)
  const deduplicator = new RequestDeduplicator<unknown>()

  const publishThrottled = () => {
    const now = Date.now()
    if (now - lastEventTime < EVENT_THROTTLE_MS) {
      if (!pendingEvent.current) {
        pendingEvent.current = true
        setTimeout(() => {
          publishThrottled()
          pendingEvent.current = false
        }, EVENT_THROTTLE_MS - (now - lastEventTime))
      }
      return
    }
    lastEventTime = now
    publishThrottled()
  }

  export const Event = {
    Updated: BusEvent.define("lsp.updated", z.object({})),
    FileChanged: BusEvent.define("lsp.fileChanged", z.object({
      path: z.string(),
    })),
  }

  export const Range = z
    .object({
      start: z.object({
        line: z.number(),
        character: z.number(),
      }),
      end: z.object({
        line: z.number(),
        character: z.number(),
      }),
    })
    .meta({
      ref: "Range",
    })
  export type Range = z.infer<typeof Range>

  export const Symbol = z
    .object({
      name: z.string(),
      kind: z.number(),
      location: z.object({
        uri: z.string(),
        range: Range,
      }),
    })
    .meta({
      ref: "Symbol",
    })
  export type Symbol = z.infer<typeof Symbol>

  export const DocumentSymbol = z
    .object({
      name: z.string(),
      detail: z.string().optional(),
      kind: z.number(),
      range: Range,
      selectionRange: Range,
    })
    .meta({
      ref: "DocumentSymbol",
    })
  export type DocumentSymbol = z.infer<typeof DocumentSymbol>

  const filterExperimentalServers = (servers: Record<string, LSPServer.Info>) => {
    if (Flag.OPENCODE_EXPERIMENTAL_LSP_TY) {
      // If experimental flag is enabled, disable pyright
      if (servers["pyright"]) {
        log.info("LSP server pyright is disabled because OPENCODE_EXPERIMENTAL_LSP_TY is enabled")
        delete servers["pyright"]
      }
    } else {
      // If experimental flag is disabled, disable ty
      if (servers["ty"]) {
        delete servers["ty"]
      }
    }
  }

  const state = Instance.state(
    async () => {
      const clients: LSPClient.Info[] = []
      const servers: Record<string, LSPServer.Info> = {}
      const cfg = await Config.get()

      if (cfg.lsp === false) {
        log.info("all LSPs are disabled")
        return {
          broken: new Set<string>(),
          servers,
          clients,
          spawning: new Map<string, Promise<LSPClient.Info | undefined>>(),
        }
      }

      for (const server of Object.values(LSPServer)) {
        servers[server.id] = server
      }

      filterExperimentalServers(servers)

      for (const [name, item] of Object.entries(cfg.lsp ?? {})) {
        const existing = servers[name]
        if (item.disabled) {
          log.info(`LSP server ${name} is disabled`)
          delete servers[name]
          continue
        }
        servers[name] = {
          ...existing,
          id: name,
          root: existing?.root ?? (async () => Instance.directory),
          extensions: item.extensions ?? existing?.extensions ?? [],
          spawn: async (root) => {
            return {
              process: spawn(item.command[0], item.command.slice(1), {
                cwd: root,
                env: {
                  ...process.env,
                  ...item.env,
                },
              }),
              initialization: item.initialization,
            }
          },
        }
      }

      log.info("enabled LSP servers", {
        serverIds: Object.values(servers)
          .map((server) => server.id)
          .join(", "),
      })

      return {
        broken: new Set<string>(),
        servers,
        clients,
        spawning: new Map<string, Promise<LSPClient.Info | undefined>>(),
      }
    },
    async (state) => {
      await Promise.all(state.clients.map((client) => client.shutdown()))
    },
  )

  export async function init() {
    const s = await state()

    // Subscribe to file change events to invalidate caches
    Bus.subscribe(Event.FileChanged, async (event) => {
      const invalidated = invalidateCachesForFile(event.properties.path)
      if (invalidated > 0) {
        log.info("invalidated caches due to file change", {
          path: event.properties.path,
          count: invalidated,
        })
      }
    })

    return s
  }

  export const Status = z
    .object({
      id: z.string(),
      name: z.string(),
      root: z.string(),
      status: z.union([z.literal("connected"), z.literal("error")]),
    })
    .meta({
      ref: "LSPStatus",
    })
  export type Status = z.infer<typeof Status>

  export async function status() {
    return state().then((x) => {
      const result: Status[] = []
      for (const client of x.clients) {
        result.push({
          id: client.serverID,
          name: x.servers[client.serverID].id,
          root: path.relative(Instance.directory, client.root),
          status: "connected",
        })
      }
      return result
    })
  }

  async function getClients(file: string) {
    const s = await state()
    const extension = path.parse(file).ext || file
    const result: LSPClient.Info[] = []

    async function schedule(server: LSPServer.Info, root: string, key: string) {
      const handle = await server
        .spawn(root)
        .then((value) => {
          if (!value) s.broken.add(key)
          return value
        })
        .catch((err) => {
          s.broken.add(key)
          log.error(`Failed to spawn LSP server ${server.id}`, { error: err })
          return undefined
        })

      if (!handle) return undefined
      log.info("spawned lsp server", { serverID: server.id })

      const client = await LSPClient.create({
        serverID: server.id,
        server: handle,
        root,
      }).catch((err) => {
        s.broken.add(key)
        handle.process.kill()
        log.error(`Failed to initialize LSP client ${server.id}`, { error: err })
        return undefined
      })

      if (!client) {
        handle.process.kill()
        return undefined
      }

      const existing = s.clients.find((x) => x.root === root && x.serverID === server.id)
      if (existing) {
        handle.process.kill()
        return existing
      }

      s.clients.push(client)
      return client
    }

    for (const server of Object.values(s.servers)) {
      if (server.extensions.length && !server.extensions.includes(extension)) continue

      const root = await server.root(file)
      if (!root) continue
      if (s.broken.has(root + server.id)) continue

      const match = s.clients.find((x) => x.root === root && x.serverID === server.id)
      if (match) {
        result.push(match)
        continue
      }

      const inflight = s.spawning.get(root + server.id)
      if (inflight) {
        const client = await inflight
        if (!client) continue
        result.push(client)
        continue
      }

      const task = schedule(server, root, root + server.id)
      s.spawning.set(root + server.id, task)

      task.finally(() => {
        if (s.spawning.get(root + server.id) === task) {
          s.spawning.delete(root + server.id)
        }
      })

      const client = await task
      if (!client) continue

      result.push(client)
      publishThrottled()
    }

    return result
  }

  export async function hasClients(file: string) {
    const s = await state()
    const extension = path.parse(file).ext || file
    for (const server of Object.values(s.servers)) {
      if (server.extensions.length && !server.extensions.includes(extension)) continue
      const root = await server.root(file)
      if (!root) continue
      if (s.broken.has(root + server.id)) continue
      return true
    }
    return false
  }

  export async function touchFile(input: string, waitForDiagnostics?: boolean) {
    log.info("touching file", { file: input })
    const clients = await getClients(input)

    // Clear relevant caches when file is modified
    hoverCache.clear() // Could be more selective but simple for now
    definitionCache.clear()

    await Promise.all(
      clients.map(async (client) => {
        const wait = waitForDiagnostics ? client.waitForDiagnostics({ path: input }) : Promise.resolve()
        await client.notify.open({ path: input })
        return wait
      }),
    ).catch((err) => {
      log.error("failed to touch file", { err, file: input })
    })
  }

  // Debounced diagnostics fetch with caching
  let diagnosticsCache: { data: Record<string, LSPClient.Diagnostic[]>; timestamp: number } | null = null
  const DIAGNOSTICS_CACHE_TTL = 2000 // 2 seconds

  export async function diagnostics(forceRefresh = false): Promise<Record<string, LSPClient.Diagnostic[]>> {
    const now = Date.now()

    // Return cached diagnostics if valid and not forced
    if (!forceRefresh && diagnosticsCache) {
      if (now - diagnosticsCache.timestamp < DIAGNOSTICS_CACHE_TTL) {
        return diagnosticsCache.data
      }
    }

    const results: Record<string, LSPClient.Diagnostic[]> = {}

    // Run in parallel but deduplicate by path
    const allDiagnostics = await runAll(async (client) => client.diagnostics)

    for (const result of allDiagnostics) {
      for (const [path, diagnostics] of result.entries()) {
        const arr = results[path] || []
        arr.push(...diagnostics)
        results[path] = arr
      }
    }

    // Update cache
    diagnosticsCache = { data: results, timestamp: now }

    return results
  }

  export async function hover(input: { file: string; line: number; character: number }): Promise<unknown> {
    const startTime = Date.now()
    // Include project directory in cache key for project isolation
    const projectRoot = Instance.directory
    const relativeFile = path.relative(projectRoot, input.file)
    const cacheKey = `${projectRoot}:${relativeFile}:${input.line}:${input.character}`

    // Check cache first
    const cached = hoverCache.get(cacheKey)
    if (cached !== undefined) {
      metrics.record("hover", Date.now() - startTime, true, true)
      return cached as ReturnType<typeof hover>
    }

    try {
      const result = await withRetry(
        async () => {
          return await hoverCircuit.execute(async () => {
            return await run(input.file, (client) => {
              return withTimeout(
                client.connection
                  .sendRequest("textDocument/hover", {
                    textDocument: {
                      uri: pathToFileURL(input.file).href,
                    },
                    position: {
                      line: input.line,
                      character: input.character,
                    },
                  }),
                10_000, // 10 second timeout
              ).catch(() => null)
            })
          })
        },
        {
          maxAttempts: 3,
          baseDelayMs: 100,
          maxDelayMs: 2000,
          retryableErrors: (error) => {
            // Retry on timeout, connection errors
            const message = error.message.toLowerCase()
            return message.includes("timeout") || message.includes("econn")
          },
        },
      )

      // Cache the result (only cache non-null results)
      if (result && result.length > 0 && result[0] !== null) {
        hoverCache.set(cacheKey, result)
      }

      metrics.record("hover", Date.now() - startTime, true, false)
      return result
    } catch (error) {
      metrics.record("hover", Date.now() - startTime, false, false)
      log.error("hover failed", { error, file: input.file })
      return null
    }
  }

  enum SymbolKind {
    File = 1,
    Module = 2,
    Namespace = 3,
    Package = 4,
    Class = 5,
    Method = 6,
    Property = 7,
    Field = 8,
    Constructor = 9,
    Enum = 10,
    Interface = 11,
    Function = 12,
    Variable = 13,
    Constant = 14,
    String = 15,
    Number = 16,
    Boolean = 17,
    Array = 18,
    Object = 19,
    Key = 20,
    Null = 21,
    EnumMember = 22,
    Struct = 23,
    Event = 24,
    Operator = 25,
    TypeParameter = 26,
  }

  const kinds = [
    SymbolKind.Class,
    SymbolKind.Function,
    SymbolKind.Method,
    SymbolKind.Interface,
    SymbolKind.Variable,
    SymbolKind.Constant,
    SymbolKind.Struct,
    SymbolKind.Enum,
  ]

  export async function workspaceSymbol(query: string): Promise<LSP.Symbol[]> {
    const startTime = Date.now()

    // Skip empty queries to avoid returning all symbols
    if (!query || query.length < 2) {
      return []
    }

    // Include project directory in cache key for project isolation
    const projectRoot = Instance.directory
    const cacheKey = `${projectRoot}:${query}`

    // Check cache first
    const cached = symbolCache.get(cacheKey)
    if (cached !== undefined) {
      metrics.record("workspaceSymbol", Date.now() - startTime, true, true)
      return cached as LSP.Symbol[]
    }

    try {
      const result = await withRetry(
        async () => {
          return await symbolCircuit.execute(async () => {
            return await runAll((client) =>
              withTimeout(
                client.connection
                  .sendRequest("workspace/symbol", {
                    query,
                  })
                  .then((result: any) => result.filter((x: LSP.Symbol) => kinds.includes(x.kind)))
                  .then((result: any) => result.slice(0, 10)),
                15_000, // 15 second timeout for workspace symbol search
              ).catch(() => []),
            )
          })
        },
        {
          maxAttempts: 2,
          baseDelayMs: 100,
          maxDelayMs: 1000,
        },
      )

      const flatResult = (result as unknown[][]).flat() as LSP.Symbol[]

      // Cache the result
      if (flatResult && flatResult.length > 0) {
        symbolCache.set(query, flatResult)
      }

      metrics.record("workspaceSymbol", Date.now() - startTime, true, false)
      return flatResult
    } catch (error) {
      metrics.record("workspaceSymbol", Date.now() - startTime, false, false)
      log.error("workspaceSymbol failed", { error, query })
      return []
    }
  }

  export async function documentSymbol(uri: string): Promise<(LSP.DocumentSymbol | LSP.Symbol)[]> {
    const startTime = Date.now()
    const cacheKey = `doc:${uri}`

    const cached = documentSymbolCache.get(cacheKey)
    if (cached !== undefined) {
      metrics.record("documentSymbol", Date.now() - startTime, true, true)
      return cached as (LSP.DocumentSymbol | LSP.Symbol)[]
    }

    try {
      const result = await withRetry(
        async () => {
          const file = fileURLToPath(uri)
          return await run(file, (client) =>
            withTimeout(
              client.connection
                .sendRequest("textDocument/documentSymbol", {
                  textDocument: {
                    uri,
                  },
                }),
              10_000, // 10 second timeout
            ).catch(() => []),
          )
        },
        {
          maxAttempts: 2,
          baseDelayMs: 100,
          maxDelayMs: 1000,
        },
      )

      const flatResult = (result as unknown[][]).flat().filter(Boolean) as (LSP.DocumentSymbol | LSP.Symbol)[]

      if (flatResult.length > 0) {
        documentSymbolCache.set(cacheKey, flatResult)
      }

      metrics.record("documentSymbol", Date.now() - startTime, true, false)
      return flatResult
    } catch (error) {
      metrics.record("documentSymbol", Date.now() - startTime, false, false)
      return []
    }
  }

  export async function definition(input: { file: string; line: number; character: number }): Promise<unknown[]> {
    const startTime = Date.now()
    // Include project directory in cache key for project isolation
    const projectRoot = Instance.directory
    const relativeFile = path.relative(projectRoot, input.file)
    const cacheKey = `def:${projectRoot}:${relativeFile}:${input.line}:${input.character}`
    const cached = definitionCache.get(cacheKey)
    if (cached !== undefined) {
      metrics.record("definition", Date.now() - startTime, true, true)
      return cached as ReturnType<typeof definition>
    }

    try {
      const result = await withRetry(
        async () => {
          return await definitionCircuit.execute(async () => {
            return await run(input.file, (client) =>
              withTimeout(
                client.connection
                  .sendRequest("textDocument/definition", {
                    textDocument: { uri: pathToFileURL(input.file).href },
                    position: { line: input.line, character: input.character },
                  }),
                10_000, // 10 second timeout
              ).catch(() => null),
            )
          })
        },
        {
          maxAttempts: 3,
          baseDelayMs: 100,
          maxDelayMs: 2000,
        },
      )

      const flatResult = result.flat().filter(Boolean)

      // Cache the result
      if (flatResult && flatResult.length > 0) {
        definitionCache.set(cacheKey, flatResult)
      }

      metrics.record("definition", Date.now() - startTime, true, false)
      return flatResult
    } catch (error) {
      metrics.record("definition", Date.now() - startTime, false, false)
      log.error("definition failed", { error, file: input.file })
      return []
    }
  }

  export async function references(input: { file: string; line: number; character: number }): Promise<unknown[]> {
    const startTime = Date.now()
    const cacheKey = `ref:${input.file}:${input.line}:${input.character}`

    const cached = referencesCache.get(cacheKey)
    if (cached !== undefined) {
      metrics.record("references", Date.now() - startTime, true, true)
      return cached as unknown[]
    }

    try {
      const result = await withRetry(
        async () => {
          return await run(input.file, (client) =>
            withTimeout(
              client.connection
                .sendRequest("textDocument/references", {
                  textDocument: { uri: pathToFileURL(input.file).href },
                  position: { line: input.line, character: input.character },
                  context: { includeDeclaration: true },
                }),
              15_000, // 15 second timeout - references can be slow
            ).catch(() => []),
          )
        },
        {
          maxAttempts: 3,
          baseDelayMs: 100,
          maxDelayMs: 2000,
        },
      )

      const flatResult = (result as unknown[][]).flat().filter(Boolean) as unknown[]

      if (flatResult.length > 0) {
        referencesCache.set(cacheKey, flatResult)
      }

      metrics.record("references", Date.now() - startTime, true, false)
      return flatResult
    } catch (error) {
      metrics.record("references", Date.now() - startTime, false, false)
      return []
    }
  }

  export async function implementation(input: { file: string; line: number; character: number }): Promise<unknown[]> {
    const startTime = Date.now()
    const cacheKey = `impl:${input.file}:${input.line}:${input.character}`

    const cached = implementationCache.get(cacheKey)
    if (cached !== undefined) {
      metrics.record("implementation", Date.now() - startTime, true, true)
      return cached as unknown[]
    }

    try {
      const result = await withRetry(
        async () => {
          return await run(input.file, (client) =>
            withTimeout(
              client.connection
                .sendRequest("textDocument/implementation", {
                  textDocument: { uri: pathToFileURL(input.file).href },
                  position: { line: input.line, character: input.character },
                }),
              10_000, // 10 second timeout
            ).catch(() => null),
          )
        },
        {
          maxAttempts: 3,
          baseDelayMs: 100,
          maxDelayMs: 2000,
        },
      )

      const flatResult = (result as unknown[][]).flat().filter(Boolean) as unknown[]

      if (flatResult.length > 0) {
        implementationCache.set(cacheKey, flatResult)
      }

      metrics.record("implementation", Date.now() - startTime, true, false)
      return flatResult
    } catch (error) {
      metrics.record("implementation", Date.now() - startTime, false, false)
      return []
    }
  }

  export async function prepareCallHierarchy(input: { file: string; line: number; character: number }): Promise<unknown[]> {
    const startTime = Date.now()
    const cacheKey = `callprep:${input.file}:${input.line}:${input.character}`

    const cached = callHierarchyCache.get(cacheKey)
    if (cached !== undefined) {
      metrics.record("prepareCallHierarchy", Date.now() - startTime, true, true)
      return cached as unknown[]
    }

    try {
      const result = await withRetry(
        async () => {
          return await callHierarchyCircuit.execute(async () => {
            return await run(input.file, (client) =>
              withTimeout(
                client.connection
                  .sendRequest("textDocument/prepareCallHierarchy", {
                    textDocument: { uri: pathToFileURL(input.file).href },
                    position: { line: input.line, character: input.character },
                  }),
                10_000, // 10 second timeout
              ).catch(() => []),
            )
          })
        },
        {
          maxAttempts: 2,
          baseDelayMs: 100,
          maxDelayMs: 1000,
        },
      )

      const flatResult = (result as unknown[][]).flat().filter(Boolean) as unknown[]

      if (flatResult.length > 0) {
        callHierarchyCache.set(cacheKey, flatResult)
      }

      metrics.record("prepareCallHierarchy", Date.now() - startTime, true, false)
      return flatResult
    } catch (error) {
      metrics.record("prepareCallHierarchy", Date.now() - startTime, false, false)
      return []
    }
  }

  export async function incomingCalls(input: { file: string; line: number; character: number }): Promise<unknown[]> {
    const startTime = Date.now()
    const cacheKey = `incoming:${input.file}:${input.line}:${input.character}`

    const cached = callHierarchyCache.get(cacheKey)
    if (cached !== undefined) {
      metrics.record("incomingCalls", Date.now() - startTime, true, true)
      return cached as unknown[]
    }

    try {
      const result = await withRetry(
        async () => {
          return await callHierarchyCircuit.execute(async () => {
            return await run(input.file, async (client) => {
              const items = (await withTimeout(
                client.connection
                  .sendRequest("textDocument/prepareCallHierarchy", {
                    textDocument: { uri: pathToFileURL(input.file).href },
                    position: { line: input.line, character: input.character },
                  }),
                10_000, // 10 second timeout
              ).catch(() => [])) as unknown[]
              if (!items?.length) return []
              return withTimeout(
                client.connection.sendRequest("callHierarchy/incomingCalls", { item: items[0] }),
                15_000, // 15 second timeout for incoming calls
              ).catch(() => [])
            })
          })
        },
        {
          maxAttempts: 2,
          baseDelayMs: 100,
          maxDelayMs: 1000,
        },
      )

      const flatResult = (result as unknown[][]).flat().filter(Boolean) as unknown[]

      if (flatResult.length > 0) {
        callHierarchyCache.set(cacheKey, flatResult)
      }

      metrics.record("incomingCalls", Date.now() - startTime, true, false)
      return flatResult
    } catch (error) {
      metrics.record("incomingCalls", Date.now() - startTime, false, false)
      return []
    }
  }

  export async function outgoingCalls(input: { file: string; line: number; character: number }): Promise<unknown[]> {
    const startTime = Date.now()
    const cacheKey = `outgoing:${input.file}:${input.line}:${input.character}`

    const cached = callHierarchyCache.get(cacheKey)
    if (cached !== undefined) {
      metrics.record("outgoingCalls", Date.now() - startTime, true, true)
      return cached as unknown[]
    }

    try {
      const result = await withRetry(
        async () => {
          return await callHierarchyCircuit.execute(async () => {
            return await run(input.file, async (client) => {
              const items = (await withTimeout(
                client.connection
                  .sendRequest("textDocument/prepareCallHierarchy", {
                    textDocument: { uri: pathToFileURL(input.file).href },
                    position: { line: input.line, character: input.character },
                  }),
                10_000, // 10 second timeout
              ).catch(() => [])) as unknown[]
              if (!items?.length) return []
              return withTimeout(
                client.connection.sendRequest("callHierarchy/outgoingCalls", { item: items[0] }),
                15_000, // 15 second timeout for outgoing calls
              ).catch(() => [])
            })
          })
        },
        {
          maxAttempts: 2,
          baseDelayMs: 100,
          maxDelayMs: 1000,
        },
      )

      const flatResult = (result as unknown[][]).flat().filter(Boolean) as unknown[]

      if (flatResult.length > 0) {
        callHierarchyCache.set(cacheKey, flatResult)
      }

      metrics.record("outgoingCalls", Date.now() - startTime, true, false)
      return flatResult
    } catch (error) {
      metrics.record("outgoingCalls", Date.now() - startTime, false, false)
      return []
    }
  }

  async function runAll<T>(input: (client: LSPClient.Info) => Promise<T>): Promise<T[]> {
    const clients = await state().then((x) => x.clients)
    const tasks = clients.map((x) => input(x))
    return Promise.all(tasks)
  }

  async function run<T>(file: string, input: (client: LSPClient.Info) => Promise<T>): Promise<T[]> {
    const clients = await getClients(file)
    const tasks = clients.map((x) => input(x))
    return Promise.all(tasks)
  }

  export const Diagnostic = {
    pretty(diagnostic: LSPClient.Diagnostic) {
      const severityMap = {
        1: "ERROR",
        2: "WARN",
        3: "INFO",
        4: "HINT",
      }

      const severity = severityMap[diagnostic.severity || 1]
      const line = diagnostic.range.start.line + 1
      const col = diagnostic.range.start.character + 1

      return `${severity} [${line}:${col}] ${diagnostic.message}`
    },
  }

  // Export metrics for external monitoring
  export const Monitoring = {
    getMetrics: () => metrics.getAll(),
    getStats: () => metrics.getStats(),
    resetMetrics: () => metrics.reset(),
    getCircuitState: (operation: string): string => {
      switch (operation) {
        case "hover": return hoverCircuit.getState()
        case "definition": return definitionCircuit.getState()
        case "workspaceSymbol": return symbolCircuit.getState()
        case "references": return referencesCircuit.getState()
        case "callHierarchy": return callHierarchyCircuit.getState()
        default: return CircuitState.CLOSED
      }
    },
    getConnectionPoolStats: () => connectionPool.getStats(),
    getCacheStats: () => ({
      hover: hoverCache.stats(),
      definition: definitionCache.stats(),
      symbol: symbolCache.stats(),
      references: referencesCache.stats(),
      implementation: implementationCache.stats(),
      documentSymbol: documentSymbolCache.stats(),
      callHierarchy: callHierarchyCache.stats(),
    }),
  }
}
