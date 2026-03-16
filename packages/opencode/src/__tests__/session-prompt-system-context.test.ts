import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const cleanup: string[] = []
const envKeys = ["XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME"] as const
const originalEnv = new Map<string, string | undefined>()

beforeEach(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-session-system-context-"))
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
  const { LearningStore } = await import("../ai/memory/learning-store")
  const { resetLearningContextCache } = await import("../ai/memory/learning-context")
  const { EvidenceLedger } = await import("../ai/evidence/ledger")
  const { WorkflowOrchestrator } = await import("../ai/workflow/orchestrator")
  const { ToolBroker } = await import("../ai/tool-broker")

  ProjectMemory.resetForTest()
  LearningStore.resetForTest()
  resetLearningContextCache()
  EvidenceLedger.resetForTest()
  WorkflowOrchestrator.resetForTest()
  ToolBroker.resetForTest()
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

describe("SessionPrompt.buildCapabilitySystemPrompts", () => {
  test("assembles main-chain system context in the expected order", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-session-system-context-workspace-"))
    cleanup.push(workspace)
    await fs.mkdir(path.join(workspace, "src"), { recursive: true })
    await fs.mkdir(path.join(workspace, "docs"), { recursive: true })
    await fs.writeFile(
      path.join(workspace, "package.json"),
      JSON.stringify(
        {
          name: "context-demo",
          description: "Prompt context integration demo",
          scripts: { dev: "bun run dev" },
          dependencies: { zod: "^3.0.0", react: "^19.0.0" },
        },
        null,
        2,
      ),
      "utf8",
    )
    await fs.writeFile(
      path.join(workspace, "src", "index.tsx"),
      'import { z } from "zod"\nexport function App() { return z.string().parse("ok") }\n',
      "utf8",
    )
    await fs.writeFile(path.join(workspace, "README.md"), "# Context Demo\n\n## Runtime Notes\n", "utf8")

    const { Instance } = await import("../project/instance")
    const { SessionPrompt } = await import("../session/prompt")
    const { bootstrapProjectMemory } = await import("../ai/memory/project-memory-bootstrap")
    const { WorkflowOrchestrator } = await import("../ai/workflow/orchestrator")
    const { LearningStore } = await import("../ai/memory/learning-store")
    const { EvidenceLedger } = await import("../ai/evidence/ledger")
    const { createEvidence, EvidenceSource } = await import("../ai/thinking/evidence")
    const { createKnowledgeGraph } = await import("../ai/knowledge/index")
    const { refreshDerivedKnowledgeGraph } = await import("../ai/knowledge/derived")
    const { ToolBroker } = await import("../ai/tool-broker")
    const { Database } = await import("../storage/db")
    const { ProjectTable } = await import("../project/project.sql")
    const { SessionTable } = await import("../session/session.sql")
    const { WorkspaceTable } = await import("../control-plane/workspace.sql")

    await Instance.reload({
      directory: workspace,
      worktree: workspace,
      project: {
        id: "session-system-context-project",
        worktree: workspace,
        vcs: "git",
        name: "Context Demo",
        commands: { start: "bun run dev" },
        time: { created: Date.now(), updated: Date.now() },
        sandboxes: [],
      },
    })

    await Instance.provide({
      directory: workspace,
      fn: async () => {
        const sessionID = "session-system-context"
        const projectID = Instance.project.id
        const now = Date.now()
        const intent = {
          type: "implementation" as const,
          description: "Patch the runtime validation path",
          complexity: "complex" as const,
        }
        const userInput = "Patch the runtime validation path, keep the API stable, and explain the runtime notes."

        const graph = createKnowledgeGraph()

        Database.use((db) => {
          db.insert(ProjectTable)
            .values({
              id: projectID,
              worktree: workspace,
              vcs: "git",
              name: "Context Demo",
              sandboxes: [],
              time_created: now,
              time_updated: now,
              time_initialized: now,
            })
            .onConflictDoNothing()
            .run()
          db.insert(WorkspaceTable)
            .values({
              id: "workspace_review_runtime",
              type: "worktree",
              branch: "review/runtime-notes",
              name: "Runtime Review",
              directory: path.join(workspace, ".worktree-review"),
              extra: null,
              project_id: projectID,
            })
            .onConflictDoNothing()
            .run()
          db.insert(SessionTable)
            .values([
              {
                id: sessionID,
                project_id: projectID,
                workspace_id: "workspace_review_runtime",
                slug: "session-system-context",
                directory: path.join(workspace, ".worktree-review"),
                title: "Current runtime patch",
                version: "test",
                time_created: now,
                time_updated: now,
              },
              {
                id: "session-prev-runtime",
                project_id: projectID,
                workspace_id: "workspace_review_runtime",
                slug: "prev-runtime",
                directory: path.join(workspace, ".worktree-review"),
                title: "Previous runtime notes",
                version: "test",
                time_created: now - 1000,
                time_updated: now - 1000,
              },
            ])
            .onConflictDoNothing()
            .run()
        })

        await bootstrapProjectMemory({
          projectID,
          rootDir: workspace,
          projectName: Instance.project.name,
          startCommand: Instance.project.commands?.start,
        })
        await WorkflowOrchestrator.initialize({
          sessionID,
          prompt: userInput,
          intent,
        })
        graph.clear()
        await refreshDerivedKnowledgeGraph(graph, workspace)
        await LearningStore.startTask({
          projectID,
          rootDir: workspace,
          taskType: "implementation",
          complexity: "complex",
        })
        await LearningStore.recordToolExecution({
          projectID,
          rootDir: workspace,
          taskType: "implementation",
          tool: "apply_patch",
          success: true,
          description: "Patch React validation path",
          output: "validation path patched",
          duration: 25,
          complexity: "complex",
        })
        await LearningStore.finishTask(projectID, true)
        await EvidenceLedger.recordEvidenceCollection({
          sessionID,
          projectID,
          hypothesis: "Runtime validation lives in src/index.tsx and depends on zod.",
          evidence: [
            createEvidence(EvidenceSource.CODEBASE, "src/index.tsx imports zod and parses a string.", 0.92, undefined, {
              quote: 'import { z } from "zod"',
              location: "src/index.tsx:1",
            }),
          ],
          confidence: 0.9,
          source: "retrieval",
        })
        await ToolBroker.recordToolOutcome({
          projectID,
          tool: "apply_patch",
          source: "builtin",
          success: true,
          durationMs: 40,
        })

        const built = await SessionPrompt.buildCapabilitySystemPrompts({
          sessionID,
          projectID,
          rootDir: workspace,
          userInput,
          intent,
          turnControlComplexity: "complex",
          agent: { name: "build", mode: "primary" } as any,
          knowledgeGraph: graph,
          toolDescriptors: [
            { id: "apply_patch", description: "Apply code changes", source: "builtin" },
            { id: "rag_query", description: "Search indexed code and docs", source: "retrieval" },
            { id: "task", description: "Delegate to subagent", source: "subagent" },
          ],
        })

        const combined = [built.personalityPrompt, ...built.prompts].join("\n\n")

        expect(combined).toContain("<personality>")
        expect(combined).toContain("<workflow_state>")
        expect(combined).toContain("<project_memory>")
        expect(combined).toContain("<workspace_context>")
        expect(combined).toContain("<knowledge_graph>")
        expect(combined).toContain("<learned_strategies>")
        expect(combined).toContain("<tool_broker>")
        expect(combined).toContain("<evidence_ledger>")
        expect(built.callouts.map((item) => item.metadata?.capability)).toEqual([
          "project_memory",
          "workspace_intelligence",
          "knowledge_graph_context",
          "tool_broker",
        ])
        expect(combined).toContain("Runtime Review")
        expect(combined).toContain("Previous runtime notes")

        expect(combined.indexOf("<workflow_state>")).toBeLessThan(combined.indexOf("<project_memory>"))
        expect(combined.indexOf("<project_memory>")).toBeLessThan(combined.indexOf("<workspace_context>"))
        expect(combined.indexOf("<workspace_context>")).toBeLessThan(combined.indexOf("<knowledge_graph>"))
        expect(combined.indexOf("<knowledge_graph>")).toBeLessThan(combined.indexOf("<learned_strategies>"))
        expect(combined.indexOf("<learned_strategies>")).toBeLessThan(combined.indexOf("<tool_broker>"))
        expect(combined.indexOf("<tool_broker>")).toBeLessThan(combined.indexOf("<evidence_ledger>"))
      },
    })
  })

  test("adds concise response guidance for direct question turns", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-session-system-context-question-"))
    cleanup.push(workspace)

    const { Instance } = await import("../project/instance")
    const { SessionPrompt } = await import("../session/prompt")

    await Instance.reload({
      directory: workspace,
      worktree: workspace,
      project: {
        id: "session-system-context-question-project",
        worktree: workspace,
        vcs: "git",
        name: "Question Demo",
        commands: {},
        time: { created: Date.now(), updated: Date.now() },
        sandboxes: [],
      },
    })

    await Instance.provide({
      directory: workspace,
      fn: async () => {
        const built = await SessionPrompt.buildCapabilitySystemPrompts({
          sessionID: "question-session",
          projectID: Instance.project.id,
          rootDir: workspace,
          userInput: "What does this repo do?",
          intent: { type: "exploration", query: "What does this repo do?", mode: "question" },
          turnControlComplexity: "simple",
          agent: { name: "build", mode: "primary" } as any,
          toolDescriptors: [],
        })

        const combined = [built.personalityPrompt, ...built.prompts].join("\n\n")
        expect(combined).toContain("<response_style>")
        expect(combined).toContain("Answer directly and keep the default response concise.")
        expect(built.callouts).toHaveLength(0)
      },
    })
  })
})