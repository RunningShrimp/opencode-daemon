/**
 * Split Sync Context for better performance and maintainability
 * 
 * This module provides separated contexts for different data domains:
 * - ProvidersContext: provider, agent, command, config
 * - SessionContext: session, todo, permission, question
 * - MessagesContext: message, part
 * - SystemStatusContext: lsp, mcp, formatter, vcs, path
 * 
 * Each context can be used independently, reducing unnecessary re-renders.
 */

import type {
  Message,
  Agent,
  Provider,
  Session,
  Part,
  Config,
  Todo,
  Command,
  PermissionRequest,
  QuestionRequest,
  LspStatus,
  McpStatus,
  McpResource,
  FormatterStatus,
  SessionStatus,
  ProviderListResponse,
  ProviderAuthMethod,
  VcsInfo,
} from "@opencode-ai/sdk/v2"
import { createStore, produce, reconcile } from "solid-js/store"
import { useSDK } from "@tui/context/sdk"
import { Binary } from "@opencode-ai/util/binary"
import { createSimpleContext } from "./helper"
import type { Snapshot } from "@/snapshot"
import { useExit } from "./exit"
import { useArgs } from "./args"
import { batch, onMount, onCleanup, createContext, useContext, type ParentProps, type Accessor } from "solid-js"
import { Log } from "@/util/log"
import type { Path } from "@opencode-ai/sdk"

// ============================================================================
// Type Definitions
// ============================================================================

export type SyncStatus = "loading" | "partial" | "complete"

export interface ProvidersStore {
  status: SyncStatus
  provider: Provider[]
  provider_default: Record<string, string>
  provider_next: ProviderListResponse
  provider_auth: Record<string, ProviderAuthMethod[]>
  agent: Agent[]
  command: Command[]
  config: Config
}

export interface SessionStore {
  session: Session[]
  session_status: Record<string, SessionStatus>
  session_diff: Record<string, Snapshot.FileDiff[]>
  todo: Record<string, Todo[]>
  permission: Record<string, PermissionRequest[]>
  question: Record<string, QuestionRequest[]>
}

export interface MessagesStore {
  message: Record<string, Message[]>
  part: Record<string, Part[]>
}

export interface SystemStatusStore {
  lsp: LspStatus[]
  mcp: Record<string, McpStatus>
  mcp_resource: Record<string, McpResource>
  formatter: FormatterStatus[]
  vcs: VcsInfo | undefined
  path: Path
}

// ============================================================================
// Providers Context
// ============================================================================

export const ProvidersContext = createContext<{
  data: ProvidersStore
  set: ReturnType<typeof createStore<ProvidersStore>>[1]
  status: Accessor<SyncStatus>
  ready: Accessor<boolean>
}>()

export function ProvidersProvider(props: ParentProps & { children: any }) {
  const [store, setStore] = createStore<ProvidersStore>({
    status: "loading",
    provider: [],
    provider_default: {},
    provider_next: { all: [], default: {}, connected: [] },
    provider_auth: {},
    agent: [],
    command: [],
    config: {},
  })

  const value = {
    data: store,
    set: setStore,
    get status() { return store.status },
    get ready() { return store.status !== "loading" },
  }

  return (
    <ProvidersContext.Provider value={value}>
      {props.children}
    </ProvidersContext.Provider>
  )
}

export function useProviders() {
  const ctx = useContext(ProvidersContext)
  if (!ctx) throw new Error("useProviders must be used within ProvidersProvider")
  return ctx
}

// ============================================================================
// Session Context
// ============================================================================

export const SessionContext = createContext<{
  data: SessionStore
  set: ReturnType<typeof createStore<SessionStore>>[1]
  session: {
    get: (sessionID: string) => Session | undefined
    status: (sessionID: string) => string
    sync: (sessionID: string) => Promise<void>
  }
  permission: {
    get: (sessionID: string) => PermissionRequest[]
    reply: (sessionID: string, requestID: string) => void
    ask: (request: PermissionRequest) => void
  }
  question: {
    get: (sessionID: string) => QuestionRequest[]
    reply: (sessionID: string, requestID: string) => void
    ask: (request: QuestionRequest) => void
  }
}>()

