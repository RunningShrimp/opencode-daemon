import { ServerRegistryStore } from "@/daemon/bootstrap/registry"

export interface MasterSentinelOptions {
  namespaceID: string
  pid: number
  heartbeatIntervalMs?: number
}

export class MasterSentinel {
  private timer: ReturnType<typeof setInterval> | undefined

  constructor(private readonly registry: ServerRegistryStore, private readonly options: MasterSentinelOptions) {}

  start() {
    if (this.timer) return
    const interval = this.options.heartbeatIntervalMs ?? 2_000
    this.timer = setInterval(() => {
      void this.registry.touch(this.options.namespaceID, this.options.pid, Date.now())
    }, interval)
  }

  async stop() {
    if (this.timer) {
      clearInterval(this.timer)
      this.timer = undefined
    }
    await this.registry.remove(this.options.namespaceID, this.options.pid)
  }
}
