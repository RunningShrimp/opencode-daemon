import { ServerRegistryStore, type MasterRegistryEntry } from "./registry"
import type { FencingEpoch } from "@/daemon/protocol/fencing-epoch"
import { compareFencingEpoch } from "@/daemon/protocol/fencing-epoch"

export interface DiscoveryOptions {
  timeoutMs?: number
  staleAfterMs?: number
  now?: () => number
}

export interface FindHealthyMasterOptions {
  minEpoch?: FencingEpoch
}

export interface RegisterMasterInput {
  namespaceID: string
  endpoint: string
  pid: number
  epoch: FencingEpoch
  now?: number
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function probeHealth(endpoint: string, timeoutMs: number) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)

  try {
    const response = await fetch(new URL("/global/health", endpoint), {
      method: "GET",
      signal: controller.signal,
    })
    return response.ok
  } catch {
    return false
  } finally {
    clearTimeout(timer)
  }
}

export class MasterDiscoveryService {
  constructor(private readonly registry: ServerRegistryStore, private readonly options: DiscoveryOptions = {}) {}

  async registerCurrentMaster(input: RegisterMasterInput) {
    const now = input.now ?? Date.now()
    await this.registry.upsert({
      namespaceID: input.namespaceID,
      endpoint: input.endpoint,
      pid: input.pid,
      epoch: input.epoch,
      startedAt: now,
      updatedAt: now,
    })
  }

  async findHealthyMaster(namespaceID: string, options: FindHealthyMasterOptions = {}): Promise<MasterRegistryEntry | undefined> {
    const timeoutMs = this.options.timeoutMs ?? 750
    const staleAfterMs = this.options.staleAfterMs ?? 15_000
    const now = this.options.now?.() ?? Date.now()
    const entries = (await this.registry.list(namespaceID)).sort((left, right) => {
      try {
        const epochOrder = compareFencingEpoch(right.epoch, left.epoch)
        if (epochOrder !== 0) return epochOrder
      } catch {
        // Ignore malformed epochs and fall back to freshness ordering.
      }

      return right.updatedAt - left.updatedAt
    })

    for (const entry of entries) {
      if (now - entry.updatedAt > staleAfterMs) {
        await this.registry.remove(entry.namespaceID, entry.pid)
        continue
      }

      if (options.minEpoch) {
        try {
          if (compareFencingEpoch(entry.epoch, options.minEpoch) < 0) {
            await this.registry.remove(entry.namespaceID, entry.pid)
            continue
          }
        } catch {
          await this.registry.remove(entry.namespaceID, entry.pid)
          continue
        }
      }

      if (!isProcessAlive(entry.pid)) {
        await this.registry.remove(entry.namespaceID, entry.pid)
        continue
      }

      const healthy = await probeHealth(entry.endpoint, timeoutMs)
      if (healthy) {
        return entry
      }

      await this.registry.remove(entry.namespaceID, entry.pid)
    }

    return undefined
  }
}
