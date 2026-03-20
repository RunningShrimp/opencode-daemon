import { describe, expect, test } from "bun:test"
import { SelfDrivenAgent } from "../ai/thinking/self-driven-agent"

describe("SelfDrivenAgent", () => {
  const createAgent = async (sessionID: string) => {
    const agent = new SelfDrivenAgent()
    await agent.initialize({
      userInput: "Fix the failing integration path",
      intent: {
        type: "implementation",
        description: "Fix integration path",
        complexity: "moderate",
      },
      history: [],
      model: { providerID: "test", modelID: "test-model" } as any,
      sessionID,
    })
    return agent
  }

  test("requests focused user clarification after repeated failures", async () => {
    const agent = await createAgent("session-self-driven-test")

    await agent.onAfterToolExecution("read", false, "first failure")
    await agent.onAfterToolExecution("grep", false, "second failure")
    const afterThirdFailure = await agent.onAfterToolExecution("edit", false, "third failure")
    const beforeCall = await agent.onBeforeLLMCall()

    expect(afterThirdFailure.adaptation).toContain("Ask the user for a focused clarification")
    expect(beforeCall.enhancedContext.needsUserInput).toBe(true)
    expect(beforeCall.promptGuidance).toContain("ask the user one focused clarification")
  })

  test("keeps autonomous flow on consecutive successful tool executions", async () => {
    const agent = await createAgent("session-self-driven-success")

    const first = await agent.onAfterToolExecution("read", true, "ok")
    const second = await agent.onAfterToolExecution("grep", true, "ok")
    const third = await agent.onAfterToolExecution("edit", true, "ok")
    const beforeCall = await agent.onBeforeLLMCall()

    expect(first.adaptation).toBeUndefined()
    expect(second.adaptation).toBeUndefined()
    expect(third.adaptation).toBeUndefined()
    expect(beforeCall.enhancedContext.needsUserInput).toBe(false)
    expect(beforeCall.promptGuidance).toBeUndefined()
  })

  test("recovers from clarification-needed state after successful execution", async () => {
    const agent = await createAgent("session-self-driven-recovery")

    await agent.onAfterToolExecution("read", false, "first failure")
    await agent.onAfterToolExecution("grep", false, "second failure")
    await agent.onAfterToolExecution("edit", false, "third failure")

    const blocked = await agent.onBeforeLLMCall()
    expect(blocked.enhancedContext.needsUserInput).toBe(true)

    await agent.onAfterToolExecution("read", true, "recovered")
    const recovered = await agent.onBeforeLLMCall()

    expect(recovered.enhancedContext.needsUserInput).toBe(false)
    expect(recovered.promptGuidance).toBeUndefined()
  })

  test("stays stable across multi-round tool gate and step completion loop", async () => {
    const agent = await createAgent("session-self-driven-multiround")

    await agent.onAfterToolExecution("read", false, "first failure")
    await agent.onAfterToolExecution("grep", false, "second failure")
    const beforeThirdFailure = await agent.onBeforeLLMCall()
    expect(beforeThirdFailure.enhancedContext.needsUserInput).toBe(false)

    await agent.onAfterToolExecution("edit", false, "third failure")
    const blocked = await agent.onBeforeLLMCall()
    expect(blocked.enhancedContext.needsUserInput).toBe(true)

    await agent.onStepComplete()
    await agent.onAfterToolExecution("edit", true, "success after clarify")
    const unblocked = await agent.onBeforeLLMCall()
    expect(unblocked.enhancedContext.needsUserInput).toBe(false)

    const report = await agent.onTaskComplete(true)
    expect(report).toContain("Agent Self-Driving Diagnostic Report")
  })

  test("extracts English next-step and remaining-task paragraphs into continuation state", async () => {
    const agent = await createAgent("session-self-driven-carryover-en")

    const status = await agent.getAutonomousContinuationState([
      {
        role: "assistant",
        content:
          "Implemented the parser.\n\nNext step: rerun the focused test suite for prompt continuation.\n\nRemaining tasks:\n- rebuild the packaged binary\n- verify logs stay clean",
      },
    ])

    expect(status.hasNextRoundTask).toBe(true)
    expect(status.carryoverSegments).toHaveLength(2)
    expect(status.carryoverSegments[0]?.text).toContain("Next step")
    expect(status.carryoverSegments[1]?.text).toContain("Remaining tasks")
    expect(status.currentStatus).toContain("nextRoundTask=yes")
  })

  test("extracts Chinese continuation paragraphs and exposes current status", async () => {
    const agent = await createAgent("session-self-driven-carryover-zh")

    const beforeCall = await agent.onBeforeLLMCall([
      {
        role: "assistant",
        content: "本轮已完成主要修复。\n\n下一步：补充回归测试。\n\n剩余任务：重新构建二进制并检查日志。",
      },
    ])

    expect(beforeCall.status.hasNextRoundTask).toBe(true)
    expect(beforeCall.status.carryoverSegments.map((segment) => segment.text).join("\n")).toContain("下一步：补充回归测试")
    expect(beforeCall.enhancedContext.currentStatus).toBe(beforeCall.status.currentStatus)
    expect(beforeCall.enhancedContext.carryoverKeywords).toEqual(["next_step", "remaining_work"])
    expect(beforeCall.enhancedContext.carryoverSegmentCount).toBe(2)
    expect(beforeCall.enhancedContext.suggestedNextAction).toBe("下一步：补充回归测试。")
    expect(beforeCall.enhancedContext.carryoverSegments).toBeUndefined()
  })

  test("preserves file paths when extracting next-round action from assistant summaries", async () => {
    const agent = new SelfDrivenAgent()

    const status = await agent.getAutonomousContinuationState([
      {
        role: "assistant",
        content:
          "Phase 0 complete (16/16 tasks committed, 74/75 tests pass). `crates/agent/` has P1-001–P1-007 already implemented. Next round: read `crates/review/src/lib.rs`, `crates/indexing/src/lib.rs`, `crates/analysis/src/lint.rs` in parallel to assess Phase 1 readiness, then create the Phase 1 todo list.",
      },
    ])

    expect(status.hasNextRoundTask).toBe(true)
    expect(status.suggestedNextAction).toContain("crates/review/src/lib.rs")
    expect(status.suggestedNextAction).toContain("crates/indexing/src/lib.rs")
    expect(status.suggestedNextAction).toContain("crates/analysis/src/lint.rs")
    expect(status.suggestedNextAction).toContain("create the Phase 1 todo list")
  })

  test("continues autonomously when Chinese next-step text follows a completion summary", async () => {
    const agent = new SelfDrivenAgent()

    const status = await agent.getAutonomousContinuationState([
      {
        role: "assistant",
        content: "本轮已完成主要修复。\n\n下一步：补充回归测试。\n\n剩余任务：重新构建二进制并检查日志。",
      },
    ])

    expect(status.hasNextRoundTask).toBe(true)
    expect(status.stopReason).toBeUndefined()
    expect(status.carryoverSegments.map((segment) => segment.text)).toEqual([
      "下一步：补充回归测试。",
      "剩余任务：重新构建二进制并检查日志。",
    ])
  })

  test("stops autonomous continuation when only a rollover handoff summary remains", async () => {
    const agent = new SelfDrivenAgent()

    const status = await agent.getAutonomousContinuationState([
      {
        role: "assistant",
        content: [
          "## Work Completed Summary",
          "",
          "Summary of what has been accomplished so far:",
          "- Read the latest implementation plan and review report.",
          "- Created the todolist and started implementation.",
          "",
          "Remaining tasks that were not completed:",
          "- Resolve the dependency-injection compilation errors.",
          "- Rerun the failing test suite.",
          "",
          "The exact next step if autonomous work should continue in the next round:",
          "Fix the compilation errors immediately, then rerun the existing test suite.",
          "",
          "Recommendations for what should be done next:",
          "1. Fix the compilation errors.",
          "2. Resume the remaining implementation tasks.",
        ].join("\n"),
      },
    ])

    expect(status.hasNextRoundTask).toBe(false)
    expect(status.stopReason).toContain("rollover handoff summary")
    expect(status.carryoverSegments).toHaveLength(0)
  })

  test("stops autonomous continuation when no next-round task is detected", async () => {
    const agent = new SelfDrivenAgent()

    const status = await agent.getAutonomousContinuationState([
      {
        role: "assistant",
        content: "All done. No next step. No remaining tasks.",
      },
    ])

    expect(status.hasNextRoundTask).toBe(false)
    expect(status.stopReason).toContain("no next-round task")
    expect(status.currentStatus).toContain("nextRoundTask=no")
  })

  test("stops autonomous continuation when the report is complete and only optional background follow-up remains", async () => {
    const agent = new SelfDrivenAgent()

    const status = await agent.getAutonomousContinuationState([
      {
        role: "assistant",
        content: [
          "The full 11-section audit report has been delivered above.",
          "Background agent bg_edba6db2 may still complete later and can supplement TD-001 if it does.",
          "No further action required unless the user requests implementation of specific tasks.",
        ].join("\n\n"),
      },
    ])

    expect(status.hasNextRoundTask).toBe(false)
    expect(status.stopReason).toContain("no next-round task")
  })
})