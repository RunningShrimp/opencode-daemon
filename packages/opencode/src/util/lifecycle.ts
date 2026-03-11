import z from "zod"
import { BusEvent } from "@/bus/bus-event"
import { Log } from "@/util/log"

const log = Log.create({ service: "lifecycle" })

export const LifecycleEvent = {
  Destroy: BusEvent.define("lifecycle.destroy", z.object({})),
  Initialize: BusEvent.define("lifecycle.initialize", z.object({})),
  Shutdown: BusEvent.define("lifecycle.shutdown", z.object({})),
} as const

export interface Destroyable {
  destroy(): void | Promise<void>
}

export namespace Destroyable {
  export function isDestroyable(value: unknown): value is Destroyable {
    return (
      value !== null &&
      typeof value === "object" &&
      "destroy" in value &&
      typeof (value as Record<string, unknown>).destroy === "function"
    )
  }

  export async function safeDestroy(value: unknown): Promise<void> {
    if (isDestroyable(value)) {
      try {
        await value.destroy()
      } catch (error) {
        log.error("destroy error", { error: String(error) })
      }
    }
  }
}

const registry = new Map<object, () => void | Promise<void>>()

export function register(owner: object, cleanup: () => void | Promise<void>): void {
  if (registry.has(owner)) {
    log.warn("already registered", { owner: String(owner) })
    return
  }
  registry.set(owner, cleanup)
}

export function unregister(owner: object): void {
  registry.delete(owner)
}

export async function destroyAll(): Promise<void> {
  const owners = Array.from(registry.keys())
  for (const owner of owners) {
    const cleanup = registry.get(owner)
    if (cleanup) {
      try {
        await cleanup()
      } catch (error) {
        log.error("cleanup error", { owner: String(owner), error: String(error) })
      }
      registry.delete(owner)
    }
  }
}

export function size(): number {
  return registry.size
}
