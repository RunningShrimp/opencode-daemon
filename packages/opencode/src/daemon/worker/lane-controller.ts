import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "@/global"
import { LaneID, ResumeToken } from "@/daemon/identity/ids"
import type { ProjectRuntimeKey } from "@/daemon/identity/runtime-key"
import { parseProjectRuntimeKey } from "@/daemon/identity/runtime-key"
import type { WorkerID } from "@/daemon/identity/ids"
import type { ClientLaneDescriptor } from "@/daemon/worker/client-lane-descriptor"
import { parseClientLaneDescriptor } from "@/daemon/worker/client-lane-descriptor"

interface LaneRegistryDocument {
  version: 1
  lanes: ClientLaneDescriptor[]
}

export interface LaneAcquireInput {
  workerID: WorkerID
  runtimeKey: ProjectRuntimeKey
  sessionID: string
  directory: string
}

export interface LaneReleaseInput {
  laneID: string
  reason: string
}

export interface LaneCancelInput {
  laneID: string
  reason: string
  requestID: string
}

export interface LaneRebuildInput {
  laneID: string
  reason: string
  directory?: string
}

export interface LaneRebuildResult {
  previous: ClientLaneDescriptor
  current: ClientLaneDescriptor
}

export interface LaneResumeInput {
  resumeToken: string
  directory?: string
}

function normalizedDirectory(value: string | undefined, fallback: string) {
  const directory = value?.trim() || fallback
  if (!directory) throw new Error("directory is required")
  return directory
}

function laneRegistryPath(rootDir = Global.Path.state) {
  return path.join(rootDir, "daemon", "lane-registry.json")
}

async function readRegistry(filePath: string): Promise<LaneRegistryDocument> {
  const raw = await fs.readFile(filePath, "utf8").catch(() => undefined)
  if (!raw) {
    return {
      version: 1,
      lanes: [],
    }
  }

  try {
    const parsed = JSON.parse(raw) as LaneRegistryDocument
    if (parsed.version !== 1 || !Array.isArray(parsed.lanes)) {
      return {
        version: 1,
        lanes: [],
      }
    }

    return {
      version: 1,
      lanes: parsed.lanes.map((lane) => parseClientLaneDescriptor(lane)),
    }
  } catch {
    return {
      version: 1,
      lanes: [],
    }
  }
}

async function writeRegistry(filePath: string, document: LaneRegistryDocument): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(tempPath, JSON.stringify(document, null, 2), { mode: 0o600 })
  await fs.rename(tempPath, filePath)
}

export class LaneController {
  constructor(
    private readonly filePath = laneRegistryPath(),
    private readonly now: () => number = () => Date.now(),
  ) {}

  async acquire(input: LaneAcquireInput): Promise<ClientLaneDescriptor> {
    const runtimeKey = parseProjectRuntimeKey(input.runtimeKey)
    const sessionID = input.sessionID.trim()
    const directory = input.directory.trim()
    if (!sessionID) throw new Error("sessionID is required")
    if (!directory) throw new Error("directory is required")

    const document = await readRegistry(this.filePath)
    const existing = document.lanes.find(
      (lane) =>
        lane.workerID === input.workerID &&
        lane.runtimeKey === runtimeKey &&
        lane.sessionID === sessionID &&
        lane.state === "active",
    )

    const currentTime = this.now()
    if (existing) {
      const refreshed: ClientLaneDescriptor = {
        ...existing,
        directory,
        lastHeartbeatAt: currentTime,
      }
      document.lanes = document.lanes.map((lane) => (lane.laneID === existing.laneID ? refreshed : lane))
      await writeRegistry(this.filePath, document)
      return refreshed
    }

    const descriptor: ClientLaneDescriptor = {
      laneID: LaneID.random(),
      workerID: input.workerID,
      runtimeKey,
      sessionID,
      directory,
      state: "active",
      acquiredAt: currentTime,
      lastHeartbeatAt: currentTime,
    }

    document.lanes.push(descriptor)
    await writeRegistry(this.filePath, document)
    return descriptor
  }

  async release(input: LaneReleaseInput): Promise<ClientLaneDescriptor | undefined> {
    const laneID = LaneID.make(input.laneID)
    const reason = input.reason.trim()
    if (!reason) throw new Error("release reason is required")

    const document = await readRegistry(this.filePath)
    const existing = document.lanes.find((lane) => lane.laneID === laneID)
    if (!existing) return undefined

    const currentTime = this.now()

    const released: ClientLaneDescriptor = {
      ...existing,
      state: "released",
      releasedAt: currentTime,
      lastHeartbeatAt: currentTime,
      releaseReason: reason,
    }

    document.lanes = document.lanes.map((lane) => (lane.laneID === laneID ? released : lane))
    await writeRegistry(this.filePath, document)
    return released
  }

