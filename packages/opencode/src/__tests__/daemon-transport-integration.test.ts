import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { Server } from "@/server/server"
import { createLocalTransportAdapter } from "@/daemon/transport/local-transport-adapter"

const cleanup: string[] = []
const envKeys = [
  "XDG_DATA_HOME",
  "XDG_CACHE_HOME",
  "XDG_CONFIG_HOME",
  "XDG_STATE_HOME",
  "OPENCODE_EMBEDDING_PROVIDER",
] as const
const originalEnv = new Map<string, string | undefined>()

beforeEach(async () => {
  for (const key of envKeys) {
    originalEnv.set(key, process.env[key])
  }

  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-daemon-transport-integration-"))
  cleanup.push(root)

  process.env.XDG_DATA_HOME = path.join(root, "data-home")
  process.env.XDG_CACHE_HOME = path.join(root, "cache-home")
  process.env.XDG_CONFIG_HOME = path.join(root, "config-home")
  process.env.XDG_STATE_HOME = path.join(root, "state-home")
  process.env.OPENCODE_EMBEDDING_PROVIDER = "fallback"
})

afterEach(async () => {
  for (const key of envKeys) {
    const value = originalEnv.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }

  await Promise.all(cleanup.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe("daemon transport bridge integration", () => {
  test("routes relative internal health requests through local adapter", async () => {
    const adapter = createLocalTransportAdapter({
      dispatch: async (request) => Server.Default().fetch(request),
      internalOrigin: "http://opencode.internal",
      rejectExternal: true,
    })

    const response = await adapter("/global/health")
    expect(response.status).toBe(200)

    const payload = (await response.json()) as { healthy: boolean; version: string }
    expect(payload.healthy).toBe(true)
    expect(typeof payload.version).toBe("string")
    expect(payload.version.length).toBeGreaterThan(0)
  })

  test("supports SDK global API calls over internal virtual transport", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-daemon-transport-workspace-"))
    cleanup.push(workspace)

    const adapter = createLocalTransportAdapter({
      dispatch: async (request) => Server.Default().fetch(request),
      internalOrigin: "http://opencode.internal",
      rejectExternal: true,
    })

    const sdk = createOpencodeClient({
      baseUrl: "http://opencode.internal",
      directory: workspace,
      fetch: adapter,
    })

    const health = await sdk.global.health({ throwOnError: true })
    expect(health.data?.healthy).toBe(true)
    expect(typeof health.data?.version).toBe("string")

    const globalConfig = await sdk.global.config.get({ throwOnError: true })
    expect(globalConfig.data).toBeDefined()
  })
})
