import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const cleanup: string[] = []
const envKeys = ["XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME"] as const
const originalEnv = new Map<string, string | undefined>()

beforeEach(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-knowledge-context-"))
  cleanup.push(root)
  for (const key of envKeys) originalEnv.set(key, process.env[key])
  process.env.XDG_DATA_HOME = path.join(root, "data-home")
  process.env.XDG_CACHE_HOME = path.join(root, "cache-home")
  process.env.XDG_CONFIG_HOME = path.join(root, "config-home")
  process.env.XDG_STATE_HOME = path.join(root, "state-home")
  vi.restoreAllMocks()
})

afterEach(async () => {
  const { Instance } = await import("../project/instance")
  await Instance.disposeAll().catch(() => undefined)
  vi.restoreAllMocks()
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

describe("KnowledgeContext", () => {
  test("renders graph path evidence for dependencies and imports", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-knowledge-context-workspace-"))
    cleanup.push(workspace)
    await fs.mkdir(path.join(workspace, "src"), { recursive: true })
    await fs.mkdir(path.join(workspace, "docs"), { recursive: true })
    await fs.writeFile(
      path.join(workspace, "package.json"),
      JSON.stringify({ dependencies: { zod: "^3.0.0" } }),
      "utf8",
    )
    await fs.writeFile(
      path.join(workspace, "src", "index.ts"),
      'import { z } from "zod"\nimport { helper } from "./helper"\nexport { z, helper }\n',
      "utf8",
    )
    await fs.writeFile(path.join(workspace, "docs", "README.md"), "# Project Guide\n\n## Usage\n\nHello", "utf8")

    const { Instance } = await import("../project/instance")
    await Instance.reload({
      directory: workspace,
      worktree: workspace,
      project: {
        id: "knowledge-context-project",
        worktree: workspace,
        vcs: "git",
        time: { created: Date.now(), updated: Date.now() },
        sandboxes: [],
      },
    })

    await Instance.provide({
      directory: workspace,
      fn: async () => {
        const { createKnowledgeGraph } = await import("../ai/knowledge/index")
        const { refreshDerivedKnowledgeGraph } = await import("../ai/knowledge/derived")
        const { KnowledgeContext } = await import("../ai/knowledge/context")

        const graph = createKnowledgeGraph()
        await refreshDerivedKnowledgeGraph(graph, workspace)

        const prompt = await KnowledgeContext.renderPromptContext("How does src/index.ts use zod?", {
          graph,
          rootDir: workspace,
        })

        expect(prompt).toContain("<knowledge_graph>")
        expect(prompt).toContain("src/index.ts")
        expect(prompt).toContain("zod")
        expect(prompt).toContain("--contains-->")
        expect(prompt).toContain("--imports-->")
      },
    })
  })

  test("includes markdown heading anchors in derived context", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-knowledge-heading-workspace-"))
    cleanup.push(workspace)
    await fs.mkdir(path.join(workspace, "docs"), { recursive: true })
    await fs.writeFile(path.join(workspace, "docs", "guide.md"), "# Guide\n\n## Runtime Notes\n", "utf8")

    const { Instance } = await import("../project/instance")
    await Instance.reload({
      directory: workspace,
      worktree: workspace,
      project: {
        id: "knowledge-heading-project",
        worktree: workspace,
        vcs: "git",
        time: { created: Date.now(), updated: Date.now() },
        sandboxes: [],
      },
    })

    await Instance.provide({
      directory: workspace,
      fn: async () => {
        const { createKnowledgeGraph } = await import("../ai/knowledge/index")
        const { refreshDerivedKnowledgeGraph } = await import("../ai/knowledge/derived")
        const { KnowledgeContext } = await import("../ai/knowledge/context")

        const graph = createKnowledgeGraph()
        await refreshDerivedKnowledgeGraph(graph, workspace)

        const prompt = await KnowledgeContext.renderPromptContext("Where are the runtime notes documented?", {
          graph,
          rootDir: workspace,
        })

        expect(prompt).toContain("Runtime Notes")
        expect(prompt).toContain("guide.md#runtime-notes")
        expect(prompt).toContain("--has_heading-->")
      },
    })
  })
})