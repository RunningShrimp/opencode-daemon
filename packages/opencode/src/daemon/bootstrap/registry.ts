import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "@/global"
import type { FencingEpoch } from "@/daemon/protocol/fencing-epoch"

export interface MasterRegistryEntry {
  namespaceID: string
  endpoint: string
  pid: number
  epoch: FencingEpoch
  startedAt: number
  updatedAt: number
}

interface RegistryDocument {
  version: 1
  entries: MasterRegistryEntry[]
}

function registryPath(rootDir = Global.Path.state) {
  return path.join(rootDir, "daemon", "master-registry.json")
}

async function readRegistry(filePath: string): Promise<RegistryDocument> {
  const raw = await fs.readFile(filePath, "utf8").catch(() => undefined)
  if (!raw) {
    return {
      version: 1,
      entries: [],
    }
  }

  const parsed = JSON.parse(raw) as RegistryDocument
  if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
    return {
      version: 1,
      entries: [],
    }
  }
  return parsed
}

async function writeRegistry(filePath: string, document: RegistryDocument) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(tempPath, JSON.stringify(document, null, 2), { mode: 0o600 })
  await fs.rename(tempPath, filePath)
}

function dedupeEntries(entries: MasterRegistryEntry[]) {
  const map = new Map<string, MasterRegistryEntry>()
  for (const entry of entries) {
    const key = `${entry.namespaceID}:${entry.pid}`
    const existing = map.get(key)
    if (!existing || existing.updatedAt < entry.updatedAt) {
      map.set(key, entry)
    }
  }
  return [...map.values()]
}

export class ServerRegistryStore {
  constructor(private readonly filePath = registryPath()) {}

  async upsert(entry: MasterRegistryEntry) {
    const document = await readRegistry(this.filePath)
    document.entries = dedupeEntries([
      ...document.entries.filter((item) => !(item.namespaceID === entry.namespaceID && item.pid === entry.pid)),
      entry,
    ])
    await writeRegistry(this.filePath, document)
  }

  async remove(namespaceID: string, pid: number) {
    const document = await readRegistry(this.filePath)
    document.entries = document.entries.filter((entry) => !(entry.namespaceID === namespaceID && entry.pid === pid))
    await writeRegistry(this.filePath, document)
  }

  async list(namespaceID?: string) {
    const document = await readRegistry(this.filePath)
    const entries = namespaceID
      ? document.entries.filter((entry) => entry.namespaceID === namespaceID)
      : [...document.entries]
    return entries.sort((a, b) => b.updatedAt - a.updatedAt)
  }

  async prune(predicate: (entry: MasterRegistryEntry) => boolean | Promise<boolean>) {
    const document = await readRegistry(this.filePath)
    const next: MasterRegistryEntry[] = []

    for (const entry of document.entries) {
      const drop = await predicate(entry)
      if (!drop) next.push(entry)
    }

    document.entries = next
    await writeRegistry(this.filePath, document)
  }

  async touch(namespaceID: string, pid: number, updatedAt = Date.now()) {
    const document = await readRegistry(this.filePath)
    document.entries = document.entries.map((entry) =>
      entry.namespaceID === namespaceID && entry.pid === pid
        ? {
            ...entry,
            updatedAt,
          }
        : entry,
    )
    await writeRegistry(this.filePath, document)
  }
}
