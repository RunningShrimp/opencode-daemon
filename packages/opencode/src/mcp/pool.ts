import { ResourcePool, type PoolOptions, type PoolStats, normalizePath } from "../pool"
import type { Client } from "@modelcontextprotocol/sdk/client/index.js"

interface MCPPoolEntry {
  client: Client
  name: string
}

class MCPProcessPool extends ResourcePool<MCPPoolEntry> {
  constructor() {
    const options: PoolOptions = {
      idleTimeoutMs: 10 * 60 * 1000,
      maxSize: 50,
      cleanupIntervalMs: 60 * 1000,
    }
    super(options)
  }

  getKey(name: string, cwd: string): string {
    return `${name}:${normalizePath(cwd)}`
  }

  async create(name: string, client: Client): Promise<MCPPoolEntry> {
    return { client, name }
  }

  async destroy(entry: MCPPoolEntry): Promise<void> {
    try {
      await entry.client.close()
    } catch {
      // Ignore shutdown errors
    }
  }

  async acquireClient(name: string, client: Client): Promise<Client> {
    const entry = await this.acquire(name, client)
    return entry.client
  }

  releaseClient(name: string, cwd: string): void {
    const key = this.getKey(name, cwd)
    this.release(key)
  }

  override status(): PoolStats {
    return super.status()
  }
}

export const MCPPool = new MCPProcessPool()
