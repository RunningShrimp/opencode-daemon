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
})