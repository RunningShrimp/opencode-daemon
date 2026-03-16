import { describe, expect, test } from "bun:test"
import { MessageV2 } from "../session/message-v2"

function createModel() {
  return {
    id: "test-model",
    providerID: "openai",
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
      id: "msg_1",
      sessionID: "ses_1",
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
      modelID: "test-model",
      providerID: "openai",
      time: {
        created: 0,
        completed: 0,
      },
      sessionID: "ses_1",
    },
    parts,
  } as MessageV2.WithParts
}

describe("MessageV2.toModelMessages", () => {
  test("excludes internal tool callouts from model-visible history", () => {
    const internalTool: MessageV2.ToolPart = {
      id: "part_internal",
      sessionID: "ses_1",
      messageID: "msg_1",
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
      id: "part_external",
      sessionID: "ses_1",
      messageID: "msg_1",
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
})