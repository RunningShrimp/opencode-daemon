import { Database as BunDatabase } from "bun:sqlite"
import { drizzle, type SQLiteBunDatabase } from "drizzle-orm/bun-sqlite"
import { migrate } from "drizzle-orm/bun-sqlite/migrator"
import { type SQLiteTransaction } from "drizzle-orm/sqlite-core"
export * from "drizzle-orm"
import { Context } from "../util/context"
import { lazy } from "../util/lazy"
import { Global } from "../global"
import { Log } from "../util/log"
import { NamedError } from "@opencode-ai/util/error"
import z from "zod"
import path from "path"
import * as schema from "./schema"
import { Installation } from "../installation"
import { Flag } from "../flag/flag"
import { iife } from "@/util/iife"
import { clearCache, getCache, getOrSet } from "@/util/cache"
import { assertBundledMigrations, loadMigrationJournal } from "./migration-manifest"

declare const OPENCODE_MIGRATIONS: { sql: string; timestamp: number; name: string }[] | undefined

export const NotFoundError = NamedError.create(
  "NotFoundError",
  z.object({
    message: z.string(),
  }),
)

const log = Log.create({ service: "db" })
const STRUCTURED_NAMESPACE_KEY_PREFIX = "__structured_namespace__:"
const STRUCTURED_NAMESPACE_TTL = 365 * 24 * 60 * 60 * 1000
const structuredNamespaceVersions = new Map<string, number>()

export namespace Database {
  export const Path = iife(() => {
    const channel = Installation.CHANNEL
    if (["latest", "beta"].includes(channel) || Flag.OPENCODE_DISABLE_CHANNEL_DB)
      return path.join(Global.Path.data, "opencode.db")
    const safe = channel.replace(/[^a-zA-Z0-9._-]/g, "-")
    return path.join(Global.Path.data, `opencode-${safe}.db`)
  })

  type Schema = typeof schema
  export type Transaction = SQLiteTransaction<"sync", void, Schema>

  type Client = SQLiteBunDatabase

  type Journal = { sql: string; timestamp: number; name: string }[]

  const state = {
    sqlite: undefined as BunDatabase | undefined,
  }

  export const Client = lazy(() => {
    log.info("opening database", { path: Path })

    const sqlite = new BunDatabase(Path, { create: true })
    state.sqlite = sqlite

    sqlite.run("PRAGMA journal_mode = WAL")
    sqlite.run("PRAGMA synchronous = NORMAL")
    sqlite.run("PRAGMA busy_timeout = 5000")
    sqlite.run("PRAGMA cache_size = -64000")
    sqlite.run("PRAGMA foreign_keys = ON")
    sqlite.run("PRAGMA wal_checkpoint(PASSIVE)")

    const db = drizzle({ client: sqlite })

    // Apply schema migrations
    const entries =
      typeof OPENCODE_MIGRATIONS !== "undefined"
        ? assertBundledMigrations(OPENCODE_MIGRATIONS)
        : (loadMigrationJournal(path.join(import.meta.dirname, "../../migration")) as Journal)
    if (entries.length > 0) {
      log.info("applying migrations", {
        count: entries.length,
        mode: typeof OPENCODE_MIGRATIONS !== "undefined" ? "bundled" : "dev",
      })
      if (Flag.OPENCODE_SKIP_MIGRATIONS) {
        for (const item of entries) {
          item.sql = "select 1;"
        }
      }
      migrate(db, entries)
    }

    return db
  })

  export function close() {
    const sqlite = state.sqlite
    if (!sqlite) return
    sqlite.close()
    state.sqlite = undefined
    Client.reset()
    structuredNamespaceVersions.clear()
    void clearStructuredCache()
  }

  export type TxOrDb = SQLiteTransaction<"sync", void, any, any> | Client

  const ctx = Context.create<{
    tx: TxOrDb
    effects: (() => void | Promise<void>)[]
  }>("database")

  export function use<T>(callback: (trx: TxOrDb) => T): T {
    try {
      return callback(ctx.use().tx)
    } catch (err) {
      if (err instanceof Context.NotFound) {
        const effects: (() => void | Promise<void>)[] = []
        const result = ctx.provide({ effects, tx: Client() }, () => callback(Client()))
        for (const effect of effects) effect()
        return result
      }
      throw err
    }
  }

  export function effect(fn: () => any | Promise<any>) {
    try {
      ctx.use().effects.push(fn)
    } catch {
      fn()
    }
  }

  export function transaction<T>(callback: (tx: TxOrDb) => T): T {
    try {
      return callback(ctx.use().tx)
    } catch (err) {
      if (err instanceof Context.NotFound) {
        const effects: (() => void | Promise<void>)[] = []
        const result = (Client().transaction as any)((tx: TxOrDb) => {
          return ctx.provide({ tx, effects }, () => callback(tx))
        })
        for (const effect of effects) effect()
        return result
      }
      throw err
    }
  }

  export async function cached<T>(
    key: string,
    factory: () => T | Promise<T>,
    options?: { ttl?: number; namespace?: string },
  ): Promise<T> {
    const namespace = options?.namespace ?? inferStructuredNamespace(key)
    const version = await getStructuredNamespaceVersion(namespace)
    return getOrSet(
      "structured",
      structuredNamespacedKey(namespace, version, key),
      async () => {
        return await factory()
      },
      options,
    )
  }

  export function cachedSync<T>(key: string, factory: () => T, options?: { ttl?: number; namespace?: string }): T {
    const cache = getCache("structured")
    const namespace = options?.namespace ?? inferStructuredNamespace(key)
    const version = getStructuredNamespaceVersionSync(namespace)
    const resolvedKey = structuredNamespacedKey(namespace, version, key)
    const cached = cache.getMemory(resolvedKey) as T | undefined
    if (cached !== undefined) {
      return cached
    }

    const value = factory()
    cache.setMemory(resolvedKey, value, options?.ttl)
    return value
  }

  export async function clearStructuredNamespace(namespace: string | string[]) {
    const namespaces = Array.isArray(namespace) ? namespace : [namespace]
    const cache = getCache("structured")
    for (const item of namespaces) {
      const current = await getStructuredNamespaceVersion(item)
      const next = current + 1
      structuredNamespaceVersions.set(item, next)
      await cache.set(structuredNamespaceMetaKey(item), next, { ttl: STRUCTURED_NAMESPACE_TTL })
    }
  }

  export async function clearStructuredCache() {
    structuredNamespaceVersions.clear()
    await clearCache("structured")
  }

  async function getStructuredNamespaceVersion(namespace: string) {
    const cached = structuredNamespaceVersions.get(namespace)
    if (cached !== undefined) {
      return cached
    }

    const value = (await getCache("structured").get(structuredNamespaceMetaKey(namespace))) as number | undefined
    const version = typeof value === "number" && Number.isFinite(value) ? value : 0
    structuredNamespaceVersions.set(namespace, version)
    return version
  }

  function getStructuredNamespaceVersionSync(namespace: string) {
    return structuredNamespaceVersions.get(namespace) ?? 0
  }

  function structuredNamespaceMetaKey(namespace: string) {
    return `${STRUCTURED_NAMESPACE_KEY_PREFIX}${namespace}`
  }

  function structuredNamespacedKey(namespace: string, version: number, key: string) {
    return `${namespace}:v${version}:${key}`
  }

  function inferStructuredNamespace(key: string) {
    const index = key.indexOf(":")
    if (index === -1) return "structured"
    return key.slice(0, index) || "structured"
  }
}
