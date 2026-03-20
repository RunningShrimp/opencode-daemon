import { installAndLoad } from "./module-loader"

export interface SochDBModule {
  Database: any
  VectorIndex?: any
  GraphOverlay?: any
}

let sochModulePromise: Promise<SochDBModule> | undefined

const SOCHDB_TUI_NOISE = [/\[SochDB\]/i, /Native HNSW bindings loaded/i, /Concurrent mode functions loaded successfully/i]

function shouldSuppressSochDBChunk(chunk: unknown) {
  const text = typeof chunk === "string" ? chunk : Buffer.isBuffer(chunk) ? chunk.toString("utf-8") : String(chunk)
  return SOCHDB_TUI_NOISE.some((pattern) => pattern.test(text))
}

async function withSuppressedSochDBOutput<T>(action: () => Promise<T>): Promise<T> {
  const stdoutWrite = process.stdout.write.bind(process.stdout)
  const stderrWrite = process.stderr.write.bind(process.stderr)

  process.stdout.write = ((chunk: any, ...args: any[]) => {
    if (shouldSuppressSochDBChunk(chunk)) return true
    return (stdoutWrite as any)(chunk, ...args)
  }) as typeof process.stdout.write

  process.stderr.write = ((chunk: any, ...args: any[]) => {
    if (shouldSuppressSochDBChunk(chunk)) return true
    return (stderrWrite as any)(chunk, ...args)
  }) as typeof process.stderr.write

  try {
    return await action()
  } finally {
    process.stdout.write = stdoutWrite as typeof process.stdout.write
    process.stderr.write = stderrWrite as typeof process.stderr.write
  }
}

export async function loadSochDBModule(): Promise<SochDBModule> {
  if (!sochModulePromise) {
    sochModulePromise = withSuppressedSochDBOutput(async () => installAndLoad<SochDBModule>("@sochdb/sochdb")).catch(
      (error) => {
        sochModulePromise = undefined
        throw error
      },
    )
  }

  return sochModulePromise
}

export async function openSochDatabase(dbPath: string): Promise<any> {
  const mod = await loadSochDBModule()
  if (!mod.Database) {
    throw new Error("@sochdb/sochdb does not export Database")
  }

  if (typeof mod.Database.open === "function") {
    return await Promise.resolve(mod.Database.open(dbPath))
  }

  return new mod.Database(dbPath)
}

function encodeStoredValue(value: string): Uint8Array {
  return Buffer.from(value, "utf-8")
}

function encodeStoredKey(key: string): Uint8Array {
  return Buffer.from(key, "utf-8")
}

function decodeStoredValue(value: unknown): string | undefined {
  if (value === null || value === undefined) return undefined
  if (typeof value === "string") return value
  if (typeof Buffer !== "undefined" && Buffer.isBuffer(value)) return value.toString("utf-8")
  if (value instanceof Uint8Array) return Buffer.from(value).toString("utf-8")
  if (typeof value === "object" && value && "value" in value) {
    return decodeStoredValue((value as { value: unknown }).value)
  }
  if (typeof value === "object" && value && "data" in value) {
    return decodeStoredValue((value as { data: unknown }).data)
  }
  if (typeof value === "object" && value && "toString" in value) {
    return String(value)
  }
  return undefined
}

export async function sochGet(db: any, key: string): Promise<string | undefined> {
  const value = await Promise.resolve(db.get(encodeStoredKey(key)))
  return decodeStoredValue(value)
}

export async function sochPut(db: any, key: string, value: string): Promise<void> {
  await Promise.resolve(db.put(encodeStoredKey(key), encodeStoredValue(value)))
}

export async function sochDelete(db: any, key: string): Promise<void> {
  await Promise.resolve(db.delete(encodeStoredKey(key)))
}

export async function sochGetJson<T>(db: any, key: string): Promise<T | undefined> {
  const raw = await sochGet(db, key)
  if (!raw) return undefined
  return JSON.parse(raw) as T
}

export async function sochPutJson(db: any, key: string, value: unknown): Promise<void> {
  await sochPut(db, key, JSON.stringify(value))
}

export async function withSochTransaction<T>(db: any, action: (txn: any) => Promise<T>): Promise<T> {
  if (typeof db.withTransaction === "function") {
    return db.withTransaction(action)
  }

  const txn = await Promise.resolve(db.beginTransaction())
  try {
    const result = await action(txn)
    if (typeof txn.commit === "function") {
      await Promise.resolve(txn.commit())
    }
    return result
  } catch (error) {
    if (typeof txn.abort === "function") {
      await Promise.resolve(txn.abort())
    } else if (typeof txn.rollback === "function") {
      await Promise.resolve(txn.rollback())
    }
    throw error
  }
}