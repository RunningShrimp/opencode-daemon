import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { MasterBootstrapCoordinator } from "@/daemon/bootstrap/master-bootstrap"
import { ServerRegistryStore } from "@/daemon/bootstrap/registry"
import { MasterDiscoveryService } from "@/daemon/bootstrap/discovery"
import { acquireBootstrapLock } from "@/daemon/bootstrap/bootstrap-lock"
import { FencingEpochGenerator } from "@/daemon/protocol/fencing-epoch"

const tempPaths: string[] = []

async function createTempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-daemon-master-bootstrap-"))
  tempPaths.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe("master bootstrap coordinator", () => {
  test("attaches to existing healthy master without invoking start callback", async () => {
    const rootDir = await createTempDir()
    const store = new ServerRegistryStore(path.join(rootDir, "daemon", "master-registry.json"))
    const discovery = new MasterDiscoveryService(store, { timeoutMs: 500 })
    const coordinator = new MasterBootstrapCoordinator({
      registry: store,
      discovery,
      acquireLock: acquireBootstrapLock,
    })

    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === "/global/health") {
          return Response.json({ ok: true })
        }
        return new Response("not found", { status: 404 })
      },
    })

    await discovery.registerCurrentMaster({
      namespaceID: "local",
      endpoint: `http://${server.hostname}:${server.port}`,
      pid: process.pid,
      epoch: new FencingEpochGenerator().next(),
    })

    let startCalled = 0
    const result = await coordinator.ensureMaster({
      namespaceID: "local",
      rootDir,
      start: async () => {
        startCalled += 1
        return {
          endpoint: "http://127.0.0.1:1",
          pid: process.pid,
        }
      },
    })

    expect(result.mode).toBe("attached")
    expect(startCalled).toBe(0)

    server.stop(true)
  })

  test("starts, registers, and unregisters master lifecycle", async () => {
    const rootDir = await createTempDir()
    const store = new ServerRegistryStore(path.join(rootDir, "daemon", "master-registry.json"))
    const discovery = new MasterDiscoveryService(store, { timeoutMs: 500 })
    const coordinator = new MasterBootstrapCoordinator({
      registry: store,
      discovery,
      acquireLock: acquireBootstrapLock,
    })

    const result = await coordinator.ensureMaster({
      namespaceID: "local",
      rootDir,
      start: async () => {
        const server = Bun.serve({
          port: 0,
          hostname: "127.0.0.1",
          fetch(request) {
            const url = new URL(request.url)
            if (url.pathname === "/global/health") {
              return Response.json({ ok: true })
            }
            return new Response("not found", { status: 404 })
          },
        })

        return {
          endpoint: `http://${server.hostname}:${server.port}`,
          pid: process.pid,
          stop: async () => {
            server.stop(true)
          },
        }
      },
    })

    expect(result.mode).toBe("started")
    if (result.mode !== "started") return

    const found = await discovery.findHealthyMaster("local")
    expect(found?.endpoint).toBe(result.endpoint)

    await result.stop()

    const entries = await store.list("local")
    expect(entries).toHaveLength(0)
  })
})
