import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { messageID, projectInfo, sessionID } from "../test-helpers/ids"

const cleanup: string[] = []
const envKeys = ["XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME", "OPENCODE_EMBEDDING_PROVIDER"] as const
const originalEnv = new Map<string, string | undefined>()

beforeEach(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-evidence-gather-"))
  cleanup.push(root)
  for (const key of envKeys) originalEnv.set(key, process.env[key])
  process.env.XDG_DATA_HOME = path.join(root, "data-home")
  process.env.XDG_CACHE_HOME = path.join(root, "cache-home")
  process.env.XDG_CONFIG_HOME = path.join(root, "config-home")
  process.env.XDG_STATE_HOME = path.join(root, "state-home")
  process.env.OPENCODE_EMBEDDING_PROVIDER = "fallback"
})

afterEach(async () => {
  const { Instance } = await import("../project/instance")
  const { EvidenceLedger } = await import("../ai/evidence/ledger")
  const { WorkflowOrchestrator } = await import("../ai/workflow/orchestrator")
  await Instance.disposeAll().catch(() => undefined)
  EvidenceLedger.resetForTest()
  WorkflowOrchestrator.resetForTest()
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

describe("evidence gather tool", () => {
  test("collects real project evidence instead of mock summaries", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-evidence-gather-workspace-"))
    cleanup.push(workspace)
    const { Instance } = await import("../project/instance")
    const { vectorStore } = await import("../ai/rag/vector-store")
    const { EvidenceGatherTool } = await import("../ai/tools/evidence-gather")

    await Instance.reload({
      directory: workspace,
      worktree: workspace,
      project: projectInfo("evidence-gather-project", workspace),
    })

    await Instance.provide({
      directory: workspace,
      fn: async () => {
        const projectID = Instance.project.id
        await vectorStore.clear(projectID)
        await vectorStore.addVectors([
          {
            id: "vec-1",
            sessionId: projectID,
            path: "src/auth.ts",
            content: "export function auth() { return loadSession() }",
            embedding: await (await import("../ai/rag/embedding")).embeddingService.getEmbedding("auth session loader"),
            timestamp: Date.now(),
            startLine: 1,
            endLine: 1,
          },
        ])

        const tool = await EvidenceGatherTool.init()
        const result = await tool.execute(
          {
            hypothesis: "auth reaches the session loader",
            searchQuery: "auth session loader",
            sourceTypes: ["code"],
            minRelevance: 0.1,
          },
          {
            sessionID: sessionID("session-evidence"),
            messageID: messageID("message-evidence"),
            agent: "build",
            abort: new AbortController().signal,
            messages: [],
            metadata() {},
            ask: async () => {},
          },
        )

        expect(result.output).toContain("src/auth.ts:1")
        expect(result.output).not.toContain("The code confirms that the implementation follows the expected pattern")
      },
    })
  })
})