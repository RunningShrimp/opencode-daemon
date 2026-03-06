import { dynamicTool, type Tool, jsonSchema, type JSONSchema7 } from "ai"
import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js"
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js"
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js"
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js"
import {
  CallToolResultSchema,
  type Tool as MCPToolDef,
  ToolListChangedNotificationSchema,
} from "@modelcontextprotocol/sdk/types.js"
import { Config } from "../config/config"
import { Log } from "../util/log"
import { NamedError } from "@opencode-ai/util/error"
import z from "zod/v4"
import { Instance } from "../project/instance"
import { Installation } from "../installation"
import { withTimeout } from "@/util/timeout"
import { McpOAuthProvider } from "./oauth-provider"
import { McpOAuthCallback } from "./oauth-callback"
import { McpAuth } from "./auth"
import { BusEvent } from "../bus/bus-event"
import { Bus } from "@/bus"
import { TuiEvent } from "@/cli/cmd/tui/event"
import open from "open"

// ============================================================================
// MCP Performance Optimization: Local vs Remote Specific
// ============================================================================

// Local MCP: Process pool and keep-alive management
interface LocalMCPProcess {
  client: Client
  serverName: string
  createdAt: number
  lastUsed: number
  useCount: number
}

class LocalMCPProcessPool {
  private processes = new Map<string, LocalMCPProcess>()
  private config = {
    maxProcesses: 5,
    idleTimeoutMs: 5 * 60 * 1000, // 5 minutes
    maxUsesPerProcess: 100,
  }

  async acquire(serverName: string, factory: () => Promise<Client>): Promise<Client> {
    const key = serverName

    // Check for available process
    const existing = this.processes.get(key)
    if (existing) {
      const now = Date.now()

      // Check if process is still healthy and within limits
      if (
        now - existing.lastUsed < this.config.idleTimeoutMs &&
        existing.useCount < this.config.maxUsesPerProcess
      ) {
        existing.lastUsed = now
        existing.useCount++
        return existing.client
      } else {
        // Close old process
        try {
          await existing.client.close()
        } catch {}
        this.processes.delete(key)
      }
    }

    // Create new process if under limit
    if (this.processes.size >= this.config.maxProcesses) {
      // Close oldest process
      let oldest: LocalMCPProcess | undefined
      let oldestTime = Infinity
      for (const [k, p] of this.processes) {
        if (p.lastUsed < oldestTime) {
          oldestTime = p.lastUsed
          oldest = p
        }
      }
      if (oldest) {
        try {
          await oldest.client.close()
        } catch {}
        this.processes.delete(oldest.serverName)
      }
    }

    // Create new process
    const client = await factory()
    this.processes.set(key, {
      client,
      serverName,
      createdAt: Date.now(),
      lastUsed: Date.now(),
      useCount: 1,
    })

    return client
  }

  async release(serverName: string): Promise<void> {
    // Local MCP processes are kept alive for reuse
  }

  async close(serverName: string): Promise<void> {
    const process = this.processes.get(serverName)
    if (process) {
      try {
        await process.client.close()
      } catch {}
      this.processes.delete(serverName)
    }
  }

  async closeAll(): Promise<void> {
    for (const [key, process] of this.processes) {
      try {
        await process.client.close()
      } catch {}
    }
    this.processes.clear()
  }

  getStats() {
    return {
      activeProcesses: this.processes.size,
      maxProcesses: this.config.maxProcesses,
    }
  }
}

const localProcessPool = new LocalMCPProcessPool()

// Remote MCP: Connection pool and HTTP optimization
interface RemoteMCPConnection {
  client: Client
  serverName: string
  createdAt: number
  lastUsed: number
  requestCount: number
}

class RemoteMCPConnectionPool {
  private connections = new Map<string, RemoteMCPConnection>()
  private pending = new Map<string, Promise<Client>>()
  private config = {
    maxConnectionsPerServer: 3,
    idleTimeoutMs: 2 * 60 * 1000, // 2 minutes
    maxRequestsPerConnection: 50,
  }

  async acquire(
    serverName: string,
    url: string,
    factory: () => Promise<Client>,
  ): Promise<Client> {
    // Check if there's already a pending connection
    const pendingKey = `${serverName}:pending`
    const existingPending = this.pending.get(pendingKey)
    if (existingPending) {
      return existingPending
    }

    // Check for available connection
    const existing = this.connections.get(serverName)
    if (existing) {
      const now = Date.now()

      if (
        now - existing.lastUsed < this.config.idleTimeoutMs &&
        existing.requestCount < this.config.maxRequestsPerConnection
      ) {
        existing.lastUsed = now
        existing.requestCount++
        return existing.client
      } else {
        try {
          await existing.client.close()
        } catch {}
        this.connections.delete(serverName)
      }
    }

    // Create new connection with pending tracking
    const createConnection = async (): Promise<Client> => {
      const client = await factory()
      this.connections.set(serverName, {
        client,
        serverName,
        createdAt: Date.now(),
        lastUsed: Date.now(),
        requestCount: 1,
      })
      this.pending.delete(pendingKey)
      return client
    }

    this.pending.set(pendingKey, createConnection())

    try {
      return await this.pending.get(pendingKey)!
    } catch (error) {
      this.pending.delete(pendingKey)
      throw error
    }
  }

