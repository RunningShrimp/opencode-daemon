import { ResourcePool, type PoolOptions, type PoolStats, normalizePath } from "../pool"
import { LSPClient } from "./client"
import type { LSPServer } from "./server"

interface LSPPoolEntry {
  client: LSPClient.Info
}

class LSPProcessPool extends ResourcePool<LSPPoolEntry> {
  constructor() {
    const options: PoolOptions = {
      idleTimeoutMs: 5 * 60 * 1000,
      maxSize: 50,
      cleanupIntervalMs: 60 * 1000,
    }
    super(options)
  }

  getKey(serverID: string, root: string): string {
    return `${serverID}:${normalizePath(root)}`
  }

  async create(serverID: string, root: string, server: LSPServer.Handle): Promise<LSPPoolEntry> {
    const client = await LSPClient.create({ serverID, server, root })
    return { client }
  }

  async destroy(entry: LSPPoolEntry): Promise<void> {
    try {
      await entry.client.shutdown()
    } catch {
      // Ignore shutdown errors
    }
  }

  async acquireClient(serverID: string, root: string, server: LSPServer.Handle): Promise<LSPClient.Info> {
    const entry = await this.acquire(serverID, root, server)
    return entry.client
  }

  releaseClient(serverID: string, root: string): void {
    const key = this.getKey(serverID, root)
    this.release(key)
  }

  override status(): PoolStats {
    return super.status()
  }
}

export const LSPPool = new LSPProcessPool()

// Start cleanup timer for idle connections
LSPPool.startCleanup()