export function SessionProvider(props: ParentProps & { children: any; sdk: any; bootstrap: () => Promise<void> }) {
  const [store, setStore] = createStore<SessionStore>({
    session: [],
    session_status: {},
    session_diff: {},
    todo: {},
    permission: {},
    question: {},
  })

  const fullSyncedSessions = new Set<string>()

  const value = {
    data: store,
    set: setStore,
    session: {
      get(sessionID: string) {
        const match = Binary.search(store.session, sessionID, (s) => s.id)
        return match.found ? store.session[match.index] : undefined
      },
      status(sessionID: string) {
        const session = value.session.get(sessionID)
        if (!session) return "idle"
        if (session.time.compacting) return "compacting"
        const messages = store.message[sessionID] ?? []
        const last = messages.at(-1)
        if (!last) return "idle"
        if (last.role === "user") return "working"
        return last.time.completed ? "idle" : "working"
      },
      async sync(sessionID: string) {
        if (fullSyncedSessions.has(sessionID)) return
        const [session, messages, todo, diff] = await Promise.all([
          props.sdk.client.session.get({ sessionID }, { throwOnError: true }),
          props.sdk.client.session.messages({ sessionID, limit: 100 }),
          props.sdk.client.session.todo({ sessionID }),
          props.sdk.client.session.diff({ sessionID }),
        ])
        setStore(produce((draft) => {
          const match = Binary.search(draft.session, sessionID, (s) => s.id)
          if (match.found) draft.session[match.index] = session.data!
          if (!match.found) draft.session.splice(match.index, 0, session.data!)
          draft.todo[sessionID] = todo.data ?? []
          draft.message[sessionID] = messages.data!.map((x) => x.info)
          for (const message of messages.data!) {
            draft.part[message.info.id] = message.parts
          }
          draft.session_diff[sessionID] = diff.data ?? []
        }))
        fullSyncedSessions.add(sessionID)
      },
    },
    permission: {
      get(sessionID: string) {
        return store.permission[sessionID] ?? []
      },
      reply(sessionID: string, requestID: string) {
        const requests = store.permission[sessionID]
        if (!requests) return
        const match = Binary.search(requests, requestID, (r) => r.id)
        if (!match.found) return
        setStore("permission", sessionID, produce((draft) => {
          draft.splice(match.index, 1)
        }))
      },
      ask(request: PermissionRequest) {
        const requests = store.permission[request.sessionID]
        if (!requests) {
          setStore("permission", request.sessionID, [request])
          return
        }
        const match = Binary.search(requests, request.id, (r) => r.id)
        if (match.found) {
          setStore("permission", request.sessionID, match.index, reconcile(request))
        } else {
          setStore("permission", request.sessionID, produce((draft) => {
            draft.splice(match.index, 0, request)
          }))
        }
      },
    },
    question: {
      get(sessionID: string) {
        return store.question[sessionID] ?? []
      },
      reply(sessionID: string, requestID: string) {
        const requests = store.question[sessionID]
        if (!requests) return
        const match = Binary.search(requests, requestID, (r) => r.id)
        if (!match.found) return
        setStore("question", sessionID, produce((draft) => {
          draft.splice(match.index, 1)
        }))
      },
      ask(request: QuestionRequest) {
        const requests = store.question[request.sessionID]
        if (!requests) {
          setStore("question", request.sessionID, [request])
          return
        }
        const match = Binary.search(requests, request.id, (r) => r.id)
        if (match.found) {
          setStore("question", request.sessionID, match.index, reconcile(request))
        } else {
          setStore("question", request.sessionID, produce((draft) => {
            draft.splice(match.index, 0, request)
          }))
        }
      },
    },
  }

  // 保存事件监听器的取消订阅函数
  let unlisten: (() => void) | undefined

  // Listen to session-related events
  unlisten = props.sdk.event.listen((e: any) => {
    const event = e.details
    switch (event.type) {
      case "permission.replied":
        value.permission.reply(event.properties.sessionID, event.properties.requestID)
        break
      case "permission.asked":
        value.permission.ask(event.properties)
        break
      case "question.replied":
      case "question.rejected":
        value.question.reply(event.properties.sessionID, event.properties.requestID)
        break
      case "question.asked":
        value.question.ask(event.properties)
        break
      case "todo.updated":
        setStore("todo", event.properties.sessionID, event.properties.todos)
        break
      case "session.diff":
        setStore("session_diff", event.properties.sessionID, event.properties.diff)
        break
      case "session.deleted": {
        const result = Binary.search(store.session, event.properties.info.id, (s) => s.id)
        if (result.found) {
          setStore("session", produce((draft) => { draft.splice(result.index, 1) }))
        }
        break
      }
      case "session.updated": {
        const result = Binary.search(store.session, event.properties.info.id, (s) => s.id)
        if (result.found) {
          setStore("session", result.index, reconcile(event.properties.info))
        } else {
          setStore("session", produce((draft) => { draft.splice(result.index, 0, event.properties.info) }))
        }
        break
      }
      case "session.status":
        setStore("session_status", event.properties.sessionID, event.properties.status)
        break
    }
  })

  // 组件卸载时清理事件监听器
  onCleanup(() => {
    if (unlisten) {
      unlisten()
    }
  })

  return (
    <SessionContext.Provider value={value}>
      {props.children}
    </SessionContext.Provider>
  )
}