  async close(serverName: string): Promise<void> {
    const connection = this.connections.get(serverName)
    if (connection) {
      try {
        await connection.client.close()
      } catch {}
      this.connections.delete(serverName)
    }
  }

  async closeAll(): Promise<void> {
    for (const [key, conn] of this.connections) {
      try {
        await conn.client.close()
      } catch {}
    }
    this.connections.clear()
    this.pending.clear()
  }

  getStats() {
    return {
      activeConnections: this.connections.size,
      pendingConnections: this.pending.size,
      maxPerServer: this.config.maxConnectionsPerServer,
    }
  }
}

const remoteConnectionPool = new RemoteMCPConnectionPool()

// Server-type specific retry strategies
const RETRY_STRATEGIES = {
  local: {
    maxAttempts: 2,
    baseDelayMs: 50, // Fast retry for local
    maxDelayMs: 500,
    backoffMultiplier: 2,
  },
  remote: {
    maxAttempts: 3,
    baseDelayMs: 200, // Slower for remote
    maxDelayMs: 5000,
    backoffMultiplier: 2,
  },
}

// Circuit breaker for local vs remote
enum CircuitState {
  CLOSED = "closed",
  OPEN = "open",
  HALF_OPEN = "half_open",
}

class MCPCircuitBreaker {
  private state = CircuitState.CLOSED
  private failures = 0
  private successes = 0
  private nextAttempt = 0

  constructor(
    private failureThreshold: number,
    private successThreshold: number,
    private timeout: number,
  ) {}

  async execute<T>(operation: () => Promise<T>): Promise<T> {
    if (this.state === CircuitState.OPEN) {
      if (Date.now() < this.nextAttempt) {
        throw new Error("Circuit breaker is OPEN")
      }
      this.state = CircuitState.HALF_OPEN
      this.successes = 0
    }

    try {
      const result = await operation()
      this.onSuccess()
      return result
    } catch (error) {
      this.onFailure()
      throw error
    }
  }

  private onSuccess(): void {
    this.failures = 0
    if (this.state === CircuitState.HALF_OPEN) {
      this.successes++
      if (this.successes >= this.successThreshold) {
        this.state = CircuitState.CLOSED
      }
    }
  }

  private onFailure(): void {
    this.failures++
    if (this.state === CircuitState.HALF_OPEN) {
      this.state = CircuitState.OPEN
      this.nextAttempt = Date.now() + this.timeout
    } else if (this.failures >= this.failureThreshold) {
      this.state = CircuitState.OPEN
      this.nextAttempt = Date.now() + this.timeout
    }
  }

  getState(): CircuitState {
    return this.state
  }

  reset(): void {
    this.state = CircuitState.CLOSED
    this.failures = 0
    this.successes = 0
  }
}

// Circuit breakers per server with type-specific config
const circuitBreakers = new Map<string, MCPCircuitBreaker>()

function getCircuitBreaker(serverName: string, serverType: "local" | "remote"): MCPCircuitBreaker {
  const key = `${serverName}:${serverType}`
  let cb = circuitBreakers.get(key)

  if (!cb) {
    const strategy = RETRY_STRATEGIES[serverType]
    cb = new MCPCircuitBreaker(
      serverType === "local" ? 3 : 5, // Local more tolerant
      2,
      serverType === "local" ? 10_000 : 30_000, // Local 10s, Remote 30s
    )
    circuitBreakers.set(key, cb)
  }

  return cb
}

// Retry with type-specific strategy
async function mcpRetry<T>(
  operation: () => Promise<T>,
  serverType: "local" | "remote",
  customStrategy?: Partial<typeof RETRY_STRATEGIES.local>,
): Promise<T> {
  const strategy = { ...RETRY_STRATEGIES[serverType], ...customStrategy }
  let lastError: Error | undefined

  for (let attempt = 1; attempt <= strategy.maxAttempts; attempt++) {
    try {
      return await operation()
    } catch (error) {
      lastError = error as Error

      if (attempt === strategy.maxAttempts) {
        throw lastError
      }

      const delay = Math.min(
        strategy.baseDelayMs * Math.pow(strategy.backoffMultiplier, attempt - 1),
        strategy.maxDelayMs,
      )

      await new Promise((resolve) => setTimeout(resolve, delay))
    }
  }

  throw lastError
}

