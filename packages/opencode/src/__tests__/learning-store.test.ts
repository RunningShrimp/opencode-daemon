import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const cleanup: string[] = []
const envKeys = ["XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME"] as const
const originalEnv = new Map<string, string | undefined>()

beforeEach(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-learning-store-"))
  cleanup.push(root)
  for (const key of envKeys) originalEnv.set(key, process.env[key])
  process.env.XDG_DATA_HOME = path.join(root, "data-home")
  process.env.XDG_CACHE_HOME = path.join(root, "cache-home")
  process.env.XDG_CONFIG_HOME = path.join(root, "config-home")
  process.env.XDG_STATE_HOME = path.join(root, "state-home")
})

afterEach(async () => {
  const { LearningStore } = await import("../ai/memory/learning-store")
  const { resetLearningContextCache } = await import("../ai/memory/learning-context")
  LearningStore.resetForTest()
  resetLearningContextCache()
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

describe("LearningStore", () => {
  test("renders project-aware strategies using inferred framework and language", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-learning-store-workspace-"))
    cleanup.push(workspace)
    await fs.mkdir(path.join(workspace, "src"), { recursive: true })
    await fs.writeFile(
      path.join(workspace, "package.json"),
      JSON.stringify({
        dependencies: {
          react: "^19.0.0",
        },
      }),
      "utf8",
    )
    await fs.writeFile(path.join(workspace, "src", "app.tsx"), "export function App() { return null }\n", "utf8")

    const { LearningStore } = await import("../ai/memory/learning-store")

    await LearningStore.startTask({
      projectID: "learning-project",
      rootDir: workspace,
      taskType: "implementation",
      complexity: "complex",
    })

    for (let index = 0; index < 4; index++) {
      await LearningStore.recordToolExecution({
        projectID: "learning-project",
        rootDir: workspace,
        taskType: "implementation",
        tool: "apply_patch",
        success: true,
        description: "Patch React TypeScript component",
        output: "component patched",
        duration: 10,
        complexity: "complex",
      })
    }

    await LearningStore.recordToolExecution({
      projectID: "learning-project",
      rootDir: workspace,
      taskType: "debugging",
      tool: "bash",
      success: true,
      description: "Run Python diagnostics",
      output: "diagnostics complete",
      duration: 10,
      language: "python",
      framework: "django",
      complexity: "moderate",
    })

    await LearningStore.finishTask("learning-project", true)

    const prompt = await LearningStore.renderPromptContext({
      projectID: "learning-project",
      rootDir: workspace,
      taskType: "implementation",
      complexity: "complex",
    })

    expect(prompt).toContain("language=typescript")
    expect(prompt).toContain("framework=react")
    expect(prompt).toContain("Patch React TypeScript component")
    expect(prompt).not.toContain("Run Python diagnostics")
  })

  test("computes cross-project transfer candidates with admission and decay rules", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-learning-transfer-workspace-"))
    cleanup.push(workspace)
    await fs.mkdir(path.join(workspace, "src"), { recursive: true })
    await fs.writeFile(
      path.join(workspace, "package.json"),
      JSON.stringify({ dependencies: { react: "^19.0.0" } }),
      "utf8",
    )
    await fs.writeFile(path.join(workspace, "src", "app.tsx"), "export const x = 1\n", "utf8")

    const { LearningStore } = await import("../ai/memory/learning-store")

    // Seed source project with strong implementation pattern (>= threshold)
    await LearningStore.startTask({
      projectID: "source-learning-project",
      rootDir: workspace,
      taskType: "implementation",
      complexity: "complex",
    })
    for (let i = 0; i < 4; i++) {
      await LearningStore.recordToolExecution({
        projectID: "source-learning-project",
        rootDir: workspace,
        taskType: "implementation",
        tool: "apply_patch",
        success: true,
        description: "Apply focused patch set",
        output: "patched",
        duration: 12,
        complexity: "complex",
      })
    }
    await LearningStore.finishTask("source-learning-project", true)

    const admitted = await LearningStore.getTransferCandidates({
      targetProjectID: "target-learning-project",
      sourceProjectIDs: ["source-learning-project"],
      rootDir: workspace,
      taskType: "implementation",
      complexity: "complex",
      minConfidence: 0.3,
      limit: 3,
    })

    expect(admitted.length).toBeGreaterThan(0)
    expect(admitted[0].sourceProjectID).toBe("source-learning-project")
    expect(admitted[0].confidence).toBeGreaterThan(0)

    // Task mismatch (implementation -> debugging) should be rejected by admission rule.
    const mismatched = await LearningStore.getTransferCandidates({
      targetProjectID: "target-learning-project",
      sourceProjectIDs: ["source-learning-project"],
      rootDir: workspace,
      taskType: "debugging",
      complexity: "complex",
      minConfidence: 0.3,
      limit: 3,
    })

    expect(mismatched.length).toBe(0)

    // Simulate stale age and strict decay window.
    const stale = await LearningStore.getTransferCandidates({
      targetProjectID: "target-learning-project",
      sourceProjectIDs: ["source-learning-project"],
      rootDir: workspace,
      taskType: "implementation",
      complexity: "complex",
      minConfidence: 0.3,
      maxAgeDays: 2,
      now: Date.now() + 200 * 24 * 60 * 60 * 1000,
      limit: 3,
    })

    expect(stale.length).toBe(0)
  })

  test("rejects transfer candidates with framework-conflicting action semantics", async () => {
    const sourceWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-learning-transfer-source-"))
    const targetWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-learning-transfer-target-"))
    cleanup.push(sourceWorkspace)
    cleanup.push(targetWorkspace)

    await fs.writeFile(
      path.join(targetWorkspace, "package.json"),
      JSON.stringify({ dependencies: { react: "18.0.0" } }),
      "utf8",
    )
    await fs.writeFile(path.join(targetWorkspace, "tsconfig.json"), JSON.stringify({ compilerOptions: {} }), "utf8")

    const { LearningStore } = await import("../ai/memory/learning-store")

    await LearningStore.startTask({
      projectID: "source-semantic-conflict",
      rootDir: sourceWorkspace,
      taskType: "implementation",
      complexity: "moderate",
    })

    for (let i = 0; i < 4; i++) {
      await LearningStore.recordToolExecution({
        projectID: "source-semantic-conflict",
        rootDir: sourceWorkspace,
        taskType: "implementation",
        tool: "apply_patch",
        success: true,
        description: "Patch Django middleware auth pipeline",
        output: "patched",
        duration: 10,
        complexity: "moderate",
      })
    }

    await LearningStore.finishTask("source-semantic-conflict", true)

    const mismatchedFramework = await LearningStore.getTransferCandidates({
      targetProjectID: "target-react-project",
      sourceProjectIDs: ["source-semantic-conflict"],
      rootDir: targetWorkspace,
      taskType: "implementation",
      complexity: "moderate",
      minConfidence: 0.3,
      limit: 3,
    })

    expect(mismatchedFramework.length).toBe(0)
  })

  test("rejects transfer candidates with task-semantic conflict when conditions are sparse", async () => {
    const sourceWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-learning-transfer-source-task-"))
    const targetWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-learning-transfer-target-task-"))
    cleanup.push(sourceWorkspace)
    cleanup.push(targetWorkspace)

    await fs.writeFile(
      path.join(targetWorkspace, "package.json"),
      JSON.stringify({ dependencies: { react: "18.0.0" } }),
      "utf8",
    )

    const { LearningStore } = await import("../ai/memory/learning-store")

    await LearningStore.startTask({
      projectID: "source-task-semantic-conflict",
      rootDir: sourceWorkspace,
      taskType: "debugging",
      complexity: "complex",
    })

    for (let i = 0; i < 4; i++) {
      await LearningStore.recordToolExecution({
        projectID: "source-task-semantic-conflict",
        rootDir: sourceWorkspace,
        taskType: "debugging",
        tool: "bash",
        success: true,
        description: "Debug production incident and triage regression traces",
        output: "diagnostics complete",
        duration: 11,
        complexity: "complex",
      })
    }

    await LearningStore.finishTask("source-task-semantic-conflict", true)

    const mismatchedTask = await LearningStore.getTransferCandidates({
      targetProjectID: "target-task-project",
      sourceProjectIDs: ["source-task-semantic-conflict"],
      rootDir: targetWorkspace,
      taskType: "implementation",
      complexity: "complex",
      minConfidence: 0.3,
      limit: 3,
    })

    expect(mismatchedTask.length).toBe(0)
  })

  test("keeps aligned transfer candidates when framework and task semantics match", async () => {
    const sourceWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-learning-transfer-source-aligned-"))
    const targetWorkspace = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-learning-transfer-target-aligned-"))
    cleanup.push(sourceWorkspace)
    cleanup.push(targetWorkspace)

    await fs.writeFile(
      path.join(sourceWorkspace, "package.json"),
      JSON.stringify({ dependencies: { react: "18.0.0" } }),
      "utf8",
    )
    await fs.writeFile(
      path.join(targetWorkspace, "package.json"),
      JSON.stringify({ dependencies: { react: "18.0.0" } }),
      "utf8",
    )

    const { LearningStore } = await import("../ai/memory/learning-store")

    await LearningStore.startTask({
      projectID: "source-task-semantic-aligned",
      rootDir: sourceWorkspace,
      taskType: "implementation",
      complexity: "moderate",
    })

    for (let i = 0; i < 4; i++) {
      await LearningStore.recordToolExecution({
        projectID: "source-task-semantic-aligned",
        rootDir: sourceWorkspace,
        taskType: "implementation",
        tool: "apply_patch",
        success: true,
        description: "Implement React auth provider patch",
        output: "patched",
        duration: 9,
        complexity: "moderate",
      })
    }

    await LearningStore.finishTask("source-task-semantic-aligned", true)

    const aligned = await LearningStore.getTransferCandidates({
      targetProjectID: "target-task-aligned",
      sourceProjectIDs: ["source-task-semantic-aligned"],
      rootDir: targetWorkspace,
      taskType: "implementation",
      complexity: "moderate",
      minConfidence: 0.3,
      limit: 3,
    })

    expect(aligned.length).toBeGreaterThan(0)
    expect(aligned[0].sourceProjectID).toBe("source-task-semantic-aligned")
  })
})