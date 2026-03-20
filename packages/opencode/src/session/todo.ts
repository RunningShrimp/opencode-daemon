import { BusEvent } from "@/bus/bus-event"
import { Bus } from "@/bus"
import { SessionID } from "./schema"
import z from "zod"
import { Database, eq, asc } from "../storage/db"
import { Storage } from "../storage/storage"
import { Filesystem } from "@/util/filesystem"
import { Instance } from "@/project/instance"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { TodoTable } from "./session.sql"
import { readTodoMarkdown, type TodoMarkdownMode, type TodoMarkdownReadResult, writeTodoMarkdown } from "./todo-markdown"
import type { MessageV2 } from "./message-v2"

export namespace Todo {
  type SyncTarget =
    | { type: "sidecar"; mode: "sidecar" }
    | { type: "document"; path: string; mode?: TodoMarkdownMode }

  const READ_MODE_PRIORITY: Record<TodoMarkdownMode, number> = {
    managed_block: 3,
    inline_checkboxes: 2,
    sidecar: 1,
  }

  const DOCUMENT_MODE_PRIORITY: Record<TodoMarkdownMode, number> = {
    managed_block: 2,
    inline_checkboxes: 1,
    sidecar: 0,
  }

  const TODO_FILENAME_PATTERN = /(todo|tasks?|checklist|plan)\.(md|mdx)$/i

  export const Info = z
    .object({
      id: z.string().optional().describe("Stable identifier for the task when syncing against markdown"),
      content: z.string().describe("Brief description of the task"),
      status: z.string().describe("Current status of the task: pending, in_progress, completed, cancelled"),
      priority: z.string().describe("Priority level of the task: high, medium, low"),
    })
    .meta({ ref: "Todo" })
  export type Info = z.infer<typeof Info>

  const SyncState = z.object({
    target: z
      .object({
        type: z.enum(["sidecar", "document"]),
        path: z.string().optional(),
        mode: z.enum(["sidecar", "managed_block", "inline_checkboxes"]),
      })
      .optional(),
    todos: z.array(z.object(Info.shape).extend({ id: z.string() })).default([]),
    updatedAt: z.number().default(0),
  })
  type SyncState = z.infer<typeof SyncState>
  type SyncedTodo = SyncState["todos"][number]

  export const Event = {
    Updated: BusEvent.define(
      "todo.updated",
      z.object({
        sessionID: SessionID.zod,
        todos: z.array(Info),
      }),
    ),
  }

  export async function update(input: {
    sessionID: SessionID
    todos: Info[]
    markdownPath?: string
    messages?: MessageV2.WithParts[]
  }) {
    const state = await readSyncState(input.sessionID)
    const todos = assignIDs(input.todos, state?.todos ?? [])
    const target = await resolveTarget(input.sessionID, state, input.markdownPath, input.messages)
    const synced = await writeTodoMarkdown(input.sessionID, todos, target.type === "document" ? target : undefined)

    persistStored(input.sessionID, todos)
    await persistSyncState(input.sessionID, {
      target: target.type === "document" ? { ...target, mode: synced.mode } : { type: "sidecar", mode: "sidecar" },
      todos: todos.map((todo) => ({ ...todo, id: todo.id! })),
      updatedAt: Date.now(),
    })
    Bus.publish(Event.Updated, { sessionID: input.sessionID, todos })
  }

