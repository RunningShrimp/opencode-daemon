import { Log } from "./log"
import { EventEmitter } from "events"

const log = Log.create({ service: "bg-service" })

export type ServiceStatus = "idle" | "loading" | "ready" | "error" | "fallback"

export interface IBackgroundService {
  name: string
  priority: number
  start(): Promise<void>
  stop(): Promise<void>
  getStatus(): ServiceStatus
  isReady(): boolean
}

export class BackgroundServiceManager extends EventEmitter {
  private static instance: BackgroundServiceManager
  private services: Map<string, IBackgroundService> = new Map()
  private status: Map<string, ServiceStatus> = new Map()
  private initialized = false

  private constructor() {
    super()
  }

  static getInstance(): BackgroundServiceManager {
    if (!BackgroundServiceManager.instance) {
      BackgroundServiceManager.instance = new BackgroundServiceManager()
    }
    return BackgroundServiceManager.instance
  }

  register(service: IBackgroundService): void {
    this.services.set(service.name, service)
    this.status.set(service.name, "idle")
    log.info("service registered", { name: service.name, priority: service.priority })
  }

  getServiceStatus(name: string): ServiceStatus {
    return this.status.get(name) ?? "idle"
  }

  allReady(): boolean {
    for (const [, status] of this.status) {
      if (status !== "ready" && status !== "fallback") {
        return false
      }
    }
    return true
  }

  getReadyCount(): { ready: number; total: number } {
    let ready = 0
    for (const [, status] of this.status) {
      if (status === "ready" || status === "fallback") {
        ready++
      }
    }
    return { ready, total: this.services.size }
  }

  async startAll(): Promise<void> {
    if (this.initialized) return
    this.initialized = true

    const sortedServices = Array.from(this.services.values()).sort((a, b) => a.priority - b.priority)

    log.info("starting background services", { count: sortedServices.length })

    for (const service of sortedServices) {
      this.startService(service.name).catch((err) => {
        log.error("service start error", { name: service.name, error: String(err) })
      })
    }
  }

  async startService(name: string): Promise<void> {
    const service = this.services.get(name)
    if (!service) {
      log.warn("service not found", { name })
      return
    }

    const currentStatus = this.status.get(name)
    if (currentStatus === "ready" || currentStatus === "loading") {
      return
    }

    this.status.set(name, "loading")
    this.emit("status", { name, status: "loading" })

    try {
      await service.start()
      const nextStatus = service.getStatus()
      this.status.set(name, nextStatus)
      this.emit("status", { name, status: nextStatus })
      log.info("service started", { name, status: nextStatus })
    } catch (error) {
      log.error("service start failed", { name, error: String(error) })
      this.status.set(name, "error")
      this.emit("status", { name, status: "error", error })
    }
  }

  async stopAll(): Promise<void> {
    log.info("stopping all background services")

    for (const [name, service] of this.services) {
      try {
        await service.stop()
        this.status.set(name, "idle")
      } catch (error) {
        log.error("service stop error", { name, error: String(error) })
      }
    }
  }
}

export function getBackgroundServiceManager(): BackgroundServiceManager {
  return BackgroundServiceManager.getInstance()
}