export namespace MCP {
  const log = Log.create({ service: "mcp" })
  const DEFAULT_TIMEOUT = 30_000

  export const Resource = z
    .object({
      name: z.string(),
      uri: z.string(),
      description: z.string().optional(),
      mimeType: z.string().optional(),
      client: z.string(),
    })
    .meta({ ref: "McpResource" })
  export type Resource = z.infer<typeof Resource>

  export const ToolsChanged = BusEvent.define(
    "mcp.tools.changed",
    z.object({
      server: z.string(),
    }),
  )

  export const BrowserOpenFailed = BusEvent.define(
    "mcp.browser.open.failed",
    z.object({
      mcpName: z.string(),
      url: z.string(),
    }),
  )

  export const Failed = NamedError.create(
    "MCPFailed",
    z.object({
      name: z.string(),
    }),
  )

  type MCPClient = Client

  export const Status = z
    .discriminatedUnion("status", [
      z
        .object({
          status: z.literal("connected"),
        })
        .meta({
          ref: "MCPStatusConnected",
        }),
      z
        .object({
          status: z.literal("disabled"),
        })
        .meta({
          ref: "MCPStatusDisabled",
        }),
      z
        .object({
          status: z.literal("failed"),
          error: z.string(),
        })
        .meta({
          ref: "MCPStatusFailed",
        }),
      z
        .object({
          status: z.literal("needs_auth"),
        })
        .meta({
          ref: "MCPStatusNeedsAuth",
        }),
      z
        .object({
          status: z.literal("needs_client_registration"),
          error: z.string(),
        })
        .meta({
          ref: "MCPStatusNeedsClientRegistration",
        }),
    ])
    .meta({
      ref: "MCPStatus",
    })
  export type Status = z.infer<typeof Status>

  // Register notification handlers for MCP client
  function registerNotificationHandlers(client: MCPClient, serverName: string) {
    client.setNotificationHandler(ToolListChangedNotificationSchema, async () => {
      log.info("tools list changed notification received", { server: serverName })
      Bus.publish(ToolsChanged, { server: serverName })
    })
  }

  // Convert MCP tool definition to AI SDK Tool type
  // Uses DEFAULT_TIMEOUT as fallback when no timeout is provided
  const TOOL_DEFAULT_TIMEOUT = 30_000 // 30 seconds

  async function convertMcpTool(
    mcpTool: MCPToolDef,
    client: MCPClient,
    serverType: "local" | "remote",
    timeout?: number,
  ): Promise<Tool> {
    // Use provided timeout or fall back to default
    const effectiveTimeout = timeout ?? TOOL_DEFAULT_TIMEOUT

    const inputSchema = mcpTool.inputSchema

    // Spread first, then override type to ensure it's always "object"
    const schema: JSONSchema7 = {
      ...(inputSchema as JSONSchema7),
      type: "object",
      properties: (inputSchema.properties ?? {}) as JSONSchema7["properties"],
      additionalProperties: false,
    }

    // Get circuit breaker for this server type
    const circuitBreaker = getCircuitBreaker("tool", serverType)

    return dynamicTool({
      description: mcpTool.description ?? "",
      inputSchema: jsonSchema(schema),
      execute: async (args: unknown) => {
        return await circuitBreaker.execute(async () => {
          return await mcpRetry(
            async () => {
              return await client.callTool(
                {
                  name: mcpTool.name,
                  arguments: (args || {}) as Record<string, unknown>,
                },
                CallToolResultSchema,
                {
                  resetTimeoutOnProgress: true,
                  timeout: effectiveTimeout, // Use the effective timeout
                },
              )
            },
            serverType,
          )
        })
      },
    })
  }

  // Store transports for OAuth servers to allow finishing auth
  type TransportWithAuth = StreamableHTTPClientTransport | SSEClientTransport
  const pendingOAuthTransports = new Map<string, TransportWithAuth>()

  // Prompt cache types
  type PromptInfo = Awaited<ReturnType<MCPClient["listPrompts"]>>["prompts"][number]

  type ResourceInfo = Awaited<ReturnType<MCPClient["listResources"]>>["resources"][number]
  type McpEntry = NonNullable<Config.Info["mcp"]>[string]
  function isMcpConfigured(entry: McpEntry): entry is Config.Mcp {
    return typeof entry === "object" && entry !== null && "type" in entry
  }

  async function descendants(pid: number): Promise<number[]> {
    if (process.platform === "win32") return []
    const pids: number[] = []
    const queue = [pid]
    while (queue.length > 0) {
      const current = queue.shift()!
      const proc = Bun.spawn(["pgrep", "-P", String(current)], { stdout: "pipe", stderr: "pipe" })
      const [code, out] = await Promise.all([proc.exited, new Response(proc.stdout).text()]).catch(
        () => [-1, ""] as const,
      )
      if (code !== 0) continue
      for (const tok of out.trim().split(/\s+/)) {
        const cpid = parseInt(tok, 10)
        if (!isNaN(cpid) && pids.indexOf(cpid) === -1) {
          pids.push(cpid)
          queue.push(cpid)
        }
      }
    }
    return pids
  }

