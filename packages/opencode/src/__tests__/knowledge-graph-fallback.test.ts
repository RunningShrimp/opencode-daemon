import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type { Project } from "../project/project"
import { projectID } from "../test-helpers/ids"

const cleanup: string[] = []
const envKeys = ["XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME"] as const
const originalEnv = new Map<string, string | undefined>()

function projectInfo(worktree: string): Project.Info {
  return {
    id: projectID("knowledge-fallback-project"),
    worktree,
    vcs: "git",
    time: {
      created: Date.now(),
      updated: Date.now(),
    },
    sandboxes: [],
  }
}

beforeEach(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-knowledge-fallback-"))
  cleanup.push(root)

  for (const key of envKeys) {
    originalEnv.set(key, process.env[key])
  }

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
    if (value === undefined) {
      delete process.env[key]
    } else {
      process.env[key] = value
    }
  }
  originalEnv.clear()

  while (cleanup.length > 0) {
    const target = cleanup.pop()
    if (target) {
      await fs.rm(target, { recursive: true, force: true })
    }
  }
})

describe("knowledge graph JSON fallback", () => {
  test("restores from JSON backup in an Instance context when SochDB init fails", async () => {
    const SochDB = await import("../util/sochdb")
    vi.spyOn(SochDB, "openSochDatabase").mockRejectedValue(new Error("sochdb unavailable"))

    const { Instance } = await import("../project/instance")
    const { Global } = await import("../global/index")

    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-knowledge-workspace-"))
    cleanup.push(workspace)

    const backupFile = path.join(
      Global.Path.data,
      "knowledge-graph",
      `${encodeURIComponent("knowledge-fallback-project")}.json`,
    )
    await fs.mkdir(path.dirname(backupFile), { recursive: true })
    await fs.writeFile(
      backupFile,
      JSON.stringify({
        nodes: [
          {
            id: "node-alpha",
            type: "entity",
            name: "alpha",
            content: "fallback-check",
            tags: ["json", "fallback"],
            metadata: { source: "test" },
            timeCreated: 1,
            lastAccessed: 1,
            accessCount: 0,
          },
        ],
        edges: [],
      }),
      "utf-8",
    )

    await Instance.reload({
      directory: workspace,
      project: projectInfo(workspace),
      worktree: workspace,
    })

    await Instance.provide({
      directory: workspace,
      fn: async () => {
        const { createKnowledgeGraph } = await import("../ai/knowledge/index")
        const graph = createKnowledgeGraph()

        const restored = graph.query({ text: "alpha" })

        expect(restored).toHaveLength(1)
        expect(restored[0]?.name).toBe("alpha")
        expect(restored[0]?.content).toBe("fallback-check")
      },
    })

    const backup = JSON.parse(await fs.readFile(backupFile, "utf-8")) as { nodes?: Array<{ name: string }> }
    expect(backup.nodes?.[0]?.name).toBe("alpha")
  })
})