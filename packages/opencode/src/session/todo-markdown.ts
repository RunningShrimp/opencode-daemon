import fs from "node:fs/promises"
import path from "node:path"
import { Instance } from "@/project/instance"
import type { Todo } from "./todo"

const STATUS_MARKERS: Record<string, string> = {
  pending: " ",
  in_progress: "~",
  completed: "x",
  cancelled: "-",
}

export type TodoMarkdownMode = "sidecar" | "managed_block" | "inline_checkboxes"

export interface TodoMarkdownReadResult {
  path: string
  mode: TodoMarkdownMode
  todos: Todo.Info[]
}

export interface TodoMarkdownWriteResult {
  path: string
  mode: TodoMarkdownMode
}

const BLOCK_START = "<!-- opencode:todo:start -->"
const BLOCK_END = "<!-- opencode:todo:end -->"
const TODO_ID_PATTERN = /<!--\s*opencode-todo:id=([^\s>]+)\s*-->/i
const PRIORITY_PATTERN = /<!--\s*priority:(high|medium|low)\s*-->/i
const CHECKBOX_PATTERN = /^(\s*[-*+]\s*)\[( |x|~|-)\]\s+(.*)$/i

function todoDir() {
  return path.join(Instance.project?.worktree ?? Instance.worktree, ".opencode", "todos")
}

export function todoMarkdownPath(sessionID: string) {
  return path.join(todoDir(), `${sessionID}.md`)
}

export async function writeTodoMarkdown(
  sessionID: string,
  todos: Todo.Info[],
  options?: { path?: string; mode?: TodoMarkdownMode },
): Promise<TodoMarkdownWriteResult> {
  const file = options?.path ?? todoMarkdownPath(sessionID)
  await fs.mkdir(path.dirname(file), { recursive: true })

  if (!options?.path) {
    const lines = [
      "# Session Todo",
      "",
      "This file is synchronized with the session todo list.",
      "",
      ...todos.map((todo) => serializeTodoLine(todo)),
      "",
    ]
    await fs.writeFile(file, lines.join("\n"), "utf8")
    return { path: file, mode: "sidecar" }
  }

  const content = await fs.readFile(file, "utf8").catch(() => "")
  const managed = parseManagedBlock(content)
  const inline = parseInlineCheckboxes(content)
  const mode = options?.mode ?? (managed ? "managed_block" : inline.length > 0 ? "inline_checkboxes" : "managed_block")
  const next =
    mode === "inline_checkboxes"
      ? writeInlineCheckboxes(content, todos)
      : writeManagedBlock(content, todos)

  await fs.writeFile(file, next, "utf8")
  return { path: file, mode }
}

export async function readTodoMarkdown(
  sessionID: string,
  options?: { path?: string; mode?: TodoMarkdownMode },
): Promise<TodoMarkdownReadResult | undefined> {
  const file = options?.path ?? todoMarkdownPath(sessionID)
  const content = await fs.readFile(file, "utf8").catch(() => undefined)
  if (content === undefined) return undefined

  if (!options?.path) {
    return {
      path: file,
      mode: "sidecar",
      todos: parseTodoLines(content.split(/\r?\n/)),
    }
  }

  if (options?.mode !== "inline_checkboxes") {
    const managed = parseManagedBlock(content)
    if (managed) {
      return {
        path: file,
        mode: "managed_block",
        todos: managed,
      }
    }
  }

  const inline = parseInlineCheckboxes(content)
  if (inline.length > 0) {
    return {
      path: file,
      mode: "inline_checkboxes",
      todos: inline,
    }
  }

  if (options?.mode) {
    return {
      path: file,
      mode: options.mode,
      todos: [],
    }
  }

  return undefined
}

export async function aggregateTodoMarkdown(
  sessionIDs: string[],
  targetPath?: string,
): Promise<TodoMarkdownWriteResult | undefined> {
  const allTodos: Todo.Info[] = []
  for (const sid of sessionIDs) {
    const result = await readTodoMarkdown(sid).catch(() => undefined)
    if (result) {
      allTodos.push(...result.todos)
    }
  }

  if (allTodos.length === 0) return undefined

  // Deduplicate by ID when present
  const seen = new Set<string>()
  const deduped = allTodos.filter((t) => {
    if (!t.id) return true
    if (seen.has(t.id)) return false
    seen.add(t.id)
    return true
  })

  const outPath = targetPath ?? path.join(todoDir(), "aggregate.md")
  await fs.mkdir(path.dirname(outPath), { recursive: true })
  await fs.writeFile(outPath, deduped.map((t) => serializeTodoLine(t)).join("\n") + "\n", "utf8")

  return { path: outPath, mode: "sidecar" }
}

function markerToStatus(marker: string): Todo.Info["status"] {
  if (marker === "x") return "completed"
  if (marker === "~") return "in_progress"
  if (marker === "-") return "cancelled"
  return "pending"
}

