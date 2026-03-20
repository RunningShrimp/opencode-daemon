import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { projectInfo, sessionID as makeSessionID } from "../test-helpers/ids"

describe("todo markdown sync", () => {
  const envKeys = ["XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME"] as const
  const originalEnv = new Map<string, string | undefined>()
  const cleanup: string[] = []

  beforeEach(async () => {
    const { Instance } = await import("../project/instance")
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-todo-md-"))
    cleanup.push(workspace)
    for (const key of envKeys) originalEnv.set(key, process.env[key])
    process.env.XDG_DATA_HOME = path.join(workspace, "data-home")
    process.env.XDG_CACHE_HOME = path.join(workspace, "cache-home")
    process.env.XDG_CONFIG_HOME = path.join(workspace, "config-home")
    process.env.XDG_STATE_HOME = path.join(workspace, "state-home")
    await Instance.reload({
      directory: workspace,
      worktree: workspace,
      project: projectInfo("todo-markdown-project", workspace),
    })
  })

  afterEach(async () => {
    const { Instance } = await import("../project/instance")
    await Instance.disposeAll().catch(() => undefined)
    for (const key of envKeys) {
      const value = originalEnv.get(key)
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    originalEnv.clear()
    while (cleanup.length > 0) {
      const target = cleanup.pop()
      if (target) await fs.rm(target, { recursive: true, force: true })
    }
  })

  async function seedSession(sessionID: ReturnType<typeof makeSessionID>, workspace: string) {
    const { Instance } = await import("../project/instance")
    const { Database } = await import("../storage/db")
    const { ProjectTable } = await import("../project/project.sql")
    const { SessionTable } = await import("../session/session.sql")
    const now = Date.now()

    Database.use((db) => {
      db.insert(ProjectTable)
        .values({
          id: Instance.project.id,
          worktree: workspace,
          vcs: "git",
          name: "todo-markdown-project",
          sandboxes: [],
          time_created: now,
          time_updated: now,
          time_initialized: now,
        })
        .onConflictDoNothing()
        .run()
      db.insert(SessionTable)
        .values({
          id: sessionID,
          project_id: Instance.project.id,
          slug: `todo-${sessionID}`,
          directory: workspace,
          title: sessionID,
          version: "test",
          time_created: now,
          time_updated: now,
        })
        .onConflictDoNothing()
        .run()
    })
  }

  test("writes and reads synchronized markdown todos", async () => {
    const { Instance } = await import("../project/instance")
    const workspace = cleanup[cleanup.length - 1]!

    await Instance.provide({
      directory: workspace,
      fn: async () => {
        const { readTodoMarkdown, todoMarkdownPath, writeTodoMarkdown } = await import("../session/todo-markdown")

        const sessionID = makeSessionID("session-test")

        await writeTodoMarkdown(sessionID, [
          { content: "Inspect failing path", status: "in_progress", priority: "high" },
          { content: "Run focused tests", status: "pending", priority: "medium" },
        ])

        const file = todoMarkdownPath(sessionID)
        const content = await fs.readFile(file, "utf8")
        expect(content).toContain("- [~] Inspect failing path")

        await fs.writeFile(
          file,
          [
            "# Session Todo",
            "",
            "- [x] Inspect failing path <!-- priority:high -->",
            "- [ ] Run focused tests <!-- priority:medium -->",
            "",
          ].join("\n"),
          "utf8",
        )

        const parsed = await readTodoMarkdown(sessionID)
        expect(parsed?.todos).toEqual([
          { content: "Inspect failing path", status: "completed", priority: "high" },
          { content: "Run focused tests", status: "pending", priority: "medium" },
        ])
      },
    })
  })

  test("syncs todos against an explicit markdown document and preserves stable ids", async () => {
    const { Instance } = await import("../project/instance")
    const workspace = cleanup[cleanup.length - 1]!

    await Instance.provide({
      directory: workspace,
      fn: async () => {
        const { Database } = await import("../storage/db")
        const { ProjectTable } = await import("../project/project.sql")
        const { SessionTable } = await import("../session/session.sql")
        const { Todo } = await import("../session/todo")
        const now = Date.now()
        const sessionID = makeSessionID("ses_todo_markdown_test")

        Database.use((db) => {
          db.insert(ProjectTable)
            .values({
              id: Instance.project.id,
              worktree: workspace,
              vcs: "git",
              name: "todo-markdown-project",
              sandboxes: [],
              time_created: now,
              time_updated: now,
              time_initialized: now,
            })
            .onConflictDoNothing()
            .run()
          db.insert(SessionTable)
            .values({
              id: sessionID,
              project_id: Instance.project.id,
              slug: "todo-markdown-test",
              directory: workspace,
              title: "Todo markdown test",
              version: "test",
              time_created: now,
              time_updated: now,
            })
            .run()
        })

        const file = path.join(workspace, "planning.md")
        await fs.writeFile(
          file,
          [
            "# Planning",
            "",
            "- [ ] Inspect failing path",
            "- [ ] Run focused tests",
            "",
          ].join("\n"),
          "utf8",
        )

        await Todo.update({
          sessionID,
          markdownPath: file,
          todos: [
            { content: "Inspect failing path", status: "in_progress", priority: "high" },
            { content: "Run focused tests", status: "pending", priority: "medium" },
          ],
        })

        const synced = await fs.readFile(file, "utf8")
        expect(synced).toContain("<!-- opencode-todo:id=")

        const firstID = synced.match(/opencode-todo:id=([^\s>]+)/)?.[1]
        expect(firstID).toBeDefined()

        await fs.writeFile(
          file,
          synced.replace(
            /- \[~\] Inspect failing path .*$/m,
            `- [x] Inspect failing path again <!-- priority:high --> <!-- opencode-todo:id=${firstID} -->`,
          ),
          "utf8",
        )

        const todos = await Todo.get(sessionID)
        expect(todos[0]).toEqual({
          id: firstID!,
          content: "Inspect failing path again",
          status: "completed",
          priority: "high",
        })
        expect(todos[1]?.id).toBeDefined()
      },
    })
  })

  test("infers markdown sync target from attached user files", async () => {
    const { Instance } = await import("../project/instance")
    const workspace = cleanup[cleanup.length - 1]!

    await Instance.provide({
      directory: workspace,
      fn: async () => {
        const { Database } = await import("../storage/db")
        const { ProjectTable } = await import("../project/project.sql")
        const { SessionTable } = await import("../session/session.sql")
        const { Todo } = await import("../session/todo")
        const { todoMarkdownPath } = await import("../session/todo-markdown")
        const sessionID = makeSessionID("ses_todo_attached_markdown")
        const now = Date.now()

        Database.use((db) => {
          db.insert(ProjectTable)
            .values({
              id: Instance.project.id,
              worktree: workspace,
              vcs: "git",
              name: "todo-markdown-project",
              sandboxes: [],
              time_created: now,
              time_updated: now,
              time_initialized: now,
            })
            .onConflictDoNothing()
            .run()
          db.insert(SessionTable)
            .values({
              id: sessionID,
              project_id: Instance.project.id,
              slug: "todo-attachment-test",
              directory: workspace,
              title: "Todo attachment test",
              version: "test",
              time_created: now,
              time_updated: now,
            })
            .run()
        })

        const file = path.join(workspace, "tasks.md")
        await fs.writeFile(file, ["# Tasks", "", "- [ ] Inspect sync path", ""].join("\n"), "utf8")

        await Todo.update({
          sessionID,
          todos: [{ content: "Inspect sync path", status: "completed", priority: "high" }],
          messages: [
            {
              info: { role: "user" },
              parts: [
                {
                  type: "file",
                  mime: "text/markdown",
                  filename: "tasks.md",
                  url: `file://${file}`,
                  source: { type: "file", path: file },
                },
              ],
            } as any,
          ],
        })

        expect(await fs.readFile(file, "utf8")).toContain("- [x] Inspect sync path")
        await expect(fs.readFile(todoMarkdownPath(sessionID), "utf8")).rejects.toThrow()
      },
    })
  })

  test("only rewrites the selected inline todo checklist section", async () => {
    const { Instance } = await import("../project/instance")
    const workspace = cleanup[cleanup.length - 1]!

    await Instance.provide({
      directory: workspace,
      fn: async () => {
        const { writeTodoMarkdown, readTodoMarkdown } = await import("../session/todo-markdown")

        const file = path.join(workspace, "notes.md")
        await fs.writeFile(
          file,
          [
            "# Notes",
            "",
            "## Launch Checklist",
            "- [ ] unrelated checkbox",
            "",
            "## Session Todo",
            "- [ ] inspect auth path",
            "- [ ] run tests",
            "",
          ].join("\n"),
          "utf8",
        )

        await writeTodoMarkdown(
          makeSessionID("session-inline-section"),
          [
            { content: "inspect auth path", status: "completed", priority: "high" },
            { content: "run tests", status: "in_progress", priority: "medium" },
          ],
          { path: file, mode: "inline_checkboxes" },
        )

        const content = await fs.readFile(file, "utf8")
        expect(content).toContain("## Launch Checklist\n- [ ] unrelated checkbox")
        expect(content).toContain("- [x] inspect auth path")
        expect(content).toContain("- [~] run tests")

        const parsed = await readTodoMarkdown(makeSessionID("session-inline-section"), { path: file, mode: "inline_checkboxes" })
        expect(parsed?.todos).toEqual([
          { content: "inspect auth path", status: "completed", priority: "high" },
          { content: "run tests", status: "in_progress", priority: "medium" },
        ])
      },
    })
  })

  test("prefers managed block document when multiple markdown targets conflict", async () => {
    const { Instance } = await import("../project/instance")
    const workspace = cleanup[cleanup.length - 1]!

    await Instance.provide({
      directory: workspace,
      fn: async () => {
        const { Todo } = await import("../session/todo")
        const sessionID = makeSessionID("ses_todo_multi_doc_priority")
        await seedSession(sessionID, workspace)

        const managed = path.join(workspace, "implementation-plan.md")
        const inline = path.join(workspace, "notes.md")

        await fs.writeFile(
          managed,
          [
            "# Plan",
            "",
            "<!-- opencode:todo:start -->",
            "- [ ] managed target <!-- priority:high -->",
            "<!-- opencode:todo:end -->",
            "",
          ].join("\n"),
          "utf8",
        )

        await fs.writeFile(
          inline,
          [
            "# Notes",
            "",
            "## Session Todo",
            "- [ ] inline target",
            "",
          ].join("\n"),
          "utf8",
        )

        await Todo.update({
          sessionID,
          todos: [{ content: "managed target", status: "completed", priority: "high" }],
          messages: [
            {
              info: { role: "user" },
              parts: [
                {
                  type: "file",
                  mime: "text/markdown",
                  filename: "implementation-plan.md",
                  url: `file://${managed}`,
                  source: { type: "file", path: managed },
                },
                {
                  type: "file",
                  mime: "text/markdown",
                  filename: "notes.md",
                  url: `file://${inline}`,
                  source: { type: "file", path: inline },
                },
              ],
            } as any,
          ],
        })

        const managedContent = await fs.readFile(managed, "utf8")
        const inlineContent = await fs.readFile(inline, "utf8")

        expect(managedContent).toContain("- [x] managed target")
        expect(inlineContent).toContain("- [ ] inline target")
      },
    })
  })

  test("prefers managed/inline document over sidecar when both have todos", async () => {
    const { Instance } = await import("../project/instance")
    const workspace = cleanup[cleanup.length - 1]!

    await Instance.provide({
      directory: workspace,
      fn: async () => {
        const { Todo } = await import("../session/todo")
        const { todoMarkdownPath } = await import("../session/todo-markdown")
        const sessionID = makeSessionID("ses_todo_sidecar_conflict")
        await seedSession(sessionID, workspace)

        const documentPath = path.join(workspace, "tasks.md")
        await fs.writeFile(
          documentPath,
          [
            "# Tasks",
            "",
            "<!-- opencode:todo:start -->",
            "- [ ] document source <!-- priority:medium -->",
            "<!-- opencode:todo:end -->",
            "",
          ].join("\n"),
          "utf8",
        )

        await Todo.update({
          sessionID,
          markdownPath: documentPath,
          todos: [{ content: "document source", status: "pending", priority: "medium" }],
        })

        await fs.mkdir(path.dirname(todoMarkdownPath(sessionID)), { recursive: true })
        await fs.writeFile(
          todoMarkdownPath(sessionID),
          [
            "# Session Todo",
            "",
            "- [x] sidecar override <!-- priority:high -->",
            "",
          ].join("\n"),
          "utf8",
        )

        const readTodos = await Todo.get(sessionID, {
          messages: [
            {
              info: { role: "user" },
              parts: [
                {
                  type: "file",
                  mime: "text/markdown",
                  filename: "tasks.md",
                  url: `file://${documentPath}`,
                  source: { type: "file", path: documentPath },
                },
              ],
            } as any,
          ],
        })

        expect(readTodos[0]).toEqual({
          content: "document source",
          status: "pending",
          priority: "medium",
          id: readTodos[0].id,
        })
      },
    })
  })

  test("falls back to non-empty sidecar when discovered document has no todo entries", async () => {
    const { Instance } = await import("../project/instance")
    const workspace = cleanup[cleanup.length - 1]!

    await Instance.provide({
      directory: workspace,
      fn: async () => {
        const { Todo } = await import("../session/todo")
        const { todoMarkdownPath } = await import("../session/todo-markdown")
        const sessionID = makeSessionID("ses_todo_empty_document_fallback")
        await seedSession(sessionID, workspace)

        const emptyDoc = path.join(workspace, "plan.md")
        await fs.writeFile(
          emptyDoc,
          [
            "# Plan",
            "",
            "<!-- opencode:todo:start -->",
            "<!-- opencode:todo:end -->",
            "",
          ].join("\n"),
          "utf8",
        )

        await fs.mkdir(path.dirname(todoMarkdownPath(sessionID)), { recursive: true })
        await fs.writeFile(
          todoMarkdownPath(sessionID),
          [
            "# Session Todo",
            "",
            "- [x] recover from empty doc <!-- priority:high -->",
            "",
          ].join("\n"),
          "utf8",
        )

        const todos = await Todo.get(sessionID, {
          messages: [
            {
              info: { role: "user" },
              parts: [
                {
                  type: "file",
                  mime: "text/markdown",
                  filename: "plan.md",
                  url: `file://${emptyDoc}`,
                  source: { type: "file", path: emptyDoc },
                },
              ],
            } as any,
          ],
        })

        expect(todos).toHaveLength(1)
        expect(todos[0]?.content).toBe("recover from empty doc")
        expect(todos[0]?.status).toBe("completed")
      },
    })
  })
})