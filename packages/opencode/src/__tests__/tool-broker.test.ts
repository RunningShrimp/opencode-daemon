import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ToolBroker, type ToolDescriptor } from "../ai/tool-broker"

const cleanup: string[] = []
const envKeys = ["XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME"] as const
const originalEnv = new Map<string, string | undefined>()

beforeEach(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-tool-broker-"))
  cleanup.push(root)
  for (const key of envKeys) originalEnv.set(key, process.env[key])
  process.env.XDG_DATA_HOME = path.join(root, "data-home")
  process.env.XDG_CACHE_HOME = path.join(root, "cache-home")
  process.env.XDG_CONFIG_HOME = path.join(root, "config-home")
  process.env.XDG_STATE_HOME = path.join(root, "state-home")
  ToolBroker.resetForTest()
})

afterEach(async () => {
  ToolBroker.resetForTest()
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

const tools: ToolDescriptor[] = [
  {
    id: "read",
    description: "Read file content from the workspace",
    source: "builtin",
  },
  {
    id: "rag_query",
    description: "Search project-local indexed code and docs",
    source: "retrieval",
  },
  {
    id: "websearch",
    description: "Search the web",
    source: "web",
  },
  {
    id: "task",
    description: "Delegate work to a subagent",
    source: "subagent",
  },
]

describe("ToolBroker", () => {
  test("ranks repo-local retrieval ahead of web search for code exploration", () => {
    const decision = ToolBroker.decide({
      intent: { type: "exploration", query: "find auth middleware in repo", mode: "lookup" },
      agent: { name: "general" } as any,
      currentTask: "find where auth middleware reaches the session loader in this repo",
      tools,
    })

    expect(decision.ranked.indexOf("rag_query")).toBeLessThan(decision.ranked.indexOf("websearch"))
    expect(decision.recommended).toContain("rag_query")
    expect(decision.discouraged).toContain("websearch")
  })

  test("keeps todo and edit-adjacent tools near the top for implementation turns", () => {
    const decision = ToolBroker.decide({
      intent: { type: "implementation", description: "patch bug", complexity: "moderate" },
      agent: { name: "general" } as any,
      currentTask: "patch the failing code path and track the work in todos",
      tools: [
        ...tools,
        { id: "todowrite", description: "Update todo list", source: "builtin" },
        { id: "apply_patch", description: "Apply focused code changes", source: "builtin" },
      ],
    })

    expect(decision.ranked.slice(0, 4)).toContain("todowrite")
    expect(decision.ranked.slice(0, 4)).toContain("apply_patch")
  })

  test("applies recorded cross-tool history when enriching descriptors", async () => {
    await ToolBroker.recordToolOutcome({
      projectID: "broker-project",
      tool: "apply_patch",
      source: "builtin",
      success: true,
      durationMs: 50,
    })
    await ToolBroker.recordToolOutcome({
      projectID: "broker-project",
      tool: "apply_patch",
      source: "builtin",
      success: true,
      durationMs: 60,
    })
    await ToolBroker.recordToolOutcome({
      projectID: "broker-project",
      tool: "task",
      source: "subagent",
      success: false,
      durationMs: 4000,
    })

    const enriched = await ToolBroker.enrichDescriptors({
      projectID: "broker-project",
      tools: [
        { id: "apply_patch", description: "Apply focused code changes", source: "builtin" },
        { id: "task", description: "Delegate work to a subagent", source: "subagent" },
      ],
    })

    const decision = ToolBroker.decide({
      intent: { type: "implementation", description: "patch bug", complexity: "moderate" },
      agent: { name: "general" } as any,
      currentTask: "patch the failing code path",
      tools: enriched,
    })

    expect(decision.ranked[0]).toBe("apply_patch")
    expect(enriched.find((item) => item.id === "apply_patch")?.historicalSuccess ?? 0).toBeGreaterThan(0.75)
    expect((enriched.find((item) => item.id === "task")?.averageLatencyMs ?? 0)).toBeGreaterThan(1000)
  })

  test("recent failures dampen tool reliability until a later success arrives", async () => {
    await ToolBroker.recordToolOutcome({
      projectID: "broker-project-recent",
      tool: "task",
      source: "subagent",
      success: true,
      durationMs: 200,
    })
    await ToolBroker.recordToolOutcome({
      projectID: "broker-project-recent",
      tool: "task",
      source: "subagent",
      success: true,
      durationMs: 210,
    })
    await ToolBroker.recordToolOutcome({
      projectID: "broker-project-recent",
      tool: "task",
      source: "subagent",
      success: false,
      durationMs: 220,
    })

    const enriched = await ToolBroker.enrichDescriptors({
      projectID: "broker-project-recent",
      tools: [{ id: "task", description: "Delegate work to a subagent", source: "subagent" }],
    })

    const task = enriched[0]
    expect(task.historicalSuccess).toBeGreaterThan(task.recentReliability ?? 0)
    expect(task.sampleSize).toBe(3)
  })

  test("keeps ranking stable after long-session metric accumulation", async () => {
    const projectID = "broker-project-long-session"

    for (let i = 0; i < 60; i++) {
      await ToolBroker.recordToolOutcome({
        projectID,
        tool: "apply_patch",
        source: "builtin",
        success: true,
        durationMs: 70 + (i % 9),
      })
    }

    for (let i = 0; i < 25; i++) {
      await ToolBroker.recordToolOutcome({
        projectID,
        tool: "task",
        source: "subagent",
        success: i % 2 === 0,
        durationMs: 1200 + (i % 7) * 40,
      })
    }

    for (let i = 0; i < 12; i++) {
      await ToolBroker.recordToolOutcome({
        projectID,
        tool: "websearch",
        source: "web",
        success: true,
        durationMs: 380 + i,
      })
    }

    const enriched = await ToolBroker.enrichDescriptors({
      projectID,
      tools: [
        { id: "apply_patch", description: "Apply focused code changes", source: "builtin" },
        { id: "task", description: "Delegate work to a subagent", source: "subagent" },
        { id: "websearch", description: "Search the web", source: "web" },
      ],
    })

    const decision = ToolBroker.decide({
      intent: { type: "implementation", description: "patch bug", complexity: "complex" },
      agent: { name: "general" } as any,
      currentTask: "patch auth middleware and keep edits local",
      tools: enriched,
    })

    const applyPatch = enriched.find((item) => item.id === "apply_patch")
    const task = enriched.find((item) => item.id === "task")

    expect(applyPatch?.sampleSize).toBe(60)
    expect(task?.sampleSize).toBe(25)
    expect(decision.ranked[0]).toBe("apply_patch")
    expect(decision.ranked.indexOf("apply_patch")).toBeLessThan(decision.ranked.indexOf("task"))
  })

  test("recovers persisted metrics after cache reset to simulate process restart", async () => {
    const projectID = "broker-project-restart"

    await ToolBroker.recordToolOutcome({
      projectID,
      tool: "apply_patch",
      source: "builtin",
      success: true,
      durationMs: 55,
    })
    await ToolBroker.recordToolOutcome({
      projectID,
      tool: "apply_patch",
      source: "builtin",
      success: true,
      durationMs: 58,
    })
    await ToolBroker.recordToolOutcome({
      projectID,
      tool: "task",
      source: "subagent",
      success: false,
      durationMs: 2200,
    })

    const beforeReset = await ToolBroker.enrichDescriptors({
      projectID,
      tools: [
        { id: "apply_patch", description: "Apply focused code changes", source: "builtin" },
        { id: "task", description: "Delegate work to a subagent", source: "subagent" },
      ],
    })

    ToolBroker.resetForTest()

    const afterReset = await ToolBroker.enrichDescriptors({
      projectID,
      tools: [
        { id: "apply_patch", description: "Apply focused code changes", source: "builtin" },
        { id: "task", description: "Delegate work to a subagent", source: "subagent" },
      ],
    })

    const applyBefore = beforeReset.find((item) => item.id === "apply_patch")
    const applyAfter = afterReset.find((item) => item.id === "apply_patch")
    const taskAfter = afterReset.find((item) => item.id === "task")

    expect(applyBefore?.sampleSize).toBe(2)
    expect(applyAfter?.sampleSize).toBe(2)
    expect(taskAfter?.sampleSize).toBe(1)

    const decision = ToolBroker.decide({
      intent: { type: "implementation", description: "patch bug", complexity: "moderate" },
      agent: { name: "general" } as any,
      currentTask: "patch local code path and avoid unnecessary delegation",
      tools: afterReset,
    })

    expect(decision.ranked[0]).toBe("apply_patch")
    expect((taskAfter?.averageLatencyMs ?? 0)).toBeGreaterThan(1000)
  })
})