  export async function get(sessionID: SessionID, options?: { messages?: MessageV2.WithParts[] }) {
    const state = await readSyncState(sessionID)
    const markdownTodos = await readTodoWithConflictPolicy(sessionID, state, options?.messages)

    if (markdownTodos) {
      const todos = assignIDs(markdownTodos.todos, state?.todos ?? [])
      const plain = todos.map(stripID)
      const current = getStored(sessionID)
      if (JSON.stringify(current) !== JSON.stringify(plain)) {
        persistStored(sessionID, todos)
        Bus.publish(Event.Updated, { sessionID, todos })
      }
      await persistSyncState(sessionID, {
        target:
          markdownTodos.mode === "sidecar"
            ? { type: "sidecar", mode: "sidecar" }
            : { type: "document", path: markdownTodos.path, mode: markdownTodos.mode },
        todos: todos.map((todo) => ({ ...todo, id: todo.id! })),
        updatedAt: Date.now(),
      })
      return todos
    }

    const stored = getStored(sessionID)
    return assignIDs(stored, state?.todos ?? [])
  }

  export function getStored(sessionID: SessionID) {
    const rows = Database.cachedSync(
      `todo:get:${sessionID}`,
      () =>
        Database.use((db) =>
          db.select().from(TodoTable).where(eq(TodoTable.session_id, sessionID)).orderBy(asc(TodoTable.position)).all(),
        ),
      { ttl: 2000, namespace: "todo" },
    )
    return rows.map((row) => ({
      content: row.content,
      status: row.status,
      priority: row.priority,
    }))
  }

  function persistStored(sessionID: SessionID, todos: Info[]) {
    Database.transaction((db) => {
      db.delete(TodoTable).where(eq(TodoTable.session_id, sessionID)).run()
      if (todos.length === 0) return
      db.insert(TodoTable)
        .values(
          todos.map((todo, position) => ({
            session_id: sessionID,
            content: todo.content,
            status: todo.status,
            priority: todo.priority,
            position,
          })),
        )
        .run()
    })
    void Database.clearStructuredNamespace("todo")
  }

  function assignIDs(todos: Info[], previous: SyncedTodo[]) {
    const unmatched = [...previous]
    return todos.map((todo) => {
      const direct = todo.id ? unmatched.find((item) => item.id === todo.id) : undefined
      const sameContent = direct
        ? direct
        : unmatched.find((item) => normalizeContent(item.content) === normalizeContent(todo.content))
      const matched = sameContent ?? unmatched.shift()
      if (matched) {
        const index = unmatched.findIndex((item) => item.id === matched.id)
        if (index !== -1) unmatched.splice(index, 1)
      }
      return {
        ...todo,
        id: direct?.id ?? sameContent?.id ?? matched?.id ?? crypto.randomUUID(),
      }
    })
  }

  async function resolveTarget(
    sessionID: SessionID,
    state: SyncState | undefined,
    markdownPath: string | undefined,
    messages: MessageV2.WithParts[] | undefined,
  ): Promise<SyncTarget> {
    if (markdownPath) {
      return {
        type: "document",
        path: normalizeTargetPath(markdownPath),
      }
    }
    if (state?.target?.type === "document" && state.target.path) {
      return { type: "document" as const, path: state.target.path, mode: state.target.mode as TodoMarkdownMode | undefined }
    }

    const discovered = await discoverMarkdownTarget(sessionID, messages)
    if (discovered) return discovered

    return { type: "sidecar", mode: "sidecar" }
  }