  const state = Instance.state(
    async () => {
      const cfg = await Config.get()
      const config = cfg.mcp ?? {}
      const clients: Record<string, MCPClient> = {}
      const status: Record<string, Status> = {}

      await Promise.all(
        Object.entries(config).map(async ([key, mcp]) => {
          if (!isMcpConfigured(mcp)) {
            log.error("Ignoring MCP config entry without type", { key })
            return
          }

          // If disabled by config, mark as disabled without trying to connect
          if (mcp.enabled === false) {
            status[key] = { status: "disabled" }
            return
          }

          const result = await create(key, mcp).catch(() => undefined)
          if (!result) return

          status[key] = result.status

          if (result.mcpClient) {
            clients[key] = result.mcpClient
          }
        }),
      )
      return {
        status,
        clients,
      }
    },
    async (state) => {
      // The MCP SDK only signals the direct child process on close.
      // Servers like chrome-devtools-mcp spawn grandchild processes
      // (e.g. Chrome) that the SDK never reaches, leaving them orphaned.
      // Kill the full descendant tree first so the server exits promptly
      // and no processes are left behind.
      for (const client of Object.values(state.clients)) {
        const pid = (client.transport as any)?.pid
        if (typeof pid !== "number") continue
        for (const dpid of await descendants(pid)) {
          try {
            process.kill(dpid, "SIGTERM")
          } catch {}
        }
      }

      await Promise.all(
        Object.values(state.clients).map((client) =>
          client.close().catch((error) => {
            log.error("Failed to close MCP client", {
              error,
            })
          }),
        ),
      )
      pendingOAuthTransports.clear()
    },
  )

  // Helper function to fetch prompts for a specific client
  async function fetchPromptsForClient(clientName: string, client: Client) {
    const prompts = await client.listPrompts().catch((e) => {
      log.error("failed to get prompts", { clientName, error: e.message })
      return undefined
    })

    if (!prompts) {
      return
    }

    const commands: Record<string, PromptInfo & { client: string }> = {}

    for (const prompt of prompts.prompts) {
      const sanitizedClientName = clientName.replace(/[^a-zA-Z0-9_-]/g, "_")
      const sanitizedPromptName = prompt.name.replace(/[^a-zA-Z0-9_-]/g, "_")
      const key = sanitizedClientName + ":" + sanitizedPromptName

      commands[key] = { ...prompt, client: clientName }
    }
    return commands
  }

  async function fetchResourcesForClient(clientName: string, client: Client) {
    const resources = await client.listResources().catch((e) => {
      log.error("failed to get prompts", { clientName, error: e.message })
      return undefined
    })

    if (!resources) {
      return
    }

    const commands: Record<string, ResourceInfo & { client: string }> = {}

    for (const resource of resources.resources) {
      const sanitizedClientName = clientName.replace(/[^a-zA-Z0-9_-]/g, "_")
      const sanitizedResourceName = resource.name.replace(/[^a-zA-Z0-9_-]/g, "_")
      const key = sanitizedClientName + ":" + sanitizedResourceName

      commands[key] = { ...resource, client: clientName }
    }
    return commands
  }

  export async function add(name: string, mcp: Config.Mcp) {
    const s = await state()
    const result = await create(name, mcp)
    if (!result) {
      const status = {
        status: "failed" as const,
        error: "unknown error",
      }
      s.status[name] = status
      return {
        status,
      }
    }
    if (!result.mcpClient) {
      s.status[name] = result.status
      return {
        status: s.status,
      }
    }
    // Close existing client if present to prevent memory leaks
    const existingClient = s.clients[name]
    if (existingClient) {
      await existingClient.close().catch((error) => {
        log.error("Failed to close existing MCP client", { name, error })
      })
    }
    s.clients[name] = result.mcpClient
    s.status[name] = result.status

    return {
      status: s.status,
    }
  }

