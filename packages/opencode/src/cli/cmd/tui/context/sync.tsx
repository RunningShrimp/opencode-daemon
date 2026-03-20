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
import { batch, onMount } from "solid-js"
import { Log } from "@/util/log"
import type { Path } from "@opencode-ai/sdk"
import type { Workspace } from "@opencode-ai/sdk/v2"
import {
  consumePreloadedSessionHistoryPage,
  getSessionHistoryHasMore,
  mergeSessionHistoryPage,
  type PreloadedSessionHistoryPage,
} from "./sync-history"

type KnowledgeGraphSidebarRelation = {
  relation: string
  targetName: string
  targetType: string
}

type KnowledgeGraphSidebarNode = {
  id: string
  name: string
  type: string
  path?: string
  accessCount: number
  tags: string[]
  related: KnowledgeGraphSidebarRelation[]
}

type KnowledgeGraphSidebarSnapshot = {
  stats: {
    nodeCount: number
    edgeCount: number
    typeBreakdown: Record<string, number>
  }
  relevant: KnowledgeGraphSidebarNode[]
  groups: Array<{
    type: string
    count: number
    nodes: KnowledgeGraphSidebarNode[]
  }>
  refreshedAt: number
}

const SESSION_MESSAGE_WINDOW = 40
const SESSION_HISTORY_PRELOAD_PAGES = 2

type SessionHistoryState = {
  nextCursor?: string
  hasMore: boolean
  loading: boolean
  preloading: boolean
  window: number
  preloadedPages: PreloadedSessionHistoryPage[]
}

function shouldCapSessionMessages(session?: Session) {
  return !session?.revert?.messageID
}

function textFromParts(parts: Part[]) {
  return parts
    .filter((part): part is Extract<Part, { type: "text" }> => part.type === "text")
    .map((part) => part.text)
    .join("\n")
    .trim()
}

function lastUserQueryFromStore(messages: Message[] = [], partsByMessage: Record<string, Part[]> = {}) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== "user") continue
    const text = textFromParts(partsByMessage[message.id] ?? [])
    if (text) return text
  }
  return undefined
}

function lastUserQueryFromDetailedMessages(messages: Array<{ info: Message; parts: Part[] }>) {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.info.role !== "user") continue
    const text = textFromParts(message.parts)
    if (text) return text
  }
  return undefined
}

