import { useSync } from "@tui/context/sync"
import { createEffect, createMemo, createSignal, For, Show, Switch, Match } from "solid-js"
import { createStore } from "solid-js/store"
import { useTheme } from "../../context/theme"
import { Installation } from "@/installation"
import { useDirectory } from "../../context/directory"
import { useKV } from "../../context/kv"
import { useRenderer } from "@opentui/solid"
import path from "node:path"
import { Editor } from "../../util/editor"
import { TodoItem } from "../../component/todo-item"

function humanizeLabel(value: string) {
  return value
    .split(/[_-]+/g)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(" ")
}

function clip(text: string | undefined, max = 88) {
  if (!text) return ""
  const normalized = text.replace(/\s+/g, " ").trim()
  if (normalized.length <= max) return normalized
  return normalized.slice(0, max - 1).trimEnd() + "…"
}

export function Sidebar(props: { sessionID: string; overlay?: boolean }) {
  const sync = useSync()
  const renderer = useRenderer()
  const { theme, syntax } = useTheme()
  const session = createMemo(() => sync.session.get(props.sessionID)!)
  const diff = createMemo(() => sync.data.session_diff[props.sessionID] ?? [])
  const messages = createMemo(() => sync.data.message[props.sessionID] ?? [])
  const todos = createMemo(() => sync.data.todo[props.sessionID] ?? [])
  const knowledgeGraph = createMemo(() => sync.data.knowledge_graph[props.sessionID])
  const [lastDiffClick, setLastDiffClick] = createSignal<{ file: string; at: number }>()

  const [expanded, setExpanded] = createStore({
    mcp: true,
    todo: true,
    diff: true,
    lsp: true,
    knowledge: true,
    knowledgeGroups: {} as Record<string, boolean>,
    knowledgeNodes: {} as Record<string, boolean>,
  })

  // Sort MCP servers alphabetically for consistent display order
  const mcpEntries = createMemo(() => Object.entries(sync.data.mcp).sort(([a], [b]) => a.localeCompare(b)))

  // Count connected and error MCP servers for collapsed header display
  const connectedMcpCount = createMemo(() => mcpEntries().filter(([_, item]) => item.status === "connected").length)
  const errorMcpCount = createMemo(
    () =>
      mcpEntries().filter(
        ([_, item]) =>
          item.status === "failed" || item.status === "needs_auth" || item.status === "needs_client_registration",
      ).length,
  )

  const directory = useDirectory()
  const kv = useKV()

  createEffect(() => {
    messages().length
    void sync.session.refreshKnowledgeGraph(props.sessionID)
  })

  async function openModifiedFileReview(file: string) {
    const current = diff().find((item) => item.file === file)
    if (!current) return
    const root = sync.data.path.worktree || session().directory
    const filepath = path.isAbsolute(file) ? file : path.resolve(root, file)
    await Editor.openDiff({
      filepath,
      before: current.before,
      after: current.after,
      renderer,
    })
  }

  function handleDiffRowClick(file: string) {
    const now = Date.now()
    const last = lastDiffClick()
    if (last?.file === file && now - last.at < 350) {
      void openModifiedFileReview(file)
    }
    setLastDiffClick({ file, at: now })
  }

  const hasProviders = createMemo(() =>
    sync.data.provider.some((x) => x.id !== "opencode" || Object.values(x.models).some((y) => y.cost?.input !== 0)),
  )
  const gettingStartedDismissed = createMemo(() => kv.get("dismissed_getting_started", false))

  return (
    <Show when={session()}>
      <box
        backgroundColor={theme.backgroundPanel}
        width={42}
        height="100%"
        paddingTop={1}
        paddingBottom={1}
        paddingLeft={2}
        paddingRight={2}
        position={props.overlay ? "absolute" : "relative"}
      >
        <scrollbox
          flexGrow={1}
          verticalScrollbarOptions={{
            trackOptions: {
              backgroundColor: theme.background,
              foregroundColor: theme.borderActive,
            },
          }}
        >
          <box flexShrink={0} gap={1} paddingRight={1}>
            <box paddingRight={1}>
              <text fg={theme.text}>
                <b>{session().title}</b>
              </text>
              <Show when={session().share?.url}>
                <text fg={theme.textMuted}>{session().share!.url}</text>
              </Show>
            </box>
            <Show when={mcpEntries().length > 0}>
              <box>
                <box
                  flexDirection="row"
                  gap={1}
                  onMouseDown={() => mcpEntries().length > 2 && setExpanded("mcp", !expanded.mcp)}
                >
                  <Show when={mcpEntries().length > 2}>
                    <text fg={theme.text}>{expanded.mcp ? "▼" : "▶"}</text>
                  </Show>
                  <text fg={theme.text}>
                    <b>MCP</b>
                    <Show when={!expanded.mcp}>
                      <span style={{ fg: theme.textMuted }}>
                        {" "}
                        ({connectedMcpCount()} active
                        {errorMcpCount() > 0 ? `, ${errorMcpCount()} error${errorMcpCount() > 1 ? "s" : ""}` : ""})
                      </span>
                    </Show>
                  </text>
                </box>
                <Show when={mcpEntries().length <= 2 || expanded.mcp}>
                  <For each={mcpEntries()}>
                    {([key, item]) => (
                      <box flexDirection="row" gap={1}>
                        <text
                          flexShrink={0}
                          style={{
                            fg: (
                              {
                                connected: theme.success,
                                failed: theme.error,
                                disabled: theme.textMuted,
                                needs_auth: theme.warning,
                                needs_client_registration: theme.error,
                              } as Record<string, typeof theme.success>
                            )[item.status],
                          }}
                        >
                          •
                        </text>
                        <text fg={theme.text} wrapMode="word">
                          {key}{" "}
                          <span style={{ fg: theme.textMuted }}>
                            <Switch fallback={item.status}>
                              <Match when={item.status === "connected"}>Connected</Match>
                              <Match when={item.status === "failed" && item}>{(val) => <i>{val().error}</i>}</Match>
                              <Match when={item.status === "disabled"}>Disabled</Match>
                              <Match when={(item.status as string) === "needs_auth"}>Needs auth</Match>
                              <Match when={(item.status as string) === "needs_client_registration"}>
                                Needs client ID
                              </Match>
                            </Switch>
                          </span>
                        </text>
                      </box>
                    )}
                  </For>
                </Show>
              </box>
            </Show>
            <box>
              <box
                flexDirection="row"
                gap={1}
                onMouseDown={() => sync.data.lsp.length > 2 && setExpanded("lsp", !expanded.lsp)}
              >
                <Show when={sync.data.lsp.length > 2}>
                  <text fg={theme.text}>{expanded.lsp ? "▼" : "▶"}</text>
                </Show>
                <text fg={theme.text}>
                  <b>LSP</b>
                </text>
              </box>
              <Show when={sync.data.lsp.length <= 2 || expanded.lsp}>
                <Show when={sync.data.lsp.length === 0}>
                  <text fg={theme.textMuted}>
                    {sync.data.config.lsp === false
                      ? "LSPs have been disabled in settings"
                      : "LSPs will activate as files are read"}
                  </text>
                </Show>
                <For each={sync.data.lsp}>
                  {(item) => (
                    <box flexDirection="row" gap={1}>
                      <text
                        flexShrink={0}
                        style={{
                          fg: {
                            connected: theme.success,
                            error: theme.error,
                          }[item.status],
                        }}
                      >
                        •
                      </text>
                      <text fg={theme.textMuted}>
                        {item.id} {item.root}
                      </text>
                    </box>
                  )}
                </For>
              </Show>
            </box>
            <Show when={todos().length > 0}>
              <box>
                <box
                  flexDirection="row"
                  gap={1}
                  onMouseDown={() => todos().length > 3 && setExpanded("todo", !expanded.todo)}
                >
                  <Show when={todos().length > 3}>
                    <text fg={theme.text}>{expanded.todo ? "▼" : "▶"}</text>
                  </Show>
                  <text fg={theme.text}>
                    <b>Todo</b>
                    <Show when={!expanded.todo}>
                      <span style={{ fg: theme.textMuted }}>
                        {` (${todos().filter((item) => item.status !== "completed").length} active)`}
                      </span>
                    </Show>
                  </text>
                </box>
                <Show when={todos().length <= 3 || expanded.todo}>
                  <For each={todos()}>{(todo) => <TodoItem status={todo.status} content={todo.content} />}</For>
                </Show>
              </box>
            </Show>
            <Show when={diff().length > 0}>
              <box>
                <box
                  flexDirection="row"
                  gap={1}
                  onMouseDown={() => diff().length > 2 && setExpanded("diff", !expanded.diff)}
                >
                  <Show when={diff().length > 2}>
                    <text fg={theme.text}>{expanded.diff ? "▼" : "▶"}</text>
                  </Show>
                  <text fg={theme.text}>
                    <b>Modified Files</b>
                  </text>
                </box>
                <Show when={diff().length <= 2 || expanded.diff}>
                  <text fg={theme.textMuted}>Double-click a file to review the diff in vim.</text>
                  <For each={diff() || []}>
                    {(item) => {
                      return (
                        <box flexDirection="row" gap={1} justifyContent="space-between" onMouseUp={() => handleDiffRowClick(item.file)}>
                          <text fg={theme.textMuted} wrapMode="none">
                            {item.file}
                          </text>
                          <box flexDirection="row" gap={1} flexShrink={0}>
                            <Show when={item.additions}>
                              <text fg={theme.diffAdded}>+{item.additions}</text>
                            </Show>
                            <Show when={item.deletions}>
                              <text fg={theme.diffRemoved}>-{item.deletions}</text>
                            </Show>
                          </box>
                        </box>
                      )
                    }}
                  </For>
                </Show>
              </box>
            </Show>
            <Show when={knowledgeGraph()}>
              <box>
                <box flexDirection="row" gap={1} onMouseDown={() => setExpanded("knowledge", !expanded.knowledge)}>
                  <text fg={theme.text}>{expanded.knowledge ? "▼" : "▶"}</text>
                  <text fg={theme.text}>
                    <b>Knowledge Graph</b>
                    <span style={{ fg: theme.textMuted }}>
                      {` ${knowledgeGraph()!.stats.nodeCount} nodes / ${knowledgeGraph()!.stats.edgeCount} edges`}
                    </span>
                  </text>
                </box>
                <Show when={expanded.knowledge}>
                  <Show when={knowledgeGraph()!.relevant.length > 0}>
                    <box flexDirection="column" gap={0}>
                      <text fg={theme.textMuted}>Relevant</text>
                      <For each={knowledgeGraph()!.relevant}>
                        {(node) => (
                          <box flexDirection="column" paddingLeft={1}>
                            <text fg={theme.text}>{node.name}</text>
                            <Show when={node.path}>
                              <text fg={theme.textMuted}>{clip(node.path, 72)}</text>
                            </Show>
                          </box>
                        )}
                      </For>
                    </box>
                  </Show>
                  <For each={knowledgeGraph()!.groups}>
                    {(group) => (
                      <box flexDirection="column">
                        <box
                          flexDirection="row"
                          gap={1}
                          onMouseDown={() => setExpanded("knowledgeGroups", group.type, !expanded.knowledgeGroups[group.type])}
                        >
                          <text fg={theme.text}>{expanded.knowledgeGroups[group.type] !== false ? "▼" : "▶"}</text>
                          <text fg={theme.text}>
                            {humanizeLabel(group.type)} <span style={{ fg: theme.textMuted }}>({group.count})</span>
                          </text>
                        </box>
                        <Show when={expanded.knowledgeGroups[group.type] !== false}>
                          <For each={group.nodes}>
                            {(node) => (
                              <box flexDirection="column" paddingLeft={1}>
                                <box
                                  flexDirection="row"
                                  gap={1}
                                  onMouseDown={() => setExpanded("knowledgeNodes", node.id, !expanded.knowledgeNodes[node.id])}
                                >
                                  <text fg={theme.text}>{expanded.knowledgeNodes[node.id] ? "▼" : "▶"}</text>
                                  <text fg={theme.text}>{node.name}</text>
                                </box>
                                <Show when={expanded.knowledgeNodes[node.id]}>
                                  <Show when={node.path}>
                                    <text fg={theme.textMuted} paddingLeft={2}>
                                      {clip(node.path, 70)}
                                    </text>
                                  </Show>
                                  <For each={node.related}>
                                    {(relation) => (
                                      <text fg={theme.textMuted} paddingLeft={2}>
                                        {relation.relation}
                                        {" -> "}
                                        {relation.targetName}
                                      </text>
                                    )}
                                  </For>
                                </Show>
                              </box>
                            )}
                          </For>
                        </Show>
                      </box>
                    )}
                  </For>
                </Show>
              </box>
            </Show>
          </box>
        </scrollbox>

        <box flexShrink={0} gap={1} paddingTop={1}>
          <Show when={!hasProviders() && !gettingStartedDismissed()}>
            <box
              backgroundColor={theme.backgroundElement}
              paddingTop={1}
              paddingBottom={1}
              paddingLeft={2}
              paddingRight={2}
              flexDirection="row"
              gap={1}
            >
              <text flexShrink={0} fg={theme.text}>
                ⬖
              </text>
              <box flexGrow={1} gap={1}>
                <box flexDirection="row" justifyContent="space-between">
                  <text fg={theme.text}>
                    <b>Getting started</b>
                  </text>
                  <text fg={theme.textMuted} onMouseDown={() => kv.set("dismissed_getting_started", true)}>
                    ✕
                  </text>
                </box>
                <text fg={theme.textMuted}>OpenCode includes free models so you can start immediately.</text>
                <text fg={theme.textMuted}>
                  Connect from 75+ providers to use other models, including Claude, GPT, Gemini etc
                </text>
                <box flexDirection="row" gap={1} justifyContent="space-between">
                  <text fg={theme.text}>Connect provider</text>
                  <text fg={theme.textMuted}>/connect</text>
                </box>
              </box>
            </box>
          </Show>
          <text>
            <span style={{ fg: theme.textMuted }}>{directory().split("/").slice(0, -1).join("/")}/</span>
            <span style={{ fg: theme.text }}>{directory().split("/").at(-1)}</span>
          </text>
          <text fg={theme.textMuted}>
            <span style={{ fg: theme.success }}>•</span> <b>Open</b>
            <span style={{ fg: theme.text }}>
              <b>Code</b>
            </span>{" "}
            <span>{Installation.VERSION}</span>
          </text>
        </box>
      </box>
    </Show>
  )
}
