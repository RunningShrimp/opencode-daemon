import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { projectID, sessionID, workspaceID } from "../test-helpers/ids"

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
        id: projectID("session-system-context-project"),
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
        const activeSessionID = sessionID("session-system-context")
        const previousSessionID = sessionID("session-prev-runtime")
        const runtimeWorkspaceID = workspaceID("workspace_review_runtime")
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
              id: runtimeWorkspaceID,
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
                id: activeSessionID,
                project_id: projectID,
                workspace_id: runtimeWorkspaceID,
                slug: "session-system-context",
                directory: path.join(workspace, ".worktree-review"),
                title: "Current runtime patch",
                version: "test",
                time_created: now,
                time_updated: now,
              },
              {
                id: previousSessionID,
                project_id: projectID,
                workspace_id: runtimeWorkspaceID,
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
          sessionID: activeSessionID,
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
          sessionID: activeSessionID,
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
          sessionID: activeSessionID,
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
        id: projectID("session-system-context-question-project"),
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
          sessionID: sessionID("question-session"),
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
      },
    })
  })

  test("uses lightweight delegated context for child sessions before the first assistant turn", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-session-system-context-child-"))
    cleanup.push(workspace)
    await fs.mkdir(path.join(workspace, "src"), { recursive: true })
    await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: "child-context-demo" }, null, 2), "utf8")
    await fs.writeFile(path.join(workspace, "src", "index.ts"), "export const value = 1\n", "utf8")

    const { Instance } = await import("../project/instance")
    const { SessionPrompt } = await import("../session/prompt")
    const { bootstrapProjectMemory } = await import("../ai/memory/project-memory-bootstrap")
    const { WorkflowOrchestrator } = await import("../ai/workflow/orchestrator")
    const { LearningStore } = await import("../ai/memory/learning-store")
    const { createKnowledgeGraph } = await import("../ai/knowledge/index")
    const { refreshDerivedKnowledgeGraph } = await import("../ai/knowledge/derived")
    const { Database } = await import("../storage/db")
    const { ProjectTable } = await import("../project/project.sql")
    const { SessionTable } = await import("../session/session.sql")

    await Instance.reload({
      directory: workspace,
      worktree: workspace,
      project: {
        id: projectID("session-system-context-child-project"),
        worktree: workspace,
        vcs: "git",
        name: "Child Context Demo",
        commands: {},
        time: { created: Date.now(), updated: Date.now() },
        sandboxes: [],
      },
    })

    await Instance.provide({
      directory: workspace,
      fn: async () => {
        const parentSessionID = sessionID("parent-session")
        const childSessionID = sessionID("child-session")
        const projectID = Instance.project.id
        const now = Date.now()
        const intent = {
          type: "implementation" as const,
          description: "Create implementation plan",
          complexity: "complex" as const,
        }
        const userInput = "You are Member A of a two-person team. Create the implementation plan and do not ask questions."
        const graph = createKnowledgeGraph()

        Database.use((db) => {
          db.insert(ProjectTable)
            .values({
              id: projectID,
              worktree: workspace,
              vcs: "git",
              name: "Child Context Demo",
              sandboxes: [],
              time_created: now,
              time_updated: now,
              time_initialized: now,
            })
            .onConflictDoNothing()
            .run()
          db.insert(SessionTable)
            .values([
              {
                id: parentSessionID,
                project_id: projectID,
                slug: "parent-session",
                directory: workspace,
                title: "Parent session",
                version: "test",
                time_created: now - 1000,
                time_updated: now - 1000,
              },
              {
                id: childSessionID,
                project_id: projectID,
                parent_id: parentSessionID,
                slug: "child-session",
                directory: workspace,
                title: "Child delegated session",
                version: "test",
                time_created: now,
                time_updated: now,
              },
            ])
            .onConflictDoNothing()
            .run()
        })

        await bootstrapProjectMemory({
          projectID,
          rootDir: workspace,
          projectName: Instance.project.name,
          startCommand: undefined,
        })
        await WorkflowOrchestrator.initialize({
          sessionID: childSessionID,
          prompt: userInput,
          intent,
        })
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
          tool: "task",
          success: true,
          description: "Delegate plan work",
          output: "delegated",
          duration: 10,
          complexity: "complex",
        })
        await LearningStore.finishTask(projectID, true)
        await refreshDerivedKnowledgeGraph(graph, workspace)

        expect(
          SessionPrompt.shouldUseDelegatedTurnFastPath({
            parentID: parentSessionID,
            hasAssistant: false,
          }),
        ).toBe(true)
        expect(
          SessionPrompt.shouldUseDelegatedTurnFastPath({
            parentID: parentSessionID,
            hasAssistant: true,
          }),
        ).toBe(false)

        const built = await SessionPrompt.buildCapabilitySystemPrompts({
          sessionID: childSessionID,
          projectID,
          rootDir: workspace,
          userInput,
          intent,
          turnControlComplexity: "complex",
          agent: { name: "plan", mode: "subagent" } as any,
          knowledgeGraph: graph,
          toolDescriptors: [
            { id: "task", description: "Delegate to subagent", source: "subagent" },
            { id: "read", description: "Read files", source: "builtin" },
          ],
          autoGroundingSystemPrompt: "<retrieved_context>delegated child turn</retrieved_context>",
          lightweightDelegatedTurn: true,
        })

        const combined = [built.personalityPrompt, ...built.prompts].join("\n\n")
        expect(combined).toContain("<workflow_state>")
        expect(combined).toContain("<workspace_context>")
        expect(combined).toContain("<tool_broker>")
        expect(combined).not.toContain("<knowledge_graph>")
        expect(combined).not.toContain("<learned_strategies>")
        expect(combined).not.toContain("<retrieved_context>")
        expect(built.callouts.map((item) => item.metadata?.capability)).toEqual([
          "workspace_intelligence",
          "tool_broker",
        ])
      },
    })
  })
})