export const { use: useSync, provider: SyncProvider } = createSimpleContext({
  name: "Sync",
  init: () => {
    const [store, setStore] = createStore<{
      status: "loading" | "partial" | "complete"
      provider: Provider[]
      provider_default: Record<string, string>
      provider_next: ProviderListResponse
      provider_auth: Record<string, ProviderAuthMethod[]>
      agent: Agent[]
      command: Command[]
      permission: {
        [sessionID: string]: PermissionRequest[]
      }
      question: {
        [sessionID: string]: QuestionRequest[]
      }
      config: Config
      session: Session[]
      session_status: {
        [sessionID: string]: SessionStatus
      }
      session_diff: {
        [sessionID: string]: Snapshot.FileDiff[]
      }
      todo: {
        [sessionID: string]: Todo[]
      }
      session_history: {
        [sessionID: string]: SessionHistoryState | undefined
      }
      message: {
        [sessionID: string]: Message[]
      }
      part: {
        [messageID: string]: Part[]
      }
      lsp: LspStatus[]
      mcp: {
        [key: string]: McpStatus
      }
      mcp_resource: {
        [key: string]: McpResource
      }
      formatter: FormatterStatus[]
      vcs: VcsInfo | undefined
      path: Path
      workspaceList: Workspace[]
      knowledge_graph: {
        [sessionID: string]: KnowledgeGraphSidebarSnapshot | undefined
      }
    }>({
      provider_next: {
        all: [],
        default: {},
        connected: [],
      },
      provider_auth: {},
      config: {},
      status: "loading",
      agent: [],
      permission: {},
      question: {},
      command: [],
      provider: [],
      provider_default: {},
      session: [],
      session_status: {},
      session_diff: {},
      todo: {},
      session_history: {},
      message: {},
      part: {},
      lsp: [],
      mcp: {},
      mcp_resource: {},
      formatter: [],
      vcs: undefined,
      path: { state: "", config: "", worktree: "", directory: "" },
      workspaceList: [],
      knowledge_graph: {},
    })

    const sdk = useSDK()

    async function syncKnowledgeGraph(sessionID: string, query?: string) {
      const session = store.session.find((item) => item.id === sessionID)
      if (!session) return

      const url = new URL("/experimental/knowledge", sdk.url)
      const resolvedQuery = query ?? lastUserQueryFromStore(store.message[sessionID], store.part)
      if (resolvedQuery) url.searchParams.set("query", resolvedQuery.slice(0, 240))

      const response = await sdk.fetch(url, {
        headers: {
          "x-opencode-directory": session.directory,
          ...(session.workspaceID ? { "x-opencode-workspace": session.workspaceID } : {}),
        },
      }).catch(() => undefined)

      if (!response?.ok) return
      const data = (await response.json().catch(() => undefined)) as KnowledgeGraphSidebarSnapshot | undefined
      if (!data) return
      setStore("knowledge_graph", sessionID, reconcile(data))
    }

    async function syncWorkspaces() {
      const result = await sdk.client.experimental.workspace.list().catch(() => undefined)
      if (!result?.data) return
      setStore("workspaceList", reconcile(result.data))
    }

    async function prefetchSessionHistory(sessionID: string, input: { nextCursor: string; window: number }) {
      let nextCursor: string | undefined = input.nextCursor
      const preloadedPages: PreloadedSessionHistoryPage[] = []

      try {
        while (nextCursor && preloadedPages.length < SESSION_HISTORY_PRELOAD_PAGES) {
          const response: Awaited<ReturnType<typeof sdk.client.session.messages>> | undefined = await sdk.client.session
            .messages({
              sessionID,
              limit: input.window,
              before: nextCursor,
            })
            .catch(() => undefined)

          if (!response?.data) break

          preloadedPages.push(response.data)
          nextCursor = response.response.headers.get("x-next-cursor") ?? undefined
        }
      } finally {
        setStore(
          produce((draft) => {
            const history = draft.session_history[sessionID]
            if (!history) return
            history.preloadedPages.push(...preloadedPages)
            history.preloading = false
            history.nextCursor = nextCursor
            history.hasMore = getSessionHistoryHasMore({
              preloadedPages: history.preloadedPages,
              nextCursor: history.nextCursor,
            })
          }),
        )
      }
    }

    sdk.event.listen((e) => {
      const event = e.details
      switch (event.type) {
        case "server.instance.disposed":
          bootstrap()
          break
        case "permission.replied": {
          const requests = store.permission[event.properties.sessionID]
          if (!requests) break
          const match = Binary.search(requests, event.properties.requestID, (r) => r.id)
          if (!match.found) break
          setStore(
            "permission",
            event.properties.sessionID,
            produce((draft) => {
              draft.splice(match.index, 1)
            }),
          )
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
            break
          }
          setStore(
            "permission",
            request.sessionID,
            produce((draft) => {
              draft.splice(match.index, 0, request)
            }),
          )
          break
        }

        case "question.replied":
        case "question.rejected": {
          const requests = store.question[event.properties.sessionID]
          if (!requests) break
          const match = Binary.search(requests, event.properties.requestID, (r) => r.id)
          if (!match.found) break
          setStore(
            "question",
            event.properties.sessionID,
            produce((draft) => {
              draft.splice(match.index, 1)
            }),
          )
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
            break
          }
          setStore(
            "question",
            request.sessionID,
            produce((draft) => {
              draft.splice(match.index, 0, request)
            }),
          )
          break
        }

        case "todo.updated":
          setStore("todo", event.properties.sessionID, event.properties.todos)
          break

        case "session.diff":
          setStore("session_diff", event.properties.sessionID, event.properties.diff)
          break

        case "session.deleted": {
          const result = Binary.search(store.session, event.properties.info.id, (s) => s.id)
          if (result.found) {
            setStore(
              "session",
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          }
          break
        }
        case "session.updated": {
          const result = Binary.search(store.session, event.properties.info.id, (s) => s.id)
          if (result.found) {
            setStore("session", result.index, reconcile(event.properties.info))
            break
          }
          setStore(
            "session",
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.info)
            }),
          )
          break
        }

        case "session.status": {
          setStore("session_status", event.properties.sessionID, event.properties.status)
          break
        }

        case "message.updated": {
          const messages = store.message[event.properties.info.sessionID]
          if (!messages) {
            setStore("message", event.properties.info.sessionID, [event.properties.info])
            break
          }
          const result = Binary.search(messages, event.properties.info.id, (m) => m.id)
          if (result.found) {
            setStore("message", event.properties.info.sessionID, result.index, reconcile(event.properties.info))
            break
          }
          setStore(
            "message",
            event.properties.info.sessionID,
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.info)
            }),
          )
          const updated = store.message[event.properties.info.sessionID]
          const session = store.session.find((item) => item.id === event.properties.info.sessionID)
          const history = store.session_history[event.properties.info.sessionID]
          const messageWindow = history?.window ?? SESSION_MESSAGE_WINDOW
          if (updated.length > messageWindow && shouldCapSessionMessages(session)) {
            const oldest = updated[0]
            batch(() => {
              setStore(
                "message",
                event.properties.info.sessionID,
                produce((draft) => {
                  draft.shift()
                }),
              )
              setStore(
                "part",
                produce((draft) => {
                  delete draft[oldest.id]
                }),
              )
            })
          }
          break
        }
        case "message.removed": {
          const messages = store.message[event.properties.sessionID]
          const result = Binary.search(messages, event.properties.messageID, (m) => m.id)
          if (result.found) {
            setStore(
              "message",
              event.properties.sessionID,
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
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
            break
          }
          setStore(
            "part",
            event.properties.part.messageID,
            produce((draft) => {
              draft.splice(result.index, 0, event.properties.part)
            }),
          )
          break
        }

        case "message.part.delta": {
          let parts = store.part[event.properties.messageID]
          if (!parts) {
            setStore("part", event.properties.messageID, [])
            parts = []
          }
          const result = Binary.search(parts, event.properties.partID, (p) => p.id)
          if (!result.found) {
            setStore(
              "part",
              event.properties.messageID,
              produce((draft) => {
                const placeholder: Part = {
                  id: event.properties.partID,
                  messageID: event.properties.messageID,
                  sessionID: event.properties.sessionID,
                  type: "text",
                  text: event.properties.delta,
                }
                draft.splice(result.index, 0, placeholder)
              }),
            )
            break
          }
          setStore(
            "part",
            event.properties.messageID,
            produce((draft) => {
              const part = draft[result.index]
              const field = event.properties.field as keyof typeof part
              const existing = part[field] as string | undefined
              ;(part[field] as string) = (existing ?? "") + event.properties.delta
            }),
          )
          break
        }

        case "message.part.removed": {
          const parts = store.part[event.properties.messageID]
          const result = Binary.search(parts, event.properties.partID, (p) => p.id)
          if (result.found)
            setStore(
              "part",
              event.properties.messageID,
              produce((draft) => {
                draft.splice(result.index, 1)
              }),
            )
          break
        }

        case "lsp.updated": {
          sdk.client.lsp.status().then((x) => setStore("lsp", x.data!))
          break
        }

        case "vcs.branch.updated": {
          setStore("vcs", { branch: event.properties.branch })
          break
        }
      }
    })

    const exit = useExit()
    const args = useArgs()

    async function bootstrap() {
      const start = Date.now() - 30 * 24 * 60 * 60 * 1000
      const sessionListPromise = sdk.client.session
        .list({ start: start })
        .then((x) => (x.data ?? []).toSorted((a, b) => a.id.localeCompare(b.id)))

      // blocking - include session.list when continuing a session
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
          // non-blocking
          Promise.all([
            ...(args.continue ? [] : [sessionListPromise.then((sessions) => setStore("session", reconcile(sessions)))]),
            sdk.client.command.list().then((x) => setStore("command", reconcile(x.data ?? []))),
            sdk.client.lsp.status().then((x) => setStore("lsp", reconcile(x.data!))),
            sdk.client.mcp.status().then((x) => setStore("mcp", reconcile(x.data!))),
            sdk.client.experimental.resource.list().then((x) => setStore("mcp_resource", reconcile(x.data ?? {}))),
            sdk.client.formatter.status().then((x) => setStore("formatter", reconcile(x.data!))),
            sdk.client.session.status().then((x) => {
              setStore("session_status", reconcile(x.data!))
            }),
            sdk.client.provider.auth().then((x) => setStore("provider_auth", reconcile(x.data ?? {}))),
            sdk.client.vcs.get().then((x) => setStore("vcs", reconcile(x.data))),
            sdk.client.path.get().then((x) => setStore("path", reconcile(x.data!))),
            syncWorkspaces(),
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

    const fullSyncedSessions = new Set<string>()
    const result = {
      data: store,
      set: setStore,
      get status() {
        return store.status
      },
      get ready() {
        return store.status !== "loading"
      },
      session: {
        get(sessionID: string) {
          const match = Binary.search(store.session, sessionID, (s) => s.id)
          if (match.found) return store.session[match.index]
          return undefined
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

          const session = await sdk.client.session.get({ sessionID }, { throwOnError: true })
          const messageLimit = shouldCapSessionMessages(session.data) ? SESSION_MESSAGE_WINDOW : undefined
          const messages = await sdk.client.session.messages({ sessionID, limit: messageLimit })
          const nextCursor = messages.response.headers.get("x-next-cursor") ?? undefined
          const todoPromise = sdk.client.session.todo({ sessionID })
          const diffPromise = sdk.client.session.diff({ sessionID })
          setStore(
            produce((draft) => {
              const match = Binary.search(draft.session, sessionID, (s) => s.id)
              if (match.found) draft.session[match.index] = session.data!
              if (!match.found) draft.session.splice(match.index, 0, session.data!)
              const msgs = messages.data ?? []
              draft.message[sessionID] = msgs.map((x) => x.info)
              draft.session_history[sessionID] = {
                nextCursor,
                hasMore: !!nextCursor,
                loading: false,
                preloading: false,
                window: messageLimit ?? Number.MAX_SAFE_INTEGER,
                preloadedPages: [],
              }
              for (const message of msgs) {
                draft.part[message.info.id] = message.parts
              }
            }),
          )
          fullSyncedSessions.add(sessionID)
          if (typeof messageLimit === "number" && nextCursor) {
            setStore("session_history", sessionID, "preloading", true)
            void prefetchSessionHistory(sessionID, {
              nextCursor,
              window: messageLimit,
            })
          }
          void Promise.allSettled([todoPromise, diffPromise, syncKnowledgeGraph(sessionID, lastUserQueryFromDetailedMessages(messages.data ?? []))]).then(
            (results) => {
              const todo = results[0].status === "fulfilled" ? results[0].value.data ?? [] : undefined
              const diff = results[1].status === "fulfilled" ? results[1].value.data ?? [] : undefined
              batch(() => {
                if (todo) setStore("todo", sessionID, todo)
                if (diff) setStore("session_diff", sessionID, diff)
              })
            },
          )
        },
        async loadMore(sessionID: string) {
          const history = store.session_history[sessionID]
          if (!history || history.loading || history.preloading || !history.hasMore) return

          if (history.preloadedPages.length > 0) {
            setStore(
              produce((draft) => {
                const currentHistory = draft.session_history[sessionID]
                if (!currentHistory) return
                const consumed = consumePreloadedSessionHistoryPage({
                  existingMessages: draft.message[sessionID] ?? [],
                  preloadedPages: currentHistory.preloadedPages,
                  nextCursor: currentHistory.nextCursor,
                })
                if (!consumed) return
                for (const [messageID, parts] of Object.entries(consumed.parts)) {
                  draft.part[messageID] = parts
                }
                draft.message[sessionID] = consumed.messages
                draft.session_history[sessionID] = {
                  ...currentHistory,
                  hasMore: consumed.hasMore,
                  preloadedPages: consumed.preloadedPages,
                }
              }),
            )
            return
          }

          if (!history.nextCursor) return

          setStore("session_history", sessionID, "loading", true)
          const response = await sdk.client.session
            .messages({
              sessionID,
              limit: Number.isFinite(history.window) ? history.window : SESSION_MESSAGE_WINDOW,
              before: history.nextCursor,
            })
            .catch(() => undefined)

          if (!response?.data) {
            setStore("session_history", sessionID, "loading", false)
            return
          }

          const nextCursor = response.response.headers.get("x-next-cursor") ?? undefined
          setStore(
            produce((draft) => {
              const merged = mergeSessionHistoryPage({
                existingMessages: draft.message[sessionID] ?? [],
                incomingMessages: response.data ?? [],
              })
              for (const [messageID, parts] of Object.entries(merged.parts)) {
                draft.part[messageID] = parts
              }
              draft.message[sessionID] = merged.messages
              const currentHistory = draft.session_history[sessionID]
              draft.session_history[sessionID] = {
                nextCursor,
                hasMore: getSessionHistoryHasMore({
                  preloadedPages: currentHistory?.preloadedPages ?? [],
                  nextCursor,
                }),
                loading: false,
                preloading: currentHistory?.preloading ?? false,
                window: history.window,
                preloadedPages: currentHistory?.preloadedPages ?? [],
              }
            }),
          )
        },
        refreshKnowledgeGraph: syncKnowledgeGraph,
      },
      workspace: {
        get(workspaceID: string) {
          return store.workspaceList.find((workspace) => workspace.id === workspaceID)
        },
        sync: syncWorkspaces,
      },
      bootstrap,
    }
    return result
  },
})
