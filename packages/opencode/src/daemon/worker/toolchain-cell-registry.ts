import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "@/global"
import { LaneID, ToolchainCellID, WorkerID } from "@/daemon/identity/ids"
import type { ProjectRuntimeKey } from "@/daemon/identity/runtime-key"
import { parseProjectRuntimeKey } from "@/daemon/identity/runtime-key"
import type { ToolchainCellDescriptor } from "@/daemon/worker/toolchain-cell-descriptor"
import { parseToolchainCellDescriptor } from "@/daemon/worker/toolchain-cell-descriptor"
import type { ToolchainRuntimeProfile, ToolchainRuntimeProfileInput } from "@/daemon/worker/toolchain-profile"
import { normalizeToolchainRuntimeProfile } from "@/daemon/worker/toolchain-profile"

interface RegistryDocument {
  version: 1
  entries: ToolchainCellDescriptor[]
}

export interface EnsureToolchainCellInput {
  workerID: string
  runtimeKey: ProjectRuntimeKey
  profile: ToolchainRuntimeProfileInput
  laneID?: string
}

export interface UpdateToolchainCellStateInput {
  cellID: string
  reason: string
}

function registryPath(rootDir = Global.Path.state) {
  return path.join(rootDir, "daemon", "toolchain-cell-registry.json")
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
      entries: parsed.entries.map((entry) => parseToolchainCellDescriptor(entry)),
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

function laneBindings(existing: ToolchainCellDescriptor, laneID?: string): string[] {
  if (!laneID) return existing.boundLaneIDs
  const lane = LaneID.make(laneID)
  if (existing.boundLaneIDs.includes(lane)) return existing.boundLaneIDs
  return [...existing.boundLaneIDs, lane]
}

function sameProfile(left: ToolchainRuntimeProfile, right: ToolchainRuntimeProfile): boolean {
  return (
    left.language === right.language &&
    left.runtime === right.runtime &&
    left.version === right.version &&
    left.formatter === right.formatter &&
    left.envFingerprint === right.envFingerprint
  )
}

export class ToolchainCellRegistry {
  constructor(
    private readonly filePath = registryPath(),
    private readonly now: () => number = () => Date.now(),
  ) {}

  async ensure(input: EnsureToolchainCellInput): Promise<ToolchainCellDescriptor> {
    const workerID = WorkerID.make(input.workerID)
    const runtimeKey = parseProjectRuntimeKey(input.runtimeKey)
    const profile = normalizeToolchainRuntimeProfile(input.profile)
    const document = await readRegistry(this.filePath)
    const currentTime = this.now()

    const existing = document.entries.find((entry) => {
      if (entry.workerID !== workerID) return false
      if (entry.runtimeKey !== runtimeKey) return false
      if (!sameProfile(entry.profile, profile)) return false
      return entry.state === "active" || entry.state === "suspended"
    })

    if (existing) {
      const next: ToolchainCellDescriptor = {
        ...existing,
        profile,
        state: "active",
        lastUsedAt: currentTime,
        suspendedAt: undefined,
        stateReason: undefined,
        boundLaneIDs: laneBindings(existing, input.laneID),
      }
      document.entries = document.entries.map((entry) => (entry.cellID === existing.cellID ? next : entry))
      await writeRegistry(this.filePath, document)
      return next
    }

    const created: ToolchainCellDescriptor = {
      cellID: ToolchainCellID.random(),
      workerID,
      runtimeKey,
      profile,
      state: "active",
      createdAt: currentTime,
      lastUsedAt: currentTime,
      boundLaneIDs: input.laneID ? [LaneID.make(input.laneID)] : [],
    }

    document.entries.push(created)
    await writeRegistry(this.filePath, document)
    return created
  }

  async suspend(input: UpdateToolchainCellStateInput): Promise<ToolchainCellDescriptor | undefined> {
    const cellID = ToolchainCellID.make(input.cellID)
    const reason = input.reason.trim()
    if (!reason) throw new Error("suspend reason is required")

    const document = await readRegistry(this.filePath)
    const existing = document.entries.find((entry) => entry.cellID === cellID)
    if (!existing) return undefined

    const currentTime = this.now()
    const suspended: ToolchainCellDescriptor = {
      ...existing,
      state: "suspended",
      suspendedAt: currentTime,
      lastUsedAt: currentTime,
      stateReason: reason,
    }

    document.entries = document.entries.map((entry) => (entry.cellID === cellID ? suspended : entry))
    await writeRegistry(this.filePath, document)
    return suspended
  }

  async recycle(input: UpdateToolchainCellStateInput): Promise<ToolchainCellDescriptor | undefined> {
    const cellID = ToolchainCellID.make(input.cellID)
    const reason = input.reason.trim()
    if (!reason) throw new Error("recycle reason is required")

    const document = await readRegistry(this.filePath)
    const existing = document.entries.find((entry) => entry.cellID === cellID)
    if (!existing) return undefined

    const currentTime = this.now()
    const recycled: ToolchainCellDescriptor = {
      ...existing,
      state: "recycled",
      recycledAt: currentTime,
      lastUsedAt: currentTime,
      stateReason: reason,
      boundLaneIDs: [],
    }

    document.entries = document.entries.map((entry) => (entry.cellID === cellID ? recycled : entry))
    await writeRegistry(this.filePath, document)
    return recycled
  }

  async get(cellID: string): Promise<ToolchainCellDescriptor | undefined> {
    const normalized = ToolchainCellID.make(cellID)
    const document = await readRegistry(this.filePath)
    return document.entries.find((entry) => entry.cellID === normalized)
  }

  async list(): Promise<ToolchainCellDescriptor[]> {
    return (await readRegistry(this.filePath)).entries
  }
}