  async cancel(input: LaneCancelInput): Promise<ClientLaneDescriptor | undefined> {
    const laneID = LaneID.make(input.laneID)
    const reason = input.reason.trim()
    const requestID = input.requestID.trim()
    if (!reason) throw new Error("cancel reason is required")
    if (!requestID) throw new Error("cancel requestID is required")

    const document = await readRegistry(this.filePath)
    const existing = document.lanes.find((lane) => lane.laneID === laneID)
    if (!existing) return undefined

    if (existing.state === "cancelled" && existing.cancelRequestID === requestID) {
      return existing
    }

    const currentTime = this.now()
    const cancelled: ClientLaneDescriptor = {
      ...existing,
      state: "cancelled",
      cancelledAt: currentTime,
      lastHeartbeatAt: currentTime,
      cancelReason: reason,
      cancelRequestID: requestID,
      resumeToken: existing.resumeToken ?? ResumeToken.random(),
    }

    document.lanes = document.lanes.map((lane) => (lane.laneID === laneID ? cancelled : lane))
    await writeRegistry(this.filePath, document)
    return cancelled
  }

  async rebuild(input: LaneRebuildInput): Promise<LaneRebuildResult | undefined> {
    const laneID = LaneID.make(input.laneID)
    const reason = input.reason.trim()
    if (!reason) throw new Error("rebuild reason is required")

    const document = await readRegistry(this.filePath)
    const existing = document.lanes.find((lane) => lane.laneID === laneID)
    if (!existing) return undefined

    const currentTime = this.now()
    const resumeToken = existing.resumeToken ?? ResumeToken.random()
    const previous: ClientLaneDescriptor = {
      ...existing,
      state: "rebuilding",
      lastHeartbeatAt: currentTime,
      cancelReason: existing.cancelReason ?? reason,
      resumeToken,
    }

    const current: ClientLaneDescriptor = {
      laneID: LaneID.random(),
      workerID: existing.workerID,
      runtimeKey: existing.runtimeKey,
      sessionID: existing.sessionID,
      directory: normalizedDirectory(input.directory, existing.directory),
      state: "active",
      acquiredAt: currentTime,
      lastHeartbeatAt: currentTime,
      resumeToken,
      rebuiltFromLaneID: existing.laneID,
    }

    document.lanes = [
      ...document.lanes.map((lane) => (lane.laneID === laneID ? previous : lane)),
      current,
    ]
    await writeRegistry(this.filePath, document)
    return {
      previous,
      current,
    }
  }

  async resume(input: LaneResumeInput): Promise<ClientLaneDescriptor | undefined> {
    const resumeToken = ResumeToken.make(input.resumeToken)
    const document = await readRegistry(this.filePath)
    const currentTime = this.now()

    const active = document.lanes.find((lane) => lane.resumeToken === resumeToken && lane.state === "active")
    if (active) {
      const resumed: ClientLaneDescriptor = {
        ...active,
        directory: normalizedDirectory(input.directory, active.directory),
        lastHeartbeatAt: currentTime,
      }
      document.lanes = document.lanes.map((lane) => (lane.laneID === active.laneID ? resumed : lane))
      await writeRegistry(this.filePath, document)
      return resumed
    }

    const candidate = [...document.lanes]
      .filter((lane) => lane.resumeToken === resumeToken)
      .sort((left, right) => (right.lastHeartbeatAt ?? 0) - (left.lastHeartbeatAt ?? 0))[0]

    if (!candidate) return undefined

    const resumed: ClientLaneDescriptor = {
      laneID: LaneID.random(),
      workerID: candidate.workerID,
      runtimeKey: candidate.runtimeKey,
      sessionID: candidate.sessionID,
      directory: normalizedDirectory(input.directory, candidate.directory),
      state: "active",
      acquiredAt: currentTime,
      lastHeartbeatAt: currentTime,
      resumeToken,
      rebuiltFromLaneID: candidate.laneID,
    }

    document.lanes.push(resumed)
    await writeRegistry(this.filePath, document)
    return resumed
  }

  async get(laneID: string): Promise<ClientLaneDescriptor | undefined> {
    const normalized = LaneID.make(laneID)
    const document = await readRegistry(this.filePath)
    return document.lanes.find((lane) => lane.laneID === normalized)
  }

  async list(): Promise<ClientLaneDescriptor[]> {
    return (await readRegistry(this.filePath)).lanes
  }
}
