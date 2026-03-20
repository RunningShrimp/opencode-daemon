import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { acquireBootstrapLock } from "@/daemon/bootstrap/bootstrap-lock"
import { ServerRegistryStore } from "@/daemon/bootstrap/registry"
import { MasterDiscoveryService } from "@/daemon/bootstrap/discovery"
import { FencingEpochGenerator } from "@/daemon/protocol/fencing-epoch"

const tempPaths: string[] = []

async function createTempDir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-daemon-test-"))
  tempPaths.push(dir)
  return dir
}

afterEach(async () => {
  mock.restore()
  await Promise.all(tempPaths.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe("daemon bootstrap lock", () => {
  test("prevents concurrent acquisition for same namespace", async () => {
    const rootDir = await createTempDir()
    const lock = await acquireBootstrapLock({
      namespaceID: "local",
      rootDir,
      timeoutMs: 300,
      pollMs: 10,
    })

    await expect(
      acquireBootstrapLock({
        namespaceID: "local",
        rootDir,
        timeoutMs: 100,
        pollMs: 10,
      }),
    ).rejects.toThrow("Timed out waiting for bootstrap lock")

    lock[Symbol.dispose]()

    const reacquired = await acquireBootstrapLock({
      namespaceID: "local",
      rootDir,
      timeoutMs: 300,
      pollMs: 10,
    })
    reacquired[Symbol.dispose]()
  })

  test("reclaims lock file when owning pid is no longer alive", async () => {
    const rootDir = await createTempDir()
    const lockPath = path.join(rootDir, "daemon", "locks", "local.lock")
    await fs.mkdir(path.dirname(lockPath), { recursive: true })
    await fs.writeFile(lockPath, "999999:1700000000000", "utf8")

    const lock = await acquireBootstrapLock({
      namespaceID: "local",
      rootDir,
      timeoutMs: 500,
      pollMs: 10,
      staleAfterMs: 60_000,
    })

    expect(lock.path).toBe(lockPath)
    lock[Symbol.dispose]()
  })
})

describe("daemon registry and discovery", () => {
  test("stores entries and returns healthy master", async () => {
    const rootDir = await createTempDir()
    const store = new ServerRegistryStore(path.join(rootDir, "daemon", "master-registry.json"))
    const discovery = new MasterDiscoveryService(store, { timeoutMs: 1_000 })

    const server = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === "/global/health") {
          return Response.json({ healthy: true })
        }
        return new Response("not found", { status: 404 })
      },
    })

    const endpoint = `http://${server.hostname}:${server.port}`
    const epoch = new FencingEpochGenerator().next()

    await discovery.registerCurrentMaster({
      namespaceID: "local",
      endpoint,
      pid: process.pid,
      epoch,
    })

    const entry = await discovery.findHealthyMaster("local")
    expect(entry?.endpoint).toBe(endpoint)
    expect(entry?.pid).toBe(process.pid)

    server.stop(true)
  })

  test("prunes stale dead process entries", async () => {
    const rootDir = await createTempDir()
    const store = new ServerRegistryStore(path.join(rootDir, "daemon", "master-registry.json"))
    const discovery = new MasterDiscoveryService(store)

    await store.upsert({
      namespaceID: "local",
      endpoint: "http://127.0.0.1:65500",
      pid: 999_999,
      epoch: new FencingEpochGenerator().next(),
      startedAt: Date.now(),
      updatedAt: Date.now(),
    })

    const entry = await discovery.findHealthyMaster("local")
    expect(entry).toBeUndefined()

    const list = await store.list("local")
    expect(list.length).toBe(0)
  })

  test("prefers latest fencing epoch when multiple masters are healthy", async () => {
    const rootDir = await createTempDir()
    const store = new ServerRegistryStore(path.join(rootDir, "daemon", "master-registry.json"))
    const discovery = new MasterDiscoveryService(store, { timeoutMs: 1_000 })
    const generator = new FencingEpochGenerator()
    spyOn(process, "kill").mockImplementation(() => true)

    const older = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === "/global/health") {
          return Response.json({ healthy: true, generation: "old" })
        }
        return new Response("not found", { status: 404 })
      },
    })
    const newer = Bun.serve({
      port: 0,
      hostname: "127.0.0.1",
      fetch(request) {
        const url = new URL(request.url)
        if (url.pathname === "/global/health") {
          return Response.json({ healthy: true, generation: "new" })
        }
        return new Response("not found", { status: 404 })
      },
    })

    const olderEpoch = generator.next(1_700_000_000_000)
    const newerEpoch = generator.next(1_700_000_000_010)

    await store.upsert({
      namespaceID: "local",
      endpoint: `http://${older.hostname}:${older.port}`,
      pid: process.pid,
      epoch: olderEpoch,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    })
    await store.upsert({
      namespaceID: "local",
      endpoint: `http://${newer.hostname}:${newer.port}`,
      pid: process.pid + 1,
      epoch: newerEpoch,
      startedAt: Date.now(),
      updatedAt: Date.now(),
    })

    const selected = await discovery.findHealthyMaster("local", { minEpoch: olderEpoch })
    expect(selected?.epoch).toBe(newerEpoch)

    older.stop(true)
    newer.stop(true)
  })

  test("drops stale heartbeat entries before probing endpoint", async () => {
    const rootDir = await createTempDir()
    const store = new ServerRegistryStore(path.join(rootDir, "daemon", "master-registry.json"))
    const discovery = new MasterDiscoveryService(store, {
      timeoutMs: 100,
      staleAfterMs: 1_000,
      now: () => 10_000,
    })

    await store.upsert({
      namespaceID: "local",
      endpoint: "http://127.0.0.1:65500",
      pid: process.pid,
      epoch: new FencingEpochGenerator().next(),
      startedAt: 0,
      updatedAt: 8_000,
    })

    const entry = await discovery.findHealthyMaster("local")
    expect(entry).toBeUndefined()

    const list = await store.list("local")
    expect(list).toHaveLength(0)
  })
})
