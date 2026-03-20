import fs from "node:fs/promises"
import path from "node:path"
import { Global } from "@/global"
import { LaneID, LeaseToken, WorkerID } from "@/daemon/identity/ids"

export type SideEffectResultCode = "accepted" | "completed" | "unknown" | "partially-applied"

interface ActiveLease {
  workerID: string
  laneID: string
  resourceKey: string
  leaseToken: string
  acquiredAt: number
}

interface IdempotencyRecord {
  idempotencyKey: string
  workerID: string
  laneID: string
  resourceKey: string
  status: SideEffectResultCode
  updatedAt: number
  leaseToken?: string
  detail?: string
}

interface ArbiterDocument {
  version: 1
  activeLeases: ActiveLease[]
  records: IdempotencyRecord[]
}

export interface AcquireResourceInput {
  workerID: string
  laneID: string
  resourceKey: string
  idempotencyKey: string
}

export interface CompleteResourceInput {
  idempotencyKey: string
  status?: Extract<SideEffectResultCode, "completed" | "partially-applied" | "unknown">
  detail?: string
}

export interface ReleaseResourceInput {
  workerID: string
  laneID: string
  resourceKey: string
  leaseToken?: string
}

export interface RecoverResourceInput {
  idempotencyKey: string
}

export interface ResourceArbitrationResult {
  status: SideEffectResultCode
  leaseToken?: string
  detail?: string
}

function registryPath(rootDir = Global.Path.state) {
  return path.join(rootDir, "daemon", "worker-resource-arbiter.json")
}

async function readRegistry(filePath: string): Promise<ArbiterDocument> {
  const raw = await fs.readFile(filePath, "utf8").catch(() => undefined)
  if (!raw) {
    return {
      version: 1,
      activeLeases: [],
      records: [],
    }
  }

  try {
    const parsed = JSON.parse(raw) as ArbiterDocument
    if (parsed.version !== 1 || !Array.isArray(parsed.activeLeases) || !Array.isArray(parsed.records)) {
      return {
        version: 1,
        activeLeases: [],
        records: [],
      }
    }
    return parsed
  } catch {
    return {
      version: 1,
      activeLeases: [],
      records: [],
    }
  }
}

async function writeRegistry(filePath: string, document: ArbiterDocument): Promise<void> {
  await fs.mkdir(path.dirname(filePath), { recursive: true })
  const tempPath = `${filePath}.${process.pid}.${Date.now()}.tmp`
  await fs.writeFile(tempPath, JSON.stringify(document, null, 2), { mode: 0o600 })
  await fs.rename(tempPath, filePath)
}

function trimRequired(value: string, field: string) {
  const text = value.trim()
  if (!text) throw new Error(`${field} is required`)
  return text
}

function upsertRecord(document: ArbiterDocument, next: IdempotencyRecord) {
  document.records = [...document.records.filter((record) => record.idempotencyKey !== next.idempotencyKey), next]
}

export class WorkerResourceArbiter {
  constructor(
    private readonly filePath = registryPath(),
    private readonly now: () => number = () => Date.now(),
  ) {}

  async acquire(input: AcquireResourceInput): Promise<ResourceArbitrationResult> {
    const workerID = WorkerID.make(input.workerID)
    const laneID = LaneID.make(input.laneID)
    const resourceKey = trimRequired(input.resourceKey, "resourceKey")
    const idempotencyKey = trimRequired(input.idempotencyKey, "idempotencyKey")

    const document = await readRegistry(this.filePath)
    const existing = document.records.find((record) => record.idempotencyKey === idempotencyKey)
    if (existing) {
      return {
        status: existing.status,
        leaseToken: existing.leaseToken,
        detail: existing.detail,
      }
    }

    const currentTime = this.now()
    const heldLease = document.activeLeases.find((lease) => lease.workerID === workerID && lease.resourceKey === resourceKey)
    if (!heldLease) {
      const leaseToken = LeaseToken.random()
      document.activeLeases.push({
        workerID,
        laneID,
        resourceKey,
        leaseToken,
        acquiredAt: currentTime,
      })
      upsertRecord(document, {
        idempotencyKey,
        workerID,
        laneID,
        resourceKey,
        status: "accepted",
        leaseToken,
        updatedAt: currentTime,
      })
      await writeRegistry(this.filePath, document)
      return {
        status: "accepted",
        leaseToken,
      }
    }

    if (heldLease.laneID === laneID) {
      upsertRecord(document, {
        idempotencyKey,
        workerID,
        laneID,
        resourceKey,
        status: "accepted",
        leaseToken: heldLease.leaseToken,
        updatedAt: currentTime,
      })
      await writeRegistry(this.filePath, document)
      return {
        status: "accepted",
        leaseToken: heldLease.leaseToken,
      }
    }

    upsertRecord(document, {
      idempotencyKey,
      workerID,
      laneID,
      resourceKey,
      status: "partially-applied",
      updatedAt: currentTime,
      detail: `resource-busy:${resourceKey}:held-by:${heldLease.laneID}`,
    })
    await writeRegistry(this.filePath, document)
    return {
      status: "partially-applied",
      detail: `resource-busy:${resourceKey}:held-by:${heldLease.laneID}`,
    }
  }

  async complete(input: CompleteResourceInput): Promise<ResourceArbitrationResult> {
    const idempotencyKey = trimRequired(input.idempotencyKey, "idempotencyKey")
    const status = input.status ?? "completed"
    const document = await readRegistry(this.filePath)

    const existing = document.records.find((record) => record.idempotencyKey === idempotencyKey)
    if (!existing) {
      return {
        status: "unknown",
      }
    }

    const next: IdempotencyRecord = {
      ...existing,
      status,
      detail: input.detail ?? existing.detail,
      updatedAt: this.now(),
    }
    upsertRecord(document, next)
    await writeRegistry(this.filePath, document)
    return {
      status: next.status,
      leaseToken: next.leaseToken,
      detail: next.detail,
    }
  }

  async release(input: ReleaseResourceInput): Promise<boolean> {
    const workerID = WorkerID.make(input.workerID)
    const laneID = LaneID.make(input.laneID)
    const resourceKey = trimRequired(input.resourceKey, "resourceKey")

    const document = await readRegistry(this.filePath)
    const before = document.activeLeases.length
    document.activeLeases = document.activeLeases.filter((lease) => {
      if (lease.workerID !== workerID) return true
      if (lease.laneID !== laneID) return true
      if (lease.resourceKey !== resourceKey) return true
      if (input.leaseToken && lease.leaseToken !== input.leaseToken) return true
      return false
    })

    if (before === document.activeLeases.length) {
      return false
    }

    await writeRegistry(this.filePath, document)
    return true
  }

  async recover(input: RecoverResourceInput): Promise<ResourceArbitrationResult> {
    const idempotencyKey = trimRequired(input.idempotencyKey, "idempotencyKey")
    const document = await readRegistry(this.filePath)
    const record = document.records.find((entry) => entry.idempotencyKey === idempotencyKey)
    if (!record) {
      return {
        status: "unknown",
      }
    }

    return {
      status: record.status,
      leaseToken: record.leaseToken,
      detail: record.detail,
    }
  }
}
