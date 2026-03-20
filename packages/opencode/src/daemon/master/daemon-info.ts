import { ServerRegistryStore, type MasterRegistryEntry } from "@/daemon/bootstrap/registry"
import { Flag } from "@/flag/flag"
import { WorkerMetricsCollector, type WorkerMetricsSnapshot } from "@/daemon/master/worker-metrics"
import type { WorkerWatchdogTelemetry } from "@/daemon/master/worker-watchdog"
import { LaneController } from "@/daemon/worker/lane-controller"
import { ProjectWorkerLeaseRegistry } from "@/daemon/worker/project-worker-lease-registry"
import { ToolchainCellRegistry } from "@/daemon/worker/toolchain-cell-registry"

export interface DaemonInfoPublicListener {
  active: boolean
  url?: string
  hostname?: string
  port?: number
}

export interface DaemonInfoSnapshot {
  namespaceID: string
  capturedAt: number
  master: {
    active: boolean
    pid?: number
    endpoint?: string
    epoch?: string
    updatedAt?: number
  }
  publicListener?: DaemonInfoPublicListener
  metrics: WorkerMetricsSnapshot
  watchdog?: WorkerWatchdogTelemetry
}

export interface DaemonInfoServiceOptions {
  registry?: ServerRegistryStore
  metricsCollector?: WorkerMetricsCollector
  publicListenerProvider?: () => Promise<DaemonInfoPublicListener | undefined> | DaemonInfoPublicListener | undefined
  watchdogTelemetryProvider?: () => WorkerWatchdogTelemetry | undefined
  now?: () => number
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function authHeaders() {
  const password = Flag.OPENCODE_SERVER_PASSWORD
  if (!password) return undefined
  const username = Flag.OPENCODE_SERVER_USERNAME ?? "opencode"
  return {
    Authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
  }
}

async function resolvePublicListenerFromEndpoint(endpoint: string): Promise<DaemonInfoPublicListener | undefined> {
  try {
    const response = await fetch(new URL("/global/public-listener", endpoint), {
      method: "GET",
      headers: {
        ...(authHeaders() ?? {}),
      },
    })
    if (!response.ok) return
    const payload = (await response.json()) as DaemonInfoPublicListener
    return payload
  } catch {
    return
  }
}

function pickActiveMaster(entries: MasterRegistryEntry[]) {
  return entries.find((entry) => isProcessAlive(entry.pid))
}

export class DaemonInfoService {
  private readonly registry: ServerRegistryStore
  private readonly metricsCollector: WorkerMetricsCollector
  private readonly publicListenerProvider?: DaemonInfoServiceOptions["publicListenerProvider"]
  private readonly watchdogTelemetryProvider?: DaemonInfoServiceOptions["watchdogTelemetryProvider"]
  private readonly now: () => number

  constructor(options: DaemonInfoServiceOptions = {}) {
    this.registry = options.registry ?? new ServerRegistryStore()
    this.metricsCollector =
      options.metricsCollector ??
      new WorkerMetricsCollector({
        leaseRegistry: new ProjectWorkerLeaseRegistry(),
        laneController: new LaneController(),
        cellRegistry: new ToolchainCellRegistry(),
      })
    this.publicListenerProvider = options.publicListenerProvider
    this.watchdogTelemetryProvider = options.watchdogTelemetryProvider
    this.now = options.now ?? (() => Date.now())
  }

  async collect(namespaceID = "local"): Promise<DaemonInfoSnapshot> {
    const capturedAt = this.now()
    const entries = await this.registry.list(namespaceID)
    const resolvedMaster = pickActiveMaster(entries)

    const publicListener = await this.resolvePublicListener(resolvedMaster?.endpoint)
    const metrics = await this.metricsCollector.collect()
    const watchdog = this.watchdogTelemetryProvider?.()

    return {
      namespaceID,
      capturedAt,
      master: {
        active: !!resolvedMaster,
        pid: resolvedMaster?.pid,
        endpoint: resolvedMaster?.endpoint,
        epoch: resolvedMaster?.epoch,
        updatedAt: resolvedMaster?.updatedAt,
      },
      publicListener,
      metrics,
      watchdog,
    }
  }

  private async resolvePublicListener(endpoint: string | undefined) {
    if (this.publicListenerProvider) {
      return await this.publicListenerProvider()
    }
    if (!endpoint) return undefined
    return resolvePublicListenerFromEndpoint(endpoint)
  }
}