import { describe, expect, test } from "bun:test"
import { MessageV2 } from "../session/message-v2"
import { messageID, modelID, partID, providerID, sessionID } from "../test-helpers/ids"

function createModel() {
  return {
    id: modelID("test-model"),
    providerID: providerID("openai"),
    api: {
      id: "test-model",
      url: "https://example.invalid",
      npm: "@ai-sdk/openai-compatible",
    },
    name: "Test Model",
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: {
      input: 0,
      output: 0,
      cache: { read: 0, write: 0 },
    },
    limit: {
      context: 128000,
      output: 4096,
    },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-01-01",
  } as any
}

function createAssistantWithParts(parts: MessageV2.Part[]): MessageV2.WithParts {
  return {
    info: {
      id: messageID("msg_1"),
      sessionID: sessionID("ses_1"),
      role: "assistant",
      mode: "build",
      agent: "build",
      path: {
        cwd: "/tmp",
        root: "/tmp",
      },
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      modelID: modelID("test-model"),
      providerID: providerID("openai"),
      time: {
        created: 0,
        completed: 0,
      },
    },
    parts,
  } as MessageV2.WithParts
}

function createUserWithParts(id: string, parts: MessageV2.Part[]): MessageV2.WithParts {
  return {
    info: {
      id: messageID(id),
      sessionID: sessionID("ses_1"),
      role: "user",
      time: {
        created: 0,
      },
      agent: "build",
      model: {
        providerID: providerID("openai"),
        modelID: modelID("test-model"),
      },
    },
    parts,
  } as MessageV2.WithParts
}

describe("MessageV2.toModelMessages", () => {
  test("excludes internal tool callouts from model-visible history", () => {
    const internalTool: MessageV2.ToolPart = {
      id: partID("part_internal"),
      sessionID: sessionID("ses_1"),
      messageID: messageID("msg_1"),
      type: "tool",
      callID: "call_internal",
      tool: "self_driven",
      state: {
        status: "completed",
        input: { phase: "sensing" },
        output: "Prepared self-driven context for the next model call.",
        title: "Self-driven state prepared",
        metadata: {
          internal: true,
        },
        time: {
          start: 0,
          end: 0,
        },
      },
    }

    const externalTool: MessageV2.ToolPart = {
      id: partID("part_external"),
      sessionID: sessionID("ses_1"),
      messageID: messageID("msg_1"),
      type: "tool",
      callID: "call_external",
      tool: "read",
      state: {
        status: "completed",
        input: { file: "README.md" },
        output: "Read 20 lines.",
        title: "Read file",
        metadata: {
          internal: false,
        },
        time: {
          start: 0,
          end: 0,
        },
      },
    }

    const messages = MessageV2.toModelMessages(
      [createAssistantWithParts([internalTool, externalTool])],
      createModel(),
    )

    const serialized = JSON.stringify(messages)
    expect(serialized).not.toContain("self_driven")
    expect(serialized).not.toContain("Prepared self-driven context for the next model call.")
    expect(serialized).toContain("read")
    expect(serialized).toContain("Read 20 lines.")
  })

  test("drops older reasoning and synthetic user reminders from optimized model context", () => {
    const oldUser = createUserWithParts("msg_user_old", [
      {
        id: partID("part_user_old_real"),
        sessionID: sessionID("ses_1"),
        messageID: messageID("msg_user_old"),
        type: "text",
        text: "Investigate the sidebar lag.",
      },
      {
        id: partID("part_user_old_synth"),
        sessionID: sessionID("ses_1"),
        messageID: messageID("msg_user_old"),
        type: "text",
        text: "<system-reminder>keep working</system-reminder>",
        synthetic: true,
      },
    ])
    const oldAssistant = createAssistantWithParts([
      {
        id: partID("part_reasoning_old"),
        sessionID: sessionID("ses_1"),
        messageID: messageID("msg_1"),
        type: "reasoning",
        text: "Long internal chain of thought that should not stay in old context.",
        time: {
          start: 0,
          end: 0,
        },
      },
      {
        id: partID("part_text_old"),
        sessionID: sessionID("ses_1"),
        messageID: messageID("msg_1"),
        type: "text",
        text: "I found the hot path in session sync.",
      },
    ])
    const latestUser = createUserWithParts("msg_user_latest", [
      {
        id: partID("part_user_latest"),
        sessionID: sessionID("ses_1"),
        messageID: messageID("msg_user_latest"),
        type: "text",
        text: "Now optimize first-screen rendering.",
      },
    ])

    const prepared = MessageV2.prepareModelContext([oldUser, oldAssistant, latestUser], createModel(), {
      optimizeContext: true,
      protectedTurns: 1,
    })

    const serialized = JSON.stringify(prepared.messages)
    expect(serialized).not.toContain("Long internal chain of thought")
    expect(serialized).not.toContain("<system-reminder>")
    expect(serialized).toContain("Investigate the sidebar lag.")
    expect(serialized).toContain("Now optimize first-screen rendering.")
    expect(prepared.stats.droppedReasoningParts).toBeGreaterThan(0)
    expect(prepared.stats.droppedSyntheticUserParts).toBeGreaterThan(0)
  })

  test("summarizes duplicate and oversized historical tool output in optimized context", () => {
    const firstTool = createAssistantWithParts([
      {
        id: partID("part_tool_a"),
        sessionID: sessionID("ses_1"),
        messageID: messageID("msg_1"),
        type: "tool",
        callID: "call_a",
        tool: "read",
        state: {
          status: "completed",
          input: { file: "README.md" },
          output: "A".repeat(2400),
          title: "Read file",
          metadata: {},
          time: {
            start: 0,
            end: 0,
          },
        },
      },
    ])
    const secondTool = createAssistantWithParts([
      {
        id: partID("part_tool_b"),
        sessionID: sessionID("ses_1"),
        messageID: messageID("msg_1"),
        type: "tool",
        callID: "call_b",
        tool: "read",
        state: {
          status: "completed",
          input: { file: "README.md" },
          output: "A".repeat(2400),
          title: "Read file",
          metadata: {},
          time: {
            start: 0,
            end: 0,
          },
        },
      },
    ])
    const latestUser = createUserWithParts("msg_user_latest_2", [
      {
        id: partID("part_user_latest_2"),
        sessionID: sessionID("ses_1"),
        messageID: messageID("msg_user_latest_2"),
        type: "text",
        text: "Summarize the result.",
      },
    ])

    const prepared = MessageV2.prepareModelContext([firstTool, secondTool, latestUser], createModel(), {
      optimizeContext: true,
      protectedTurns: 1,
      maxToolOutputTokens: 100,
    })

    const serialized = JSON.stringify(prepared.messages)
    expect(serialized).toContain("Context-optimized tool result omitted")
    expect(prepared.stats.summarizedToolResults).toBeGreaterThan(0)
    expect(prepared.stats.estimatedTokensAfter).toBeLessThan(prepared.stats.estimatedTokensBefore)
  })
})