// ============================================================================
// Messages Context
// ============================================================================

export const MessagesContext = createContext<{
  data: MessagesStore
  set: ReturnType<typeof createStore<MessagesStore>>[1]
}>()

export function MessagesProvider(props: ParentProps & { children: any; sdk: any }) {
  const [store, setStore] = createStore<MessagesStore>({
    message: {},
    part: {},
  })

  // 保存事件监听器的取消订阅函数
  let unlisten: (() => void) | undefined

  // Listen to message-related events
  unlisten = props.sdk.event.listen((e: any) => {
    const event = e.details
    switch (event.type) {
      case "message.updated": {
        const messages = store.message[event.properties.info.sessionID]
        if (!messages) {
          setStore("message", event.properties.info.sessionID, [event.properties.info])
          break
        }
        const result = Binary.search(messages, event.properties.info.id, (m) => m.id)
        if (result.found) {
          setStore("message", event.properties.info.sessionID, result.index, reconcile(event.properties.info))
        } else {
          setStore("message", event.properties.info.sessionID, produce((draft) => {
            draft.splice(result.index, 0, event.properties.info)
          }))
        }
        const updated = store.message[event.properties.info.sessionID]
        if (updated.length > 100) {
          const oldest = updated[0]
          batch(() => {
            setStore("message", event.properties.info.sessionID, produce((draft) => { draft.shift() }))
            setStore("part", produce((draft) => { delete draft[oldest.id] }))
          })
        }
        break
      }
      case "message.removed": {
        const messages = store.message[event.properties.sessionID]
        const result = Binary.search(messages, event.properties.messageID, (m) => m.id)
        if (result.found) {
          setStore("message", event.properties.sessionID, produce((draft) => {
            draft.splice(result.index, 1)
          }))
        }
        break
      }
      case "message.part.updated": {
        const parts = store.part[event.properties.part.messageID]
        if (!parts) {
          setStore("part", event.properties.part.messageID, [event.properties.part])
          break
        }
        const result = Binary.search(parts, event.properties.part.id, (p) => p.id)
        if (result.found) {
          setStore("part", event.properties.part.messageID, result.index, reconcile(event.properties.part))
        } else {
          setStore("part", event.properties.part.messageID, produce((draft) => {
            draft.splice(result.index, 0, event.properties.part)
          }))
        }
        break
      }
      case "message.part.delta": {
        const parts = store.part[event.properties.messageID]
        if (!parts) break
        const result = Binary.search(parts, event.properties.partID, (p) => p.id)
        if (!result.found) break
        setStore("part", event.properties.messageID, produce((draft) => {
          const part = draft[result.index]
          const field = event.properties.field as keyof typeof part
          const existing = part[field] as string | undefined
          ;(part[field] as string) = (existing ?? "") + event.properties.delta
        }))
        break
      }
      case "message.part.removed": {
        const parts = store.part[event.properties.messageID]
        const result = Binary.search(parts, event.properties.partID, (p) => p.id)
        if (result.found) {
          setStore("part", event.properties.messageID, produce((draft) => {
            draft.splice(result.index, 1)
          }))
        }
        break
      }
    }
  })

  // 组件卸载时清理事件监听器
  onCleanup(() => {
    if (unlisten) {
      unlisten()
    }
  })

  return (
    <MessagesContext.Provider value={{ data: store, set: setStore }}>
      {props.children}
    </MessagesContext.Provider>
  )
}

// ============================================================================
// System Status Context
// ============================================================================

export const SystemStatusContext = createContext<{
  data: SystemStatusStore
  set: ReturnType<typeof createStore<SystemStatusStore>>[1]
}>()