  async function discoverMarkdownTarget(sessionID: SessionID, messages: MessageV2.WithParts[] | undefined) {
    const candidates = collectMarkdownCandidates(messages)
    if (candidates.length === 0) return undefined

    const ranked: Array<{ index: number; target: SyncTarget; score: number }> = []

    for (const [index, candidate] of candidates.entries()) {
      const parsed = await readTodoMarkdown(sessionID, { path: candidate }).catch(() => undefined)
      if (parsed) {
        const modePriority = DOCUMENT_MODE_PRIORITY[parsed.mode] ?? 0
        const score = modePriority * 100 + Math.min(parsed.todos.length, 20)
        ranked.push({
          index,
          target: { type: "document", path: candidate, mode: parsed.mode },
          score,
        })
        continue
      }

      if (TODO_FILENAME_PATTERN.test(path.basename(candidate))) {
        ranked.push({
          index,
          target: { type: "document", path: candidate },
          score: 10,
        })
      }
    }

    if (ranked.length === 0) return undefined

    ranked.sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score
      return left.index - right.index
    })
    return ranked[0].target
  }

  async function readTodoWithConflictPolicy(
    sessionID: SessionID,
    state: SyncState | undefined,
    messages: MessageV2.WithParts[] | undefined,
  ) {
    const results: Array<{ index: number; result: TodoMarkdownReadResult }> = []
    const seenDocumentPaths = new Set<string>()
    let index = 0

    const documentCandidates: string[] = []
    if (state?.target?.type === "document" && state.target.path) {
      documentCandidates.push(state.target.path)
    }
    for (const candidate of collectMarkdownCandidates(messages)) {
      if (!documentCandidates.includes(candidate)) {
        documentCandidates.push(candidate)
      }
    }

    for (const candidate of documentCandidates) {
      if (seenDocumentPaths.has(candidate)) continue
      seenDocumentPaths.add(candidate)

      const parsed = await readTodoMarkdown(sessionID, { path: candidate }).catch(() => undefined)
      if (!parsed) continue
      results.push({ index: index++, result: parsed })
    }

    const sidecar = await readTodoMarkdown(sessionID).catch(() => undefined)
    if (sidecar) {
      results.push({ index: index++, result: sidecar })
    }

    if (results.length === 0) return undefined

    results.sort((left, right) => {
      const leftScore = scoreReadResult(left.result)
      const rightScore = scoreReadResult(right.result)
      if (rightScore !== leftScore) return rightScore - leftScore
      return left.index - right.index
    })

    return results[0].result
  }

  function scoreReadResult(result: TodoMarkdownReadResult) {
    const modeScore = (READ_MODE_PRIORITY[result.mode] ?? 0) * 100
    const hasTodosScore = result.todos.length > 0 ? 1000 : 0
    const densityScore = Math.min(result.todos.length, 20)
    return hasTodosScore + modeScore + densityScore
  }

  function collectMarkdownCandidates(messages: MessageV2.WithParts[] | undefined) {
    if (!messages?.length) return []

    const discovered: string[] = []
    const seen = new Set<string>()
    for (const message of [...messages].reverse()) {
      if (message.info.role !== "user") continue
      for (const part of [...message.parts].reverse()) {
        if (part.type !== "file") continue
        const candidate = extractMarkdownPath(part)
        if (!candidate || seen.has(candidate)) continue
        seen.add(candidate)
        discovered.push(candidate)
      }
    }
    return discovered
  }

  function extractMarkdownPath(part: MessageV2.FilePart) {
    const sourcePath = part.source?.type === "file" ? part.source.path : undefined
    const filePath = sourcePath ?? (part.url.startsWith("file:") ? fileURLToPath(part.url) : undefined)
    if (!filePath) return undefined
    const normalized = Filesystem.normalizePath(filePath)
    const name = part.filename ?? normalized
    const isMarkdown = /\.(md|mdx)$/i.test(name) || part.mime === "text/markdown"
    if (!isMarkdown) return undefined
    return normalized
  }

  function normalizeTargetPath(input: string) {
    const base = Instance.project?.worktree ?? Instance.worktree
    return Filesystem.normalizePath(path.isAbsolute(input) ? input : path.resolve(base, input))
  }

  function normalizeContent(content: string) {
    return content.trim().replace(/\s+/g, " ").toLowerCase()
  }

  function stripID(todo: Info) {
    return {
      content: todo.content,
      status: todo.status,
      priority: todo.priority,
    }
  }

  async function readSyncState(sessionID: SessionID) {
    return Storage.read<SyncState>(["todo_sync", sessionID])
      .then((state) => SyncState.parse(state))
      .catch(() => undefined)
  }

  async function persistSyncState(sessionID: SessionID, state: SyncState) {
    await Storage.write(["todo_sync", sessionID], state)
  }
}
