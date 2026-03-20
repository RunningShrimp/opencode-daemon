import fs from "node:fs/promises"
import path from "node:path"
import { randomUUID } from "node:crypto"
import { existsSync } from "node:fs"
import { Global } from "@/global"
import {
  parseArtifactEnsureRequest,
  type ArtifactEnsureRequest,
  type ArtifactEnsureResult,
} from "@/daemon/ai-runtime/ai-runtime-protocol"
import {
  DefaultSharedArtifactCoordinator,
  type SharedArtifactCoordinator,
} from "@/daemon/ai-runtime/shared-artifact-coordinator"

interface RegistryDocument {
  version: 1
  entries: SharedArtifactDescriptor[]
}

export interface SharedArtifactDescriptor {
  artifactID: string
  key: string
  kind: ArtifactEnsureRequest["kind"]
  name: string
  version?: string
  platform?: string
  path: string
  refCount: number
  createdAt: number
  lastEnsuredAt: number
}

export interface SharedArtifactRegistryOptions {
  coordinator?: SharedArtifactCoordinator
  now?: () => number
  pathExists?: (artifactPath: string) => boolean
}

function registryPath(rootDir = Global.Path.state) {
  return path.join(rootDir, "daemon", "shared-artifact-registry.json")
}

function artifactKey(request: ArtifactEnsureRequest): string {
  const version = request.version?.trim() || "latest"
  const platform = request.platform?.trim() || "any"
  return `${request.kind}:${request.name}:${version}:${platform}`
}

function parseEntry(input: unknown): SharedArtifactDescriptor | undefined {
  if (!input || typeof input !== "object") return undefined

  const value = input as Partial<SharedArtifactDescriptor>
  if (typeof value.artifactID !== "string") return undefined
  if (typeof value.key !== "string") return undefined
  if (typeof value.kind !== "string") return undefined
  if (typeof value.name !== "string") return undefined
  if (typeof value.path !== "string") return undefined
  if (typeof value.refCount !== "number") return undefined
  if (typeof value.createdAt !== "number") return undefined
  if (typeof value.lastEnsuredAt !== "number") return undefined

  return {
    artifactID: value.artifactID,
    key: value.key,
    kind: value.kind as SharedArtifactDescriptor["kind"],
    name: value.name,
    version: typeof value.version === "string" ? value.version : undefined,
    platform: typeof value.platform === "string" ? value.platform : undefined,
    path: value.path,
    refCount: Math.max(0, Math.floor(value.refCount)),
    createdAt: Math.floor(value.createdAt),
    lastEnsuredAt: Math.floor(value.lastEnsuredAt),
  }
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
      entries: parsed.entries
        .map((entry) => parseEntry(entry))
        .filter((entry): entry is SharedArtifactDescriptor => Boolean(entry)),
    }
  } catch {
    return {
      version: 1,
      entries: [],
    }
  }
}

async function writeRegistry(filePath: string, document: RegistryDocument): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(tempPath, JSON.stringify(document, null, 2), { mode: 0o600 })
  await fs.rename(tempPath, filePath)
}

export class SharedArtifactRegistry {
  private readonly coordinator: SharedArtifactCoordinator
  private readonly now: () => number
  private readonly pathExists: (artifactPath: string) => boolean
  private writeQueue = Promise.resolve<void>(undefined)

  constructor(
    private readonly filePath = registryPath(),
    options: SharedArtifactRegistryOptions = {},
  ) {
    this.coordinator = options.coordinator ?? new DefaultSharedArtifactCoordinator()
    this.now = options.now ?? (() => Date.now())
    this.pathExists = options.pathExists ?? existsSync
  }

  private runSerialized<T>(operation: () => Promise<T>): Promise<T> {
    const next = this.writeQueue.then(operation, operation)
    this.writeQueue = next.then(() => undefined, () => undefined)
    return next
  }

  async ensure(input: unknown): Promise<ArtifactEnsureResult> {
    const request = parseArtifactEnsureRequest(input)
    return this.runSerialized(async () => {
      const key = artifactKey(request)
      const document = await readRegistry(this.filePath)
      const existing = document.entries.find((entry) => entry.key === key)
      const currentTime = this.now()

      if (existing && this.pathExists(existing.path)) {
        const updated: SharedArtifactDescriptor = {
          ...existing,
          refCount: existing.refCount + 1,
          lastEnsuredAt: currentTime,
        }
        document.entries = document.entries.map((entry) => (entry.key === key ? updated : entry))
        await writeRegistry(this.filePath, document)

        return {
          path: updated.path,
          cacheHit: true,
        }
      }

      const resolved = await this.coordinator.ensure(request)

      const descriptor: SharedArtifactDescriptor = existing
        ? {
            ...existing,
            path: resolved.path,
            refCount: Math.max(1, existing.refCount + 1),
            lastEnsuredAt: currentTime,
          }
        : {
            artifactID: `artifact.${randomUUID().replace(/-/g, "")}`,
            key,
            kind: request.kind,
            name: request.name,
            version: request.version,
            platform: request.platform,
            path: resolved.path,
            refCount: 1,
            createdAt: currentTime,
            lastEnsuredAt: currentTime,
          }

      if (existing) {
        document.entries = document.entries.map((entry) => (entry.key === key ? descriptor : entry))
      } else {
        document.entries.push(descriptor)
      }

      await writeRegistry(this.filePath, document)
      return {
        path: descriptor.path,
        cacheHit: existing ? true : resolved.cacheHit,
      }
    })
  }

  async release(input: unknown): Promise<SharedArtifactDescriptor | undefined> {
    const request = parseArtifactEnsureRequest(input)
    return this.runSerialized(async () => {
      const key = artifactKey(request)
      const document = await readRegistry(this.filePath)
      const existing = document.entries.find((entry) => entry.key === key)
      if (!existing) return undefined

      const updated: SharedArtifactDescriptor = {
        ...existing,
        refCount: Math.max(0, existing.refCount - 1),
        lastEnsuredAt: this.now(),
      }

      document.entries = document.entries.map((entry) => (entry.key === key ? updated : entry))
      await writeRegistry(this.filePath, document)
      return updated
    })
  }

  async get(input: unknown): Promise<SharedArtifactDescriptor | undefined> {
    const request = parseArtifactEnsureRequest(input)
    const key = artifactKey(request)
    const document = await readRegistry(this.filePath)
    return document.entries.find((entry) => entry.key === key)
  }

  async list(): Promise<SharedArtifactDescriptor[]> {
    return (await readRegistry(this.filePath)).entries
  }
}