export function SystemStatusProvider(props: ParentProps & { children: any; sdk: any }) {
  const [store, setStore] = createStore<SystemStatusStore>({
    lsp: [],
    mcp: {},
    mcp_resource: {},
    formatter: [],
    vcs: undefined,
    path: { state: "", config: "", worktree: "", directory: "" },
  })

  // 保存事件监听器的取消订阅函数
  let unlisten: (() => void) | undefined

  // Listen to system status events
  unlisten = props.sdk.event.listen((e: any) => {
    const event = e.details
    switch (event.type) {
      case "lsp.updated":
        props.sdk.client.lsp.status().then((x: any) => setStore("lsp", x.data!))
        break
      case "vcs.branch.updated":
        setStore("vcs", { branch: event.properties.branch })
        break
    }
  })

  // 组件卸载时清理事件监听器
  onCleanup(() => {
    if (unlisten) {
      unlisten()
    }
  })

  return (
    <SystemStatusContext.Provider value={{ data: store, set: setStore }}>
      {props.children}
    </SystemStatusContext.Provider>
  )
}

// ============================================================================
// Main Sync Context (Backward Compatible)
// ============================================================================

export type SyncContextValue = {
  data: ProvidersStore & SessionStore & MessagesStore & SystemStatusStore
  set: any
  status: Accessor<SyncStatus>
  ready: Accessor<boolean>
  session: {
    get: (sessionID: string) => Session | undefined
    status: (sessionID: string) => string
    sync: (sessionID: string) => Promise<void>
  }
  bootstrap: () => Promise<void>
}

