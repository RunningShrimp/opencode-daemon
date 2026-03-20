import { acquireBootstrapLock, type BootstrapLockHandle } from "./bootstrap-lock"
import { MasterDiscoveryService } from "./discovery"
import { ServerRegistryStore, type MasterRegistryEntry } from "./registry"
import { FencingEpochGenerator, type FencingEpoch } from "@/daemon/protocol/fencing-epoch"
import { MasterSentinel } from "@/daemon/master/master-sentinel"

export interface StartMasterHandle {
  endpoint: string
  stop?: () => Promise<void>
  pid?: number
  epoch?: FencingEpoch
}

export type EnsureMasterResult =
  | {
      mode: "attached"
      endpoint: string
      entry: MasterRegistryEntry
    }
  | {
      mode: "started"
      endpoint: string
      pid: number
      epoch: FencingEpoch
      stop: () => Promise<void>
    }

export interface EnsureMasterInput {
  namespaceID: string
  start: () => Promise<StartMasterHandle>
  rootDir?: string
  now?: number
  lockTimeoutMs?: number
  lockPollMs?: number
  lockStaleAfterMs?: number
}

export interface MasterBootstrapCoordinatorDeps {
  registry?: ServerRegistryStore
  discovery?: MasterDiscoveryService
  acquireLock?: (input: {
    namespaceID: string
    rootDir?: string
    timeoutMs?: number
    pollMs?: number
    staleAfterMs?: number
  }) => Promise<BootstrapLockHandle>
}

export class MasterBootstrapCoordinator {
  private readonly registry: ServerRegistryStore
  private readonly discovery: MasterDiscoveryService
  private readonly acquireLock: Required<MasterBootstrapCoordinatorDeps>["acquireLock"]

  constructor(deps: MasterBootstrapCoordinatorDeps = {}) {
    this.registry = deps.registry ?? new ServerRegistryStore()
    this.discovery = deps.discovery ?? new MasterDiscoveryService(this.registry)
    this.acquireLock = deps.acquireLock ?? acquireBootstrapLock
  }

  async ensureMaster(input: EnsureMasterInput): Promise<EnsureMasterResult> {
    const lock = await this.acquireLock({
      namespaceID: input.namespaceID,
      rootDir: input.rootDir,
      timeoutMs: input.lockTimeoutMs,
      pollMs: input.lockPollMs,
      staleAfterMs: input.lockStaleAfterMs,
    })

    try {
      const existing = await this.discovery.findHealthyMaster(input.namespaceID)
      if (existing) {
        return {
          mode: "attached",
          endpoint: existing.endpoint,
          entry: existing,
        }
      }

      const started = await input.start()
      const pid = started.pid ?? process.pid
      const now = input.now ?? Date.now()
      const epoch = started.epoch ?? new FencingEpochGenerator(pid).next(now)

      await this.discovery.registerCurrentMaster({
        namespaceID: input.namespaceID,
        endpoint: started.endpoint,
        pid,
        epoch,
        now,
      })

      const sentinel = new MasterSentinel(this.registry, {
        namespaceID: input.namespaceID,
        pid,
      })
      sentinel.start()

      let stopped = false
      const stop = async () => {
        if (stopped) return
        stopped = true
        await sentinel.stop()
        await started.stop?.()
      }

      return {
        mode: "started",
        endpoint: started.endpoint,
        pid,
        epoch,
        stop,
      }
    } finally {
      lock[Symbol.dispose]()
    }
  }
}