function parseTodoLines(lines: string[]) {
  const todos: Todo.Info[] = []
  for (const line of lines) {
    const parsed = parseTodoLine(line)
    if (!parsed) continue
    todos.push(parsed.todo)
  }
  return todos
}

function parseManagedBlock(content: string) {
  const lines = content.split(/\r?\n/)
  const start = lines.findIndex((line) => line.includes(BLOCK_START))
  if (start === -1) return undefined
  const end = lines.findIndex((line, index) => index > start && line.includes(BLOCK_END))
  if (end === -1) return undefined
  return parseTodoLines(lines.slice(start + 1, end))
}

function parseInlineCheckboxes(content: string) {
  return selectInlineCheckboxSection(content)?.todos ?? []
}

function selectInlineCheckboxSection(content: string) {
  const lines = content.split(/\r?\n/)
  const sections: Array<{
    start: number
    end: number
    todos: Todo.Info[]
    hasIDs: boolean
    score: number
  }> = []

  let start = -1
  let parsedLines: Array<ReturnType<typeof parseTodoLine>> = []

  const flush = (endIndex: number) => {
    if (start === -1 || parsedLines.length === 0) return
    const todos = parsedLines
      .filter((item): item is NonNullable<typeof item> => !!item)
      .map((item) => item.todo)
    if (todos.length === 0) {
      start = -1
      parsedLines = []
      return
    }

    const hasIDs = parsedLines.some((item) => !!item?.todo.id)
    const heading = nearestHeading(lines, start)
    const headingScore = /todo|task|checklist|plan/i.test(heading ?? "") ? 4 : 0
    const score = (hasIDs ? 10 : 0) + headingScore + todos.length
    sections.push({
      start,
      end: endIndex,
      todos,
      hasIDs,
      score,
    })
    start = -1
    parsedLines = []
  }

  lines.forEach((line, index) => {
    const parsed = parseTodoLine(line)
    if (parsed) {
      if (start === -1) start = index
      parsedLines.push(parsed)
      return
    }
    flush(index - 1)
  })
  flush(lines.length - 1)

  return sections.sort((left, right) => right.score - left.score)[0]
}

function parseTodoLine(line: string) {
  const match = line.match(CHECKBOX_PATTERN)
  if (!match) return undefined

  const id = line.match(TODO_ID_PATTERN)?.[1]
  const priority = line.match(PRIORITY_PATTERN)?.[1] ?? "medium"
  const content = match[3]
    .replace(PRIORITY_PATTERN, "")
    .replace(TODO_ID_PATTERN, "")
    .trim()

  return {
    prefix: match[1],
    todo: {
      ...(id ? { id } : {}),
      content,
      status: markerToStatus(match[2]),
      priority,
    },
  }
}

function serializeTodoLine(todo: Todo.Info, prefix = "- ") {
  const comments = [`<!-- priority:${todo.priority} -->`]
  if (todo.id) comments.push(`<!-- opencode-todo:id=${todo.id} -->`)
  return `${prefix}[${STATUS_MARKERS[todo.status] ?? " "}] ${todo.content} ${comments.join(" ")}`.trimEnd()
}

function writeManagedBlock(content: string, todos: Todo.Info[]) {
  const lines = content ? content.split(/\r?\n/) : []
  const block = [BLOCK_START, ...todos.map((todo) => serializeTodoLine(todo)), BLOCK_END]
  const start = lines.findIndex((line) => line.includes(BLOCK_START))

  if (start !== -1) {
    const end = lines.findIndex((line, index) => index > start && line.includes(BLOCK_END))
    const next = end === -1 ? [...lines.slice(0, start), ...block] : [...lines.slice(0, start), ...block, ...lines.slice(end + 1)]
    return ensureTrailingNewline(next)
  }

  const next = [...lines]
  if (next.length > 0 && next[next.length - 1] !== "") next.push("")
  next.push("## Session Todo", "", ...block)
  return ensureTrailingNewline(next)
}

function writeInlineCheckboxes(content: string, todos: Todo.Info[]) {
  const lines = content ? content.split(/\r?\n/) : []
  const section = selectInlineCheckboxSection(content)
  if (!section) return writeManagedBlock(content, todos)

  const prefix = section.todos
    .map((todo, index) => parseTodoLine(lines[section.start + index])?.prefix)
    .find(Boolean) ?? "- "
  const nextLines = [...lines.slice(0, section.start)]
  nextLines.push(...todos.map((todo) => serializeTodoLine(todo, prefix)))
  nextLines.push(...lines.slice(section.end + 1))
  return ensureTrailingNewline(nextLines)
}

function nearestHeading(lines: string[], start: number) {
  for (let index = start - 1; index >= 0 && index >= start - 6; index--) {
    const line = lines[index]?.trim()
    if (!line) continue
    if (/^#{1,6}\s+/.test(line)) return line.replace(/^#{1,6}\s+/, "")
  }
  return undefined
}

function ensureTrailingNewline(lines: string[]) {
  return `${lines.join("\n")}\n`
}