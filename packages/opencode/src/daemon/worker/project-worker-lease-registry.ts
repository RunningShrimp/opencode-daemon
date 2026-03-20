import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "@/global"
import type { ProjectRuntimeKey } from "@/daemon/identity/runtime-key"
import { parseProjectRuntimeKey } from "@/daemon/identity/runtime-key"
import type { ProjectWorkerDescriptor } from "./worker-descriptor"
import { parseProjectWorkerDescriptor } from "./worker-descriptor"

interface RegistryDocument {
  version: 1
  entries: ProjectWorkerDescriptor[]
}

function registryPath(rootDir = Global.Path.state) {
  return path.join(rootDir, "daemon", "project-worker-registry.json")
}

async function readRegistry(filePath: string): Promise<RegistryDocument> {
  const raw = await fs.readFile(filePath, "utf8").catch(() => undefined)
  if (!raw) {
    return {
      version: 1,
      entries: [],
    }
  }

  try {
    const parsed = JSON.parse(raw) as RegistryDocument
    if (parsed.version !== 1 || !Array.isArray(parsed.entries)) {
      return {
        version: 1,
        entries: [],
      }
    }

    return {
      version: 1,
      entries: parsed.entries.map((entry) => parseProjectWorkerDescriptor(entry)),
    }
  } catch {
    return {
      version: 1,
      entries: [],
    }
  }
}

async function writeRegistry(filePath: string, document: RegistryDocument) {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(tempPath, JSON.stringify(document, null, 2), { mode: 0o600 })
  await fs.rename(tempPath, filePath)
}

function sortEntries(entries: ProjectWorkerDescriptor[]) {
  return [...entries].sort((left, right) => {
    const leftScore = left.lastActiveAt ?? left.startedAt ?? 0
    const rightScore = right.lastActiveAt ?? right.startedAt ?? 0
    return rightScore - leftScore
  })
}

export class ProjectWorkerLeaseRegistry {
  constructor(private readonly filePath = registryPath()) {}

  async get(runtimeKey: ProjectRuntimeKey): Promise<ProjectWorkerDescriptor | undefined> {
    const normalized = parseProjectRuntimeKey(runtimeKey)
    const document = await readRegistry(this.filePath)
    return document.entries.find((entry) => entry.runtime.runtimeKey === normalized)
  }

  async put(worker: ProjectWorkerDescriptor): Promise<void> {
    const normalized = parseProjectWorkerDescriptor(worker)
    const document = await readRegistry(this.filePath)
    const key = normalized.runtime.runtimeKey
    document.entries = sortEntries([
      ...document.entries.filter((entry) => entry.runtime.runtimeKey !== key),
      normalized,
    ])
    await writeRegistry(this.filePath, document)
  }

  async delete(runtimeKey: ProjectRuntimeKey): Promise<void> {
    const normalized = parseProjectRuntimeKey(runtimeKey)
    const document = await readRegistry(this.filePath)
    document.entries = document.entries.filter((entry) => entry.runtime.runtimeKey !== normalized)
    await writeRegistry(this.filePath, document)
  }

  async list(): Promise<ProjectWorkerDescriptor[]> {
    const document = await readRegistry(this.filePath)
    return sortEntries(document.entries)
  }
}
