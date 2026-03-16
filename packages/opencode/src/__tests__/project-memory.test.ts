import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const cleanup: string[] = []
const envKeys = ["XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME"] as const
const originalEnv = new Map<string, string | undefined>()

beforeEach(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-project-memory-"))
  cleanup.push(root)
  for (const key of envKeys) originalEnv.set(key, process.env[key])
  process.env.XDG_DATA_HOME = path.join(root, "data-home")
  process.env.XDG_CACHE_HOME = path.join(root, "cache-home")
  process.env.XDG_CONFIG_HOME = path.join(root, "config-home")
  process.env.XDG_STATE_HOME = path.join(root, "state-home")
})

afterEach(async () => {
  const { Instance } = await import("../project/instance")
  const { ProjectMemory } = await import("../ai/memory/project-memory")
  ProjectMemory.resetForTest()
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

describe("project memory", () => {
  test("bootstraps project terms, commands, and docs into long-term memory", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-project-memory-workspace-"))
    cleanup.push(workspace)
    await fs.mkdir(path.join(workspace, "docs"), { recursive: true })
    await fs.writeFile(
      path.join(workspace, "package.json"),
      JSON.stringify(
        {
          name: "demo-app",
          description: "A demo workspace for project memory.",
          scripts: {
            dev: "bun run dev",
            test: "bun test",
          },
          dependencies: {
            zod: "^3.0.0",
          },
        },
        null,
        2,
      ),
      "utf8",
    )
    await fs.writeFile(path.join(workspace, "README.md"), "# Demo App\n\n## Quickstart\n", "utf8")
    await fs.writeFile(path.join(workspace, "docs", "guide.mdx"), "# Guide\n\n## Constraints\n", "utf8")

    const { Instance } = await import("../project/instance")
    await Instance.reload({
      directory: workspace,
      worktree: workspace,
      project: {
        id: "project-memory-bootstrap-project",
        worktree: workspace,
        vcs: "git",
        name: "Demo App",
        commands: { start: "bun run dev" },
        time: { created: Date.now(), updated: Date.now() },
        sandboxes: [],
      },
    })

    await Instance.provide({
      directory: workspace,
      fn: async () => {
        const { bootstrapProjectMemory } = await import("../ai/memory/project-memory-bootstrap")
        const { ProjectMemory } = await import("../ai/memory/project-memory")

        await bootstrapProjectMemory({
          projectID: Instance.project.id,
          rootDir: workspace,
          projectName: Instance.project.name,
          startCommand: Instance.project.commands?.start,
        })

        const snapshot = await ProjectMemory.read(Instance.project.id)
        expect(snapshot.entries.some((entry) => entry.kind === "command" && entry.text.includes("bun run dev"))).toBeTrue()
        expect(snapshot.entries.some((entry) => entry.kind === "term" && entry.text.includes("Dependency: zod"))).toBeTrue()
        expect(snapshot.entries.some((entry) => entry.kind === "summary" && entry.text.includes("README.md: Demo App"))).toBeTrue()

        const prompt = await ProjectMemory.renderPromptContext(Instance.project.id, "how do I run the dev command for demo app")
        expect(prompt).toContain("Script dev: bun run dev")
        expect(prompt).toContain("Package name: demo-app")
      },
    })
  })

  test("remembers user constraints and normalized tool failures", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-project-memory-constraints-"))
    cleanup.push(workspace)

    const { Instance } = await import("../project/instance")
    await Instance.reload({
      directory: workspace,
      worktree: workspace,
      project: {
        id: "project-memory-constraint-project",
        worktree: workspace,
        vcs: "git",
        time: { created: Date.now(), updated: Date.now() },
        sandboxes: [],
      },
    })

    await Instance.provide({
      directory: workspace,
      fn: async () => {
        const { ProjectMemory } = await import("../ai/memory/project-memory")

        await ProjectMemory.rememberPromptConstraints(
          Instance.project.id,
          ["必须保留现有 API", "不要修改 public API", "this line is just context"].join("\n"),
        )
        await ProjectMemory.rememberToolFailure({
          projectID: Instance.project.id,
          tool: "read",
          taskType: "implementation",
          message: "ENOENT: missing file on disk\nextra stack",
          evidence: ["read missing config"],
        })

        const snapshot = await ProjectMemory.read(Instance.project.id)
        expect(snapshot.entries.some((entry) => entry.kind === "constraint" && entry.text.includes("必须保留现有 API"))).toBeTrue()
        expect(snapshot.entries.some((entry) => entry.kind === "constraint" && entry.text.includes("不要修改 public API"))).toBeTrue()
        expect(snapshot.entries.some((entry) => entry.kind === "failure_mode" && entry.text.includes("Tool read failed during implementation: ENOENT: missing file on disk extra stack"))).toBeTrue()
      },
    })
  })

  test("merges near-duplicate constraints and prefers the richer text", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-project-memory-merge-"))
    cleanup.push(workspace)

    const { Instance } = await import("../project/instance")
    await Instance.reload({
      directory: workspace,
      worktree: workspace,
      project: {
        id: "project-memory-merge-project",
        worktree: workspace,
        vcs: "git",
        time: { created: Date.now(), updated: Date.now() },
        sandboxes: [],
      },
    })

    await Instance.provide({
      directory: workspace,
      fn: async () => {
        const { ProjectMemory } = await import("../ai/memory/project-memory")

        await ProjectMemory.rememberConstraint(Instance.project.id, "Do not change public API", ["initial prompt"])
        await ProjectMemory.rememberConstraint(Instance.project.id, "Do not change the public API.", ["follow-up prompt"])

        const snapshot = await ProjectMemory.read(Instance.project.id)
        const constraints = snapshot.entries.filter((entry) => entry.kind === "constraint")

        expect(constraints).toHaveLength(1)
        expect(constraints[0]?.text).toContain("public API")
        expect(constraints[0]?.evidence).toContain("initial prompt")
        expect(constraints[0]?.evidence).toContain("follow-up prompt")
      },
    })
  })

  test("refreshes summary entries by source instead of duplicating", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-project-memory-summary-refresh-"))
    cleanup.push(workspace)

    const { Instance } = await import("../project/instance")
    await Instance.reload({
      directory: workspace,
      worktree: workspace,
      project: {
        id: "project-memory-summary-refresh-project",
        worktree: workspace,
        vcs: "git",
        time: { created: Date.now(), updated: Date.now() },
        sandboxes: [],
      },
    })

    await Instance.provide({
      directory: workspace,
      fn: async () => {
        const { ProjectMemory } = await import("../ai/memory/project-memory")

        await ProjectMemory.upsert(Instance.project.id, {
          kind: "summary",
          text: "README.md: Initial heading",
          confidence: 0.8,
          evidence: ["README.md"],
          tags: ["doc", "readme"],
        })
        await ProjectMemory.upsert(Instance.project.id, {
          kind: "summary",
          text: "README.md: Updated heading",
          confidence: 0.85,
          evidence: ["README.md"],
          tags: ["doc", "readme"],
        })

        const snapshot = await ProjectMemory.read(Instance.project.id)
        const summaries = snapshot.entries.filter((entry) => entry.kind === "summary" && entry.evidence.includes("README.md"))

        expect(summaries).toHaveLength(1)
        expect(summaries[0]?.text).toContain("Updated heading")
      },
    })
  })

  test("renderPromptContext uses budget-driven selection instead of fixed top-5", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-project-memory-budget-"))
    cleanup.push(workspace)

    const { Instance } = await import("../project/instance")
    await Instance.reload({
      directory: workspace,
      worktree: workspace,
      project: {
        id: "project-memory-budget-project",
        worktree: workspace,
        vcs: "git",
        time: { created: Date.now(), updated: Date.now() },
        sandboxes: [],
      },
    })

    await Instance.provide({
      directory: workspace,
      fn: async () => {
        const { ProjectMemory } = await import("../ai/memory/project-memory")
        for (let i = 0; i < 8; i++) {
          await ProjectMemory.upsert(Instance.project.id, {
            kind: "fact",
            text: `Unique memory ${i}: subsystem-${i} uses dedicated workflow and storage path ${i}`,
            confidence: 0.95,
            evidence: [`src/file-${i}.ts`],
            tags: [`fact-${i}`, `subsystem-${i}`],
          })
        }

        const wide = await ProjectMemory.renderPromptContext(Instance.project.id, {
          query: "build details",
          budget: 2000,
          maxEntries: 12,
        })
        expect(wide).toBeDefined()
        const wideCount = (wide ?? "").split("\n").filter((line) => line.startsWith("- [")).length
        expect(wideCount).toBeGreaterThan(5)

        const narrow = await ProjectMemory.renderPromptContext(Instance.project.id, {
          query: "build details",
          budget: 90,
          maxEntries: 12,
        })
        expect(narrow).toBeDefined()
        const narrowCount = (narrow ?? "").split("\n").filter((line) => line.startsWith("- [")).length
        expect(narrowCount).toBeLessThan(wideCount)
      },
    })
  })

  test("keeps memory bounded under high-volume writes and remains queryable", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-project-memory-pressure-"))
    cleanup.push(workspace)

    const { Instance } = await import("../project/instance")
    await Instance.reload({
      directory: workspace,
      worktree: workspace,
      project: {
        id: "project-memory-pressure-project",
        worktree: workspace,
        vcs: "git",
        time: { created: Date.now(), updated: Date.now() },
        sandboxes: [],
      },
    })

    await Instance.provide({
      directory: workspace,
      fn: async () => {
        const { ProjectMemory } = await import("../ai/memory/project-memory")

        for (let i = 0; i < 230; i++) {
          await ProjectMemory.upsert(Instance.project.id, {
            kind: "fact",
            text: `pressure-entry-${i}: subsystem-${i % 19} invariant and operational note`,
            confidence: 0.9,
            evidence: [`src/pressure-${i}.ts`],
            tags: [`pressure-${i % 13}`, "stress"],
          })
        }

        const snapshot = await ProjectMemory.read(Instance.project.id)
        expect(snapshot.entries.length).toBeLessThanOrEqual(200)

        const prompt = await ProjectMemory.renderPromptContext(Instance.project.id, {
          query: "pressure entry subsystem note",
          budget: 320,
          maxEntries: 16,
        })

        expect(prompt).toBeDefined()
        expect(prompt).toContain("<project_memory>")
      },
    })
  })
})