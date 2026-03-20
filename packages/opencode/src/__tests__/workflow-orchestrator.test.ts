import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { WorkflowOrchestrator } from "../ai/workflow/orchestrator"

const envKeys = ["XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME"] as const
const originalEnv = new Map<string, string | undefined>()
const cleanup: string[] = []

beforeEach(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-workflow-"))
  cleanup.push(root)
  for (const key of envKeys) originalEnv.set(key, process.env[key])
  process.env.XDG_DATA_HOME = path.join(root, "data-home")
  process.env.XDG_CACHE_HOME = path.join(root, "cache-home")
  process.env.XDG_CONFIG_HOME = path.join(root, "config-home")
  process.env.XDG_STATE_HOME = path.join(root, "state-home")
})

afterEach(async () => {
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

describe("WorkflowOrchestrator", () => {
  test("initializes a structured plan and advances phases", async () => {
    const state = await WorkflowOrchestrator.initialize({
      sessionID: "session_test_workflow",
      prompt: "Inspect the code and then patch the failing path and verify it",
      intent: { type: "implementation", description: "Inspect the code and then patch the failing path and verify it", complexity: "moderate" },
    })

    expect(state.currentPhase).toBe("decompose")
    expect(state.plan.plan.steps[0]?.tasks.length).toBeGreaterThan(0)
    expect(state.plan.plan.steps.some((step) => step.tasks.some((task) => task.status === "in_progress"))).toBeTrue()

    const afterTool = await WorkflowOrchestrator.noteTool("session_test_workflow", "read")
    expect(afterTool?.toolHistory).toContain("read")
    expect(afterTool?.plan.plan.steps.some((step) => step.tasks.some((task) => task.status === "completed"))).toBeTrue()

    const afterVerify = await WorkflowOrchestrator.markVerified("session_test_workflow", true, "supported")
    expect(afterVerify?.currentPhase).toBe("finalize")
    expect(afterVerify?.plan.plan.steps.some((step) => step.tasks.some((task) => task.status === "pending"))).toBeFalse()

    const prompt = WorkflowOrchestrator.renderSystemContext(afterVerify!)
    expect(prompt).toContain("<workflow_state>")
    expect(prompt).toContain("Task graph:")
    expect(prompt).toContain("Fallback plan:")
    expect(prompt).toContain("Current phase: finalize")
    expect(prompt).toContain("supported")
  })

  test("complete() keeps workflow in verify phase when quality gate rejects", async () => {
    await WorkflowOrchestrator.initialize({
      sessionID: "session_test_quality_block",
      prompt: "Inspect the code and then patch the failing path and verify it",
      intent: { type: "implementation", description: "Inspect and patch", complexity: "moderate" },
    })

    await WorkflowOrchestrator.markVerified("session_test_quality_block", true, "supported (0.95)")
    const completed = await WorkflowOrchestrator.complete("session_test_quality_block")

    expect(completed).toBeDefined()
    expect(completed?.gateDecision?.pass).toBeFalse()
    expect(completed?.gateDecision?.status).toBe("rejected")
    expect(completed?.currentPhase).toBe("verify")
    expect(completed?.plan.plan.status).not.toBe("completed")
  })

  test("complete() routes manual_review to executable nextAction phase", async () => {
    await WorkflowOrchestrator.initialize({
      sessionID: "session_test_quality_manual_review",
      prompt: "Inspect the code and then patch the failing path and verify it",
      intent: { type: "implementation", description: "Inspect and patch", complexity: "moderate" },
    })

    for (let i = 0; i < 6; i++) {
      await WorkflowOrchestrator.noteTool("session_test_quality_manual_review", "noop", { success: true })
    }
    await WorkflowOrchestrator.markVerified("session_test_quality_manual_review", true, "supported")

    const completed = await WorkflowOrchestrator.complete("session_test_quality_manual_review")

    expect(completed).toBeDefined()
    expect(completed?.gateDecision?.pass).toBeFalse()
    expect(completed?.gateDecision?.status).toBe("manual_review")
    expect(completed?.gateDecision?.nextAction).toBe("collect_evidence")
    expect(completed?.currentPhase).toBe("reason")

    const prompt = WorkflowOrchestrator.renderSystemContext(completed!)
    expect(prompt).toContain("Quality gate: MANUAL REVIEW")
    expect(prompt).toContain("Next action: collect_evidence")
  })

  test("isolates concurrent sessions and caps tool history in long runs", async () => {
    const sessions = ["session_parallel_a", "session_parallel_b", "session_parallel_c"]

    await Promise.all(
      sessions.map((sessionID, index) =>
        WorkflowOrchestrator.initialize({
          sessionID,
          prompt: `Inspect and patch flow ${index}`,
          intent: { type: "implementation", description: `Inspect and patch flow ${index}`, complexity: "moderate" },
        }),
      ),
    )

    await Promise.all(
      sessions.map(async (sessionID, index) => {
        for (let i = 0; i < 45; i++) {
          await WorkflowOrchestrator.noteTool(sessionID, `tool_${index}_${i}`, { success: i % 3 !== 0 })
        }
        await WorkflowOrchestrator.markVerified(sessionID, true, "supported")
      }),
    )

    const states = await Promise.all(sessions.map((sessionID) => WorkflowOrchestrator.get(sessionID)))

    for (const state of states) {
      expect(state).toBeDefined()
      expect((state?.toolHistory.length ?? 0)).toBeLessThanOrEqual(30)
      expect(state?.toolSuccessCount).toBeGreaterThan(0)
      expect(state?.toolFailureCount).toBeGreaterThan(0)
    }

    expect(states[0]?.toolHistory.join("|")).not.toContain("tool_1_")
    expect(states[1]?.toolHistory.join("|")).not.toContain("tool_2_")
  })

  test("restores workflow state from storage after cache reset", async () => {
    await WorkflowOrchestrator.initialize({
      sessionID: "session_restart_a",
      prompt: "Inspect and patch flow A",
      intent: { type: "implementation", description: "Inspect and patch flow A", complexity: "moderate" },
    })
    await WorkflowOrchestrator.initialize({
      sessionID: "session_restart_b",
      prompt: "Inspect and patch flow B",
      intent: { type: "implementation", description: "Inspect and patch flow B", complexity: "moderate" },
    })

    await WorkflowOrchestrator.noteTool("session_restart_a", "read", { success: true })
    await WorkflowOrchestrator.noteTool("session_restart_a", "apply_patch", { success: true })
    await WorkflowOrchestrator.markVerified("session_restart_a", true, "supported")
    await WorkflowOrchestrator.noteTool("session_restart_b", "grep", { success: false })

    const beforeResetA = await WorkflowOrchestrator.get("session_restart_a")
    expect(beforeResetA).toBeDefined()
    expect(beforeResetA?.toolHistory).toContain("apply_patch")

    WorkflowOrchestrator.resetForTest()

    const afterResetA = await WorkflowOrchestrator.get("session_restart_a")
    const afterResetB = await WorkflowOrchestrator.get("session_restart_b")

    expect(afterResetA).toBeDefined()
    expect(afterResetA?.toolHistory).toEqual(beforeResetA?.toolHistory)
    expect(afterResetA?.currentPhase).toBe(beforeResetA?.currentPhase)
    expect(afterResetA?.latestVerificationVerdict).toBe("supported")

    expect(afterResetB).toBeDefined()
    expect(afterResetB?.toolHistory.join("|")).not.toContain("apply_patch")
    expect(afterResetB?.toolFailureCount).toBeGreaterThan(0)
  })

  test("initializes workflow even when the prompt text is empty", async () => {
    const state = await WorkflowOrchestrator.initialize({
      sessionID: "session_empty_prompt_workflow",
      prompt: "   ",
      intent: {
        type: "implementation",
        description: "Continue the requested image analysis flow",
        complexity: "moderate",
      },
    })

    expect(state.plan.goal).toBe("Continue the requested image analysis flow")
    expect(state.plan.plan.goal).toBe("Continue the requested image analysis flow")
    expect(state.plan.plan.steps.length).toBeGreaterThan(0)
  })
})