export const { use: useSync, provider: SyncProvider } = createSimpleContext({
  name: "Sync",
  init: () => {
    const [store, setStore] = createStore<ProvidersStore & SessionStore & MessagesStore & SystemStatusStore>({
      // Providers
      status: "loading" as SyncStatus,
      provider: [],
      provider_default: {},
      provider_next: { all: [], default: {}, connected: [] },
      provider_auth: {},
      agent: [],
      command: [],
      config: {},
      // Session
      session: [],
      session_status: {},
      session_diff: {},
      todo: {},
      permission: {},
      question: {},
      // Messages
      message: {},
      part: {},
      // System Status
      lsp: [],
      mcp: {},
      mcp_resource: {},
      formatter: [],
      vcs: undefined,
      path: { state: "", config: "", worktree: "", directory: "" },
    })

    const sdk = useSDK()
    const exit = useExit()
    const args = useArgs()
    const fullSyncedSessions = new Set<string>()

    // 保存事件监听器的取消订阅函数
    let unlisten: (() => void) | undefined

    // Unified event handler
    unlisten = sdk.event.listen((e) => {
      const event = e.details
      switch (event.type) {
        case "server.instance.disposed":
          bootstrap()
          break
        // Permission events
        case "permission.replied": {
          const requests = store.permission[event.properties.sessionID]
          if (!requests) break
          const match = Binary.search(requests, event.properties.requestID, (r) => r.id)
          if (!match.found) break
          setStore("permission", event.properties.sessionID, produce((draft) => { draft.splice(match.index, 1) }))
          break
        }
        case "permission.asked": {
          const request = event.properties
          const requests = store.permission[request.sessionID]
          if (!requests) {
            setStore("permission", request.sessionID, [request])
            break
          }
          const match = Binary.search(requests, request.id, (r) => r.id)
          if (match.found) {
            setStore("permission", request.sessionID, match.index, reconcile(request))
          } else {
            setStore("permission", request.sessionID, produce((draft) => { draft.splice(match.index, 0, request) }))
          }
          break
        }
        // Question events
        case "question.replied":
        case "question.rejected": {
          const requests = store.question[event.properties.sessionID]
          if (!requests) break
          const match = Binary.search(requests, event.properties.requestID, (r) => r.id)
          if (!match.found) break
          setStore("question", event.properties.sessionID, produce((draft) => { draft.splice(match.index, 1) }))
          break
        }
        case "question.asked": {
          const request = event.properties
          const requests = store.question[request.sessionID]
          if (!requests) {
            setStore("question", request.sessionID, [request])
            break
          }
          const match = Binary.search(requests, request.id, (r) => r.id)
          if (match.found) {
            setStore("question", request.sessionID, match.index, reconcile(request))
          } else {
            setStore("question", request.sessionID, produce((draft) => { draft.splice(match.index, 0, request) }))
          }
          break
        }
        // Todo events
        case "todo.updated":
          setStore("todo", event.properties.sessionID, event.properties.todos)
          break
        // Session events
        case "session.diff":
          setStore("session_diff", event.properties.sessionID, event.properties.diff)
          break
        case "session.deleted": {
          const result = Binary.search(store.session, event.properties.info.id, (s) => s.id)
          if (result.found) {
            setStore("session", produce((draft) => { draft.splice(result.index, 1) }))
          }
          break
        }
        case "session.updated": {
          const result = Binary.search(store.session, event.properties.info.id, (s) => s.id)
          if (result.found) {
            setStore("session", result.index, reconcile(event.properties.info))
          } else {
            setStore("session", produce((draft) => { draft.splice(result.index, 0, event.properties.info) }))
          }
          break
        }
        case "session.status":
          setStore("session_status", event.properties.sessionID, event.properties.status)
          break
        // Message events
        case "message.updated": {
          const messages = store.message[event.properties.info.sessionID]
          if (!messages) {
            setStore("message", event.properties.info.sessionID, [event.properties.info])
            break
          }
          const result = Binary.search(messages, event.properties.info.id, (m) => m.id)
          if (result.found) {
            setStore("message", event.properties.info.sessionID, result.index, reconcile(event.properties.info))
          } else {
            setStore("message", event.properties.info.sessionID, produce((draft) => { draft.splice(result.index, 0, event.properties.info) }))
          }
          const updated = store.message[event.properties.info.sessionID]
          if (updated.length > 100) {
            const oldest = updated[0]
            batch(() => {
              setStore("message", event.properties.info.sessionID, produce((draft) => { draft.shift() }))
              setStore("part", produce((draft) => { delete draft[oldest.id] }))
            })
          }
          break
        }
        case "message.removed": {
          const messages = store.message[event.properties.sessionID]
          const result = Binary.search(messages, event.properties.messageID, (m) => m.id)
          if (result.found) {
            setStore("message", event.properties.sessionID, produce((draft) => { draft.splice(result.index, 1) }))
          }
          break
        }
        case "message.part.updated": {
          const parts = store.part[event.properties.part.messageID]
          if (!parts) {
            setStore("part", event.properties.part.messageID, [event.properties.part])
            break
          }
          const result = Binary.search(parts, event.properties.part.id, (p) => p.id)
          if (result.found) {
            setStore("part", event.properties.part.messageID, result.index, reconcile(event.properties.part))
          } else {
            setStore("part", event.properties.part.messageID, produce((draft) => { draft.splice(result.index, 0, event.properties.part) }))
          }
          break
        }
        case "message.part.delta": {
          const parts = store.part[event.properties.messageID]
          if (!parts) break
          const result = Binary.search(parts, event.properties.partID, (p) => p.id)
          if (!result.found) break
          setStore("part", event.properties.messageID, produce((draft) => {
            const part = draft[result.index]
            const field = event.properties.field as keyof typeof part
            const existing = part[field] as string | undefined
            ;(part[field] as string) = (existing ?? "") + event.properties.delta
          }))
          break
        }
        case "message.part.removed": {
          const parts = store.part[event.properties.messageID]
          const result = Binary.search(parts, event.properties.partID, (p) => p.id)
          if (result.found) {
            setStore("part", event.properties.messageID, produce((draft) => { draft.splice(result.index, 1) }))
          }
          break
        }
        // System status events
        case "lsp.updated":
          sdk.client.lsp.status().then((x) => setStore("lsp", x.data!))
          break
        case "vcs.branch.updated":
          setStore("vcs", { branch: event.properties.branch })
          break
      }
    })

    async function bootstrap() {
      const start = Date.now() - 30 * 24 * 60 * 60 * 1000
      const sessionListPromise = sdk.client.session
        .list({ start: start })
        .then((x) => (x.data ?? []).toSorted((a, b) => a.id.localeCompare(b.id)))

      const providersPromise = sdk.client.config.providers({}, { throwOnError: true })
      const providerListPromise = sdk.client.provider.list({}, { throwOnError: true })
      const agentsPromise = sdk.client.app.agents({}, { throwOnError: true })
      const configPromise = sdk.client.config.get({}, { throwOnError: true })
      const blockingRequests: Promise<unknown>[] = [
        providersPromise,
        providerListPromise,
        agentsPromise,
        configPromise,
        ...(args.continue ? [sessionListPromise] : []),
      ]

      await Promise.all(blockingRequests)
        .then(() => {
          const providersResponse = providersPromise.then((x) => x.data!)
          const providerListResponse = providerListPromise.then((x) => x.data!)
          const agentsResponse = agentsPromise.then((x) => x.data ?? [])
          const configResponse = configPromise.then((x) => x.data!)
          const sessionListResponse = args.continue ? sessionListPromise : undefined

          return Promise.all([
            providersResponse,
            providerListResponse,
            agentsResponse,
            configResponse,
            ...(sessionListResponse ? [sessionListResponse] : []),
          ]).then((responses) => {
            const providers = responses[0]
            const providerList = responses[1]
            const agents = responses[2]
            const config = responses[3]
            const sessions = responses[4]

            batch(() => {
              setStore("provider", reconcile(providers.providers))
              setStore("provider_default", reconcile(providers.default))
              setStore("provider_next", reconcile(providerList))
              setStore("agent", reconcile(agents))
              setStore("config", reconcile(config))
              if (sessions !== undefined) setStore("session", reconcile(sessions))
            })
          })
        })
        .then(() => {
          if (store.status !== "complete") setStore("status", "partial")
          Promise.all([
            ...(args.continue ? [] : [sessionListPromise.then((sessions) => setStore("session", reconcile(sessions)))]),
            sdk.client.command.list().then((x) => setStore("command", reconcile(x.data ?? []))),
            sdk.client.lsp.status().then((x) => setStore("lsp", reconcile(x.data!))),
            sdk.client.mcp.status().then((x) => setStore("mcp", reconcile(x.data!))),
            sdk.client.experimental.resource.list().then((x) => setStore("mcp_resource", reconcile(x.data ?? {}))),
            sdk.client.formatter.status().then((x) => setStore("formatter", reconcile(x.data!))),
            sdk.client.session.status().then((x) => setStore("session_status", reconcile(x.data!))),
            sdk.client.provider.auth().then((x) => setStore("provider_auth", reconcile(x.data ?? {}))),
            sdk.client.vcs.get().then((x) => setStore("vcs", reconcile(x.data))),
            sdk.client.path.get().then((x) => setStore("path", reconcile(x.data!))),
          ]).then(() => {
            setStore("status", "complete")
          })
        })
        .catch(async (e) => {
          Log.Default.error("tui bootstrap failed", {
            error: e instanceof Error ? e.message : String(e),
            name: e instanceof Error ? e.name : undefined,
            stack: e instanceof Error ? e.stack : undefined,
          })
          await exit(e)
        })
    }

    onMount(() => {
      bootstrap()
    })

    // 组件卸载时清理事件监听器
    onCleanup(() => {
      if (unlisten) {
        unlisten()
      }
    })

    const result: SyncContextValue = {
      data: store,
      set: setStore,
      get status() { return store.status },
      get ready() { return store.status !== "loading" },
      session: {
        get(sessionID: string) {
          const match = Binary.search(store.session, sessionID, (s) => s.id)
          return match.found ? store.session[match.index] : undefined
        },
        status(sessionID: string) {
          const session = result.session.get(sessionID)
          if (!session) return "idle"
          if (session.time.compacting) return "compacting"
          const messages = store.message[sessionID] ?? []
          const last = messages.at(-1)
          if (!last) return "idle"
          if (last.role === "user") return "working"
          return last.time.completed ? "idle" : "working"
        },
        async sync(sessionID: string) {
          if (fullSyncedSessions.has(sessionID)) return
          const [session, messages, todo, diff] = await Promise.all([
            sdk.client.session.get({ sessionID }, { throwOnError: true }),
            sdk.client.session.messages({ sessionID, limit: 100 }),
            sdk.client.session.todo({ sessionID }),
            sdk.client.session.diff({ sessionID }),
          ])
          setStore(produce((draft) => {
            const match = Binary.search(draft.session, sessionID, (s) => s.id)
            if (match.found) draft.session[match.index] = session.data!
            if (!match.found) draft.session.splice(match.index, 0, session.data!)
            draft.todo[sessionID] = todo.data ?? []
            draft.message[sessionID] = messages.data!.map((x) => x.info)
            for (const message of messages.data!) {
              draft.part[message.info.id] = message.parts
            }
            draft.session_diff[sessionID] = diff.data ?? []
          }))
          fullSyncedSessions.add(sessionID)
        },
      },
      bootstrap,
    }
    return result
  },
})