  async function create(key: string, mcp: Config.Mcp) {
    if (mcp.enabled === false) {
      log.info("mcp server disabled", { key })
      return {
        mcpClient: undefined,
        status: { status: "disabled" as const },
      }
    }

    log.info("found", { key, type: mcp.type })
    let mcpClient: MCPClient | undefined
    let status: Status | undefined = undefined

    if (mcp.type === "remote") {
      // OAuth is enabled by default for remote servers unless explicitly disabled with oauth: false
      const oauthDisabled = mcp.oauth === false
      const oauthConfig = typeof mcp.oauth === "object" ? mcp.oauth : undefined
      let authProvider: McpOAuthProvider | undefined

      if (!oauthDisabled) {
        authProvider = new McpOAuthProvider(
          key,
          mcp.url,
          {
            clientId: oauthConfig?.clientId,
            clientSecret: oauthConfig?.clientSecret,
            scope: oauthConfig?.scope,
          },
          {
            onRedirect: async (url) => {
              log.info("oauth redirect requested", { key, url: url.toString() })
            },
          },
        )
      }

      // Use connection pool for remote MCP
      try {
        mcpClient = await remoteConnectionPool.acquire(
          key,
          mcp.url,
          async () => {
            const transports: Array<{ name: string; transport: TransportWithAuth }> = [
              {
                name: "StreamableHTTP",
                transport: new StreamableHTTPClientTransport(new URL(mcp.url), {
                  authProvider,
                  requestInit: mcp.headers ? { headers: mcp.headers } : undefined,
                }),
              },
              {
                name: "SSE",
                transport: new SSEClientTransport(new URL(mcp.url), {
                  authProvider,
                  requestInit: mcp.headers ? { headers: mcp.headers } : undefined,
                }),
              },
            ]

            let lastError: Error | undefined
            const connectTimeout = mcp.timeout ?? DEFAULT_TIMEOUT

            for (const { name, transport } of transports) {
              try {
                const client = new Client({
                  name: "opencode",
                  version: Installation.VERSION,
                })
                await withTimeout(client.connect(transport), connectTimeout)
                registerNotificationHandlers(client, key)
                log.info("connected via pool", { key, transport: name })
                return client
              } catch (error) {
                lastError = error instanceof Error ? error : new Error(String(error))

                if (error instanceof UnauthorizedError) {
                  if (lastError.message.includes("registration") || lastError.message.includes("client_id")) {
                    status = {
                      status: "needs_client_registration" as const,
                      error: "Server does not support dynamic client registration.",
                    }
                    Bus.publish(TuiEvent.ToastShow, {
                      title: "MCP Authentication Required",
                      message: `Server "${key}" requires a pre-registered client ID.`,
                      variant: "warning",
                      duration: 8000,
                    }).catch((e) => log.debug("failed to show toast", { error: e }))
                  } else {
                    pendingOAuthTransports.set(key, transport)
                    status = { status: "needs_auth" as const }
                    Bus.publish(TuiEvent.ToastShow, {
                      title: "MCP Authentication Required",
                      message: `Server "${key}" requires authentication.`,
                      variant: "warning",
                      duration: 8000,
                    }).catch((e) => log.debug("failed to show toast", { error: e }))
                  }
                  break
                }

                log.debug("transport connection failed", { key, transport: name, error: lastError.message })
              }
            }

            throw lastError || new Error("All transports failed")
          },
        )

        if (mcpClient) {
          status = { status: "connected" }
          log.info("connected via connection pool", { key })
        }
      } catch (error) {
        log.error("remote mcp connection failed", { key, error })
        status = {
          status: "failed" as const,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }

    if (mcp.type === "local") {
      // Use process pool for local MCP
      try {
        mcpClient = await localProcessPool.acquire(key, async () => {
          const [cmd, ...args] = mcp.command
          const cwd = Instance.directory
          const transport = new StdioClientTransport({
            stderr: "pipe",
            command: cmd,
            args,
            cwd,
            env: {
              ...process.env,
              ...(cmd === "opencode" ? { BUN_BE_BUN: "1" } : {}),
              ...mcp.environment,
            },
          })
          transport.stderr?.on("data", (chunk: Buffer) => {
            log.info(`mcp stderr: ${chunk.toString()}`, { key })
          })

          const connectTimeout = mcp.timeout ?? DEFAULT_TIMEOUT
          const client = new Client({
            name: "opencode",
            version: Installation.VERSION,
          })
          await withTimeout(client.connect(transport), connectTimeout)
          registerNotificationHandlers(client, key)
          log.info("local mcp connected via pool", { key })
          return client
        })

        if (mcpClient) {
          status = { status: "connected" }
          log.info("acquired local mcp from pool", { key })
        }
      } catch (error) {
        log.error("local mcp process pool failed", {
          key,
          command: mcp.command,
          error: error instanceof Error ? error.message : String(error),
        })
        status = {
          status: "failed" as const,
          error: error instanceof Error ? error.message : String(error),
        }
      }
    }

    if (!status) {
      status = {
        status: "failed" as const,
        error: "Unknown error",
      }
    }

    if (!mcpClient) {
      return {
        mcpClient: undefined,
        status,
      }
    }

    // 为 listTools 使用更短的超时时间（最多 10 秒）
    const LIST_TOOLS_TIMEOUT = Math.min((mcp.timeout ?? DEFAULT_TIMEOUT), 10000)
    const result = await withTimeout(mcpClient.listTools(), LIST_TOOLS_TIMEOUT).catch((err) => {
      log.error("failed to get tools from client", { key, error: err })
      return undefined
    })
    if (!result) {
      await mcpClient.close().catch((error) => {
        log.error("Failed to close MCP client", {
          error,
        })
      })
      status = {
        status: "failed",
        error: "Failed to get tools",
      }
      return {
        mcpClient: undefined,
        status: {
          status: "failed" as const,
          error: "Failed to get tools",
        },
      }
    }

    log.info("create() successfully created client", { key, toolCount: result.tools.length })
    return {
      mcpClient,
      status,
    }
  }

  export async function status() {
    const s = await state()
    const cfg = await Config.get()
    const config = cfg.mcp ?? {}
    const result: Record<string, Status> = {}

    // Include all configured MCPs from config, not just connected ones
    for (const [key, mcp] of Object.entries(config)) {
      if (!isMcpConfigured(mcp)) continue
      result[key] = s.status[key] ?? { status: "disabled" }
    }

    return result
  }

  export async function clients() {
    return state().then((state) => state.clients)
  }

  export async function connect(name: string) {
    const cfg = await Config.get()
    const config = cfg.mcp ?? {}
    const mcp = config[name]
    if (!mcp) {
      log.error("MCP config not found", { name })
      return
    }

    if (!isMcpConfigured(mcp)) {
      log.error("Ignoring MCP connect request for config without type", { name })
      return
    }

    const result = await create(name, { ...mcp, enabled: true })

    if (!result) {
      const s = await state()
      s.status[name] = {
        status: "failed",
        error: "Unknown error during connection",
      }
      return
    }

    const s = await state()
    s.status[name] = result.status
    if (result.mcpClient) {
      // Close existing client if present to prevent memory leaks
      const existingClient = s.clients[name]
      if (existingClient) {
        await existingClient.close().catch((error) => {
          log.error("Failed to close existing MCP client", { name, error })
        })
      }
      s.clients[name] = result.mcpClient
    }
  }

  export async function disconnect(name: string) {
    const s = await state()
    const client = s.clients[name]
    if (client) {
      await client.close().catch((error) => {
        log.error("Failed to close MCP client", { name, error })
      })
      delete s.clients[name]
    }
    s.status[name] = { status: "disabled" }
  }

  export async function tools() {
    const result: Record<string, Tool> = {}
    const s = await state()
    const cfg = await Config.get()
    const config = cfg.mcp ?? {}
    const clientsSnapshot = await clients()
    const defaultTimeout = cfg.experimental?.mcp_timeout

    const connectedClients = Object.entries(clientsSnapshot).filter(
      ([clientName]) => s.status[clientName]?.status === "connected",
    )

    const toolsResults = await Promise.all(
      connectedClients.map(async ([clientName, client]) => {
        const toolsResult = await client.listTools().catch((e) => {
          log.error("failed to get tools", { clientName, error: e.message })
          const failedStatus = {
            status: "failed" as const,
            error: e instanceof Error ? e.message : String(e),
          }
          s.status[clientName] = failedStatus
          delete s.clients[clientName]
          return undefined
        })
        return { clientName, client, toolsResult }
      }),
    )

    for (const { clientName, client, toolsResult } of toolsResults) {
      if (!toolsResult) continue
      const mcpConfig = config[clientName]
      const entry = isMcpConfigured(mcpConfig) ? mcpConfig : undefined
      const timeout = entry?.timeout ?? defaultTimeout
      const serverType = entry?.type === "remote" ? "remote" : "local"

      for (const mcpTool of toolsResult.tools) {
        const sanitizedClientName = clientName.replace(/[^a-zA-Z0-9_-]/g, "_")
        const sanitizedToolName = mcpTool.name.replace(/[^a-zA-Z0-9_-]/g, "_")
        result[sanitizedClientName + "_" + sanitizedToolName] = await convertMcpTool(
          mcpTool,
          client,
          serverType,
          timeout,
        )
      }
    }
    return result
  }

  export async function prompts() {
    const s = await state()
    const clientsSnapshot = await clients()

    const prompts = Object.fromEntries<PromptInfo & { client: string }>(
      (
        await Promise.all(
          Object.entries(clientsSnapshot).map(async ([clientName, client]) => {
            if (s.status[clientName]?.status !== "connected") {
              return []
            }

            return Object.entries((await fetchPromptsForClient(clientName, client)) ?? {})
          }),
        )
      ).flat(),
    )

    return prompts
  }

  export async function resources() {
    const s = await state()
    const clientsSnapshot = await clients()

    const result = Object.fromEntries<ResourceInfo & { client: string }>(
      (
        await Promise.all(
          Object.entries(clientsSnapshot).map(async ([clientName, client]) => {
            if (s.status[clientName]?.status !== "connected") {
              return []
            }

            return Object.entries((await fetchResourcesForClient(clientName, client)) ?? {})
          }),
        )
      ).flat(),
    )

    return result
  }

  export async function getPrompt(clientName: string, name: string, args?: Record<string, string>) {
    const clientsSnapshot = await clients()
    const client = clientsSnapshot[clientName]

    if (!client) {
      log.warn("client not found for prompt", {
        clientName,
      })
      return undefined
    }

    const result = await client
      .getPrompt({
        name: name,
        arguments: args,
      })
      .catch((e) => {
        log.error("failed to get prompt from MCP server", {
          clientName,
          promptName: name,
          error: e.message,
        })
        return undefined
      })

    return result
  }

  export async function readResource(clientName: string, resourceUri: string) {
    const clientsSnapshot = await clients()
    const client = clientsSnapshot[clientName]

    if (!client) {
      log.warn("client not found for prompt", {
        clientName: clientName,
      })
      return undefined
    }

    const result = await client
      .readResource({
        uri: resourceUri,
      })
      .catch((e) => {
        log.error("failed to get prompt from MCP server", {
          clientName: clientName,
          resourceUri: resourceUri,
          error: e.message,
        })
        return undefined
      })

    return result
  }

  /**
   * Start OAuth authentication flow for an MCP server.
   * Returns the authorization URL that should be opened in a browser.
   */
  export async function startAuth(mcpName: string): Promise<{ authorizationUrl: string }> {
    const cfg = await Config.get()
    const mcpConfig = cfg.mcp?.[mcpName]

    if (!mcpConfig) {
      throw new Error(`MCP server not found: ${mcpName}`)
    }

    if (!isMcpConfigured(mcpConfig)) {
      throw new Error(`MCP server ${mcpName} is disabled or missing configuration`)
    }

    if (mcpConfig.type !== "remote") {
      throw new Error(`MCP server ${mcpName} is not a remote server`)
    }

    if (mcpConfig.oauth === false) {
      throw new Error(`MCP server ${mcpName} has OAuth explicitly disabled`)
    }

    // Start the callback server
    await McpOAuthCallback.ensureRunning()

    // Generate and store a cryptographically secure state parameter BEFORE creating the provider
    // The SDK will call provider.state() to read this value
    const oauthState = Array.from(crypto.getRandomValues(new Uint8Array(32)))
      .map((b) => b.toString(16).padStart(2, "0"))
      .join("")
    await McpAuth.updateOAuthState(mcpName, oauthState)

    // Create a new auth provider for this flow
    // OAuth config is optional - if not provided, we'll use auto-discovery
    const oauthConfig = typeof mcpConfig.oauth === "object" ? mcpConfig.oauth : undefined
    let capturedUrl: URL | undefined
    const authProvider = new McpOAuthProvider(
      mcpName,
      mcpConfig.url,
      {
        clientId: oauthConfig?.clientId,
        clientSecret: oauthConfig?.clientSecret,
        scope: oauthConfig?.scope,
      },
      {
        onRedirect: async (url) => {
          capturedUrl = url
        },
      },
    )

    // Create transport with auth provider
    const transport = new StreamableHTTPClientTransport(new URL(mcpConfig.url), {
      authProvider,
    })

    // Try to connect - this will trigger the OAuth flow
    try {
      const client = new Client({
        name: "opencode",
        version: Installation.VERSION,
      })
      await client.connect(transport)
      // If we get here, we're already authenticated
      return { authorizationUrl: "" }
    } catch (error) {
      if (error instanceof UnauthorizedError && capturedUrl) {
        // Store transport for finishAuth
        pendingOAuthTransports.set(mcpName, transport)
        return { authorizationUrl: capturedUrl.toString() }
      }
      throw error
    }
  }

  /**
   * Complete OAuth authentication after user authorizes in browser.
   * Opens the browser and waits for callback.
   */
  export async function authenticate(mcpName: string): Promise<Status> {
    const { authorizationUrl } = await startAuth(mcpName)

    if (!authorizationUrl) {
      // Already authenticated
      const s = await state()
      return s.status[mcpName] ?? { status: "connected" }
    }

    // Get the state that was already generated and stored in startAuth()
    const oauthState = await McpAuth.getOAuthState(mcpName)
    if (!oauthState) {
      throw new Error("OAuth state not found - this should not happen")
    }

    // The SDK has already added the state parameter to the authorization URL
    // We just need to open the browser
    log.info("opening browser for oauth", { mcpName, url: authorizationUrl, state: oauthState })

    // Register the callback BEFORE opening the browser to avoid race condition
    // when the IdP has an active SSO session and redirects immediately
    const callbackPromise = McpOAuthCallback.waitForCallback(oauthState)

    try {
      const subprocess = await open(authorizationUrl)
      // The open package spawns a detached process and returns immediately.
      // We need to listen for errors which fire asynchronously:
      // - "error" event: command not found (ENOENT)
      // - "exit" with non-zero code: command exists but failed (e.g., no display)
      await new Promise<void>((resolve, reject) => {
        // Give the process a moment to fail if it's going to
        const timeout = setTimeout(() => resolve(), 500)
        subprocess.on("error", (error) => {
          clearTimeout(timeout)
          reject(error)
        })
        subprocess.on("exit", (code) => {
          if (code !== null && code !== 0) {
            clearTimeout(timeout)
            reject(new Error(`Browser open failed with exit code ${code}`))
          }
        })
      })
    } catch (error) {
      // Browser opening failed (e.g., in remote/headless sessions like SSH, devcontainers)
      // Emit event so CLI can display the URL for manual opening
      log.warn("failed to open browser, user must open URL manually", { mcpName, error })
      Bus.publish(BrowserOpenFailed, { mcpName, url: authorizationUrl })
    }

    // Wait for callback using the already-registered promise
    const code = await callbackPromise

    // Validate and clear the state
    const storedState = await McpAuth.getOAuthState(mcpName)
    if (storedState !== oauthState) {
      await McpAuth.clearOAuthState(mcpName)
      throw new Error("OAuth state mismatch - potential CSRF attack")
    }

    await McpAuth.clearOAuthState(mcpName)

    // Finish auth
    return finishAuth(mcpName, code)
  }

  /**
   * Complete OAuth authentication with the authorization code.
   */
  export async function finishAuth(mcpName: string, authorizationCode: string): Promise<Status> {
    const transport = pendingOAuthTransports.get(mcpName)

    if (!transport) {
      throw new Error(`No pending OAuth flow for MCP server: ${mcpName}`)
    }

    try {
      // Call finishAuth on the transport
      await transport.finishAuth(authorizationCode)

      // Clear the code verifier after successful auth
      await McpAuth.clearCodeVerifier(mcpName)

      // Now try to reconnect
      const cfg = await Config.get()
      const mcpConfig = cfg.mcp?.[mcpName]

      if (!mcpConfig) {
        throw new Error(`MCP server not found: ${mcpName}`)
      }

      if (!isMcpConfigured(mcpConfig)) {
        throw new Error(`MCP server ${mcpName} is disabled or missing configuration`)
      }

      // Re-add the MCP server to establish connection
      pendingOAuthTransports.delete(mcpName)
      const result = await add(mcpName, mcpConfig)

      const statusRecord = result.status as Record<string, Status>
      return statusRecord[mcpName] ?? { status: "failed", error: "Unknown error after auth" }
    } catch (error) {
      log.error("failed to finish oauth", { mcpName, error })
      return {
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      }
    }
  }

  /**
   * Remove OAuth credentials for an MCP server.
   */
  export async function removeAuth(mcpName: string): Promise<void> {
    await McpAuth.remove(mcpName)
    McpOAuthCallback.cancelPending(mcpName)
    pendingOAuthTransports.delete(mcpName)
    await McpAuth.clearOAuthState(mcpName)
    log.info("removed oauth credentials", { mcpName })
  }

  /**
   * Check if an MCP server supports OAuth (remote servers support OAuth by default unless explicitly disabled).
   */
  export async function supportsOAuth(mcpName: string): Promise<boolean> {
    const cfg = await Config.get()
    const mcpConfig = cfg.mcp?.[mcpName]
    if (!mcpConfig) return false
    if (!isMcpConfigured(mcpConfig)) return false
    return mcpConfig.type === "remote" && mcpConfig.oauth !== false
  }

  /**
   * Check if an MCP server has stored OAuth tokens.
   */
  export async function hasStoredTokens(mcpName: string): Promise<boolean> {
    const entry = await McpAuth.get(mcpName)
    return !!entry?.tokens
  }

  export type AuthStatus = "authenticated" | "expired" | "not_authenticated"

  /**
   * Get the authentication status for an MCP server.
   */
  export async function getAuthStatus(mcpName: string): Promise<AuthStatus> {
    const hasTokens = await hasStoredTokens(mcpName)
    if (!hasTokens) return "not_authenticated"
    const expired = await McpAuth.isTokenExpired(mcpName)
    return expired ? "expired" : "authenticated"
  }

  /**
   * Get MCP optimization stats for monitoring
   */
  export function getOptimizationStats() {
    return {
      localProcessPool: localProcessPool.getStats(),
      remoteConnectionPool: remoteConnectionPool.getStats(),
      circuitBreakers: Object.fromEntries(
        Array.from(circuitBreakers.entries()).map(([key, cb]) => [key, cb.getState()]),
      ),
    }
  }

  /**
   * Close all MCP connections and processes
   */
  export async function closeAll(): Promise<void> {
    await localProcessPool.closeAll()
    await remoteConnectionPool.closeAll()
  }
}
