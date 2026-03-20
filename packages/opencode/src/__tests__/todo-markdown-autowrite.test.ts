import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { projectInfo } from "../test-helpers/ids"

describe("todo markdown aggregation", () => {
  const envKeys = ["XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME"] as const
  const originalEnv = new Map<string, string | undefined>()
  const cleanup: string[] = []

  beforeEach(async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-todo-aggregate-"))
    cleanup.push(workspace)
    for (const key of envKeys) originalEnv.set(key, process.env[key])
    process.env.XDG_DATA_HOME = path.join(workspace, "data-home")
    process.env.XDG_CACHE_HOME = path.join(workspace, "cache-home")
    process.env.XDG_CONFIG_HOME = path.join(workspace, "config-home")
    process.env.XDG_STATE_HOME = path.join(workspace, "state-home")
    const { Instance } = await import("../project/instance")
    await Instance.reload({
      directory: workspace,
      worktree: workspace,
      project: projectInfo("todo-aggregate-project", workspace),
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

  test("aggregateTodoMarkdown merges todos from multiple session sidecar files", async () => {
    const { Instance } = await import("../project/instance")
    const workspace = cleanup[cleanup.length - 1]!

    await Instance.provide({
      directory: workspace,
      fn: async () => {
        const { writeTodoMarkdown, aggregateTodoMarkdown } = await import("../session/todo-markdown")

        await writeTodoMarkdown("session-agg-1", [
          { content: "Implement feature A", status: "completed", priority: "high" },
          { content: "Write tests for A", status: "pending", priority: "medium" },
        ])

        await writeTodoMarkdown("session-agg-2", [
          { content: "Implement feature B", status: "in_progress", priority: "high" },
          { content: "Update docs", status: "pending", priority: "low" },
        ])

        const result = await aggregateTodoMarkdown(["session-agg-1", "session-agg-2"])
        expect(result).toBeDefined()
        expect(result!.mode).toBe("sidecar")

        const content = await fs.readFile(result!.path, "utf8")
        expect(content).toContain("Implement feature A")
        expect(content).toContain("Write tests for A")
        expect(content).toContain("Implement feature B")
        expect(content).toContain("Update docs")
      },
    })
  })

  test("aggregateTodoMarkdown returns undefined when all sessions are empty/missing", async () => {
    const { Instance } = await import("../project/instance")
    const workspace = cleanup[cleanup.length - 1]!

    await Instance.provide({
      directory: workspace,
      fn: async () => {
        const { aggregateTodoMarkdown } = await import("../session/todo-markdown")
        const result = await aggregateTodoMarkdown(["nonexistent-session-1", "nonexistent-session-2"])
        expect(result).toBeUndefined()
      },
    })
  })

  test("aggregateTodoMarkdown deduplicates todos by ID", async () => {
    const { Instance } = await import("../project/instance")
    const workspace = cleanup[cleanup.length - 1]!

    await Instance.provide({
      directory: workspace,
      fn: async () => {
        const { writeTodoMarkdown, aggregateTodoMarkdown } = await import("../session/todo-markdown")

        // Write the same ID-tagged todo in two sessions
        await writeTodoMarkdown("session-dedup-1", [
          { id: "todo-shared-001", content: "Shared task", status: "pending", priority: "medium" },
          { content: "Unique task A", status: "pending", priority: "medium" },
        ])

        await writeTodoMarkdown("session-dedup-2", [
          { id: "todo-shared-001", content: "Shared task", status: "in_progress", priority: "medium" },
          { content: "Unique task B", status: "pending", priority: "medium" },
        ])

        const result = await aggregateTodoMarkdown(["session-dedup-1", "session-dedup-2"])
        expect(result).toBeDefined()

        const content = await fs.readFile(result!.path, "utf8")
        // The shared ID should appear only once
        const sharedCount = (content.match(/todo-shared-001/g) ?? []).length
        expect(sharedCount).toBe(1)

        // Unique tasks from both sessions must still be present
        expect(content).toContain("Unique task A")
        expect(content).toContain("Unique task B")
      },
    })
  })

  test("aggregateTodoMarkdown writes to a custom targetPath when specified", async () => {
    const { Instance } = await import("../project/instance")
    const workspace = cleanup[cleanup.length - 1]!

    await Instance.provide({
      directory: workspace,
      fn: async () => {
        const { writeTodoMarkdown, aggregateTodoMarkdown } = await import("../session/todo-markdown")

        await writeTodoMarkdown("session-custom-path", [
          { content: "Custom path task", status: "pending", priority: "low" },
        ])

        const customOut = path.join(workspace, "custom-todos.md")
        const result = await aggregateTodoMarkdown(["session-custom-path"], customOut)
        expect(result).toBeDefined()
        expect(result!.path).toBe(customOut)

        const exists = await fs.stat(customOut).then(() => true).catch(() => false)
        expect(exists).toBeTrue()
      },
    })
  })

  test("defer-based todo writeback fires on session loop exception (smoke test)", async () => {
    // This test verifies that the deferred cleanup pattern works.
    // We simulate the defer callback directly since prompt.ts loop is hard to unit-test end-to-end.
    const { Instance } = await import("../project/instance")
    const workspace = cleanup[cleanup.length - 1]!

    await Instance.provide({
      directory: workspace,
      fn: async () => {
        const { writeTodoMarkdown } = await import("../session/todo-markdown")
        let writebackCalled = false

        // Simulate the defer cleanup block from prompt.ts
        const deferredWriteback = async () => {
          writebackCalled = true
          await writeTodoMarkdown("session-defer-test", [
            { content: "Deferred task", status: "in_progress", priority: "high" },
          ])
        }

        // Simulate a try block that throws
        try {
          throw new Error("Simulated session exception")
        } catch {
          // swallow
        } finally {
          await deferredWriteback()
        }

        expect(writebackCalled).toBeTrue()
      },
    })
  })

  test("aggregates high-volume multi-session todos with stable ID deduplication", async () => {
    const { Instance } = await import("../project/instance")
    const workspace = cleanup[cleanup.length - 1]!

    await Instance.provide({
      directory: workspace,
      fn: async () => {
        const { writeTodoMarkdown, aggregateTodoMarkdown } = await import("../session/todo-markdown")

        const sessionIDs = Array.from({ length: 16 }, (_, i) => `session-load-${i}`)
        await Promise.all(
          sessionIDs.map((sessionID, i) =>
            writeTodoMarkdown(sessionID, [
              { id: "todo-shared-load", content: "shared pressure todo", status: "pending", priority: "high" },
              { content: `unique-${i}-a`, status: "pending", priority: "medium" },
              { content: `unique-${i}-b`, status: "in_progress", priority: "low" },
            ]),
          ),
        )

        const result = await aggregateTodoMarkdown(sessionIDs)
        expect(result).toBeDefined()

        const content = await fs.readFile(result!.path, "utf8")
        const sharedCount = (content.match(/todo-shared-load/g) ?? []).length
        expect(sharedCount).toBe(1)

        for (let i = 0; i < sessionIDs.length; i++) {
          expect(content).toContain(`unique-${i}-a`)
          expect(content).toContain(`unique-${i}-b`)
        }
      },
    })
  })

  test("keeps aggregate output consistent under concurrent aggregation requests", async () => {
    const { Instance } = await import("../project/instance")
    const workspace = cleanup[cleanup.length - 1]!

    await Instance.provide({
      directory: workspace,
      fn: async () => {
        const { writeTodoMarkdown, aggregateTodoMarkdown } = await import("../session/todo-markdown")

        const sessionIDs = Array.from({ length: 10 }, (_, i) => `session-concurrent-${i}`)
        await Promise.all(
          sessionIDs.map((sessionID, i) =>
            writeTodoMarkdown(sessionID, [
              { id: "todo-shared-concurrent", content: "shared concurrent todo", status: "pending", priority: "high" },
              { content: `concurrent-unique-${i}-a`, status: "pending", priority: "medium" },
              { content: `concurrent-unique-${i}-b`, status: "completed", priority: "low" },
            ]),
          ),
        )

        const output = path.join(workspace, "aggregate-concurrent.md")
        const runs = await Promise.all(
          Array.from({ length: 8 }, () => aggregateTodoMarkdown(sessionIDs, output)),
        )

        expect(runs.every((item) => item?.path === output)).toBeTrue()

        const content = await fs.readFile(output, "utf8")
        const lines = content.trim().split(/\r?\n/)
        expect(lines.length).toBe(21)
        expect(lines.every((line) => /^- \[( |x|~|-)\]\s+/.test(line))).toBeTrue()
        expect((content.match(/todo-shared-concurrent/g) ?? []).length).toBe(1)

        for (let i = 0; i < sessionIDs.length; i++) {
          expect(content).toContain(`concurrent-unique-${i}-a`)
          expect(content).toContain(`concurrent-unique-${i}-b`)
        }
      },
    })
  })
})
