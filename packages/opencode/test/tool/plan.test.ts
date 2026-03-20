import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider/provider"
import * as QuestionModule from "../../src/question"
import { MessageV2 } from "../../src/session/message-v2"
import { Session } from "../../src/session"
import { messageID, modelID, projectInfo, providerID, sessionID } from "../../src/test-helpers/ids"
import { PlanExitTool } from "../../src/tool/plan"

const ctx = {
  sessionID: sessionID("session_test_plan_exit"),
  messageID: messageID("message_test_plan_exit"),
  callID: "call_test_plan_exit",
  agent: "plan",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => {},
  ask: async () => {},
}

describe("tool.plan_exit", () => {
  let root = ""
  let getSpy: any
  let planSpy: any
  let updateMessageSpy: any
  let updatePartSpy: any
  let questionSpy: any
  let defaultModelSpy: any
  let streamSpy: any

  beforeEach(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-plan-exit-"))
    getSpy = spyOn(Session, "get").mockResolvedValue({
      slug: "demo-session",
      time: { created: 123 },
    } as any)
    planSpy = spyOn(Session, "plan").mockReturnValue(path.join(root, ".opencode", "plans", "demo.md"))
    updateMessageSpy = spyOn(Session, "updateMessage").mockResolvedValue(undefined as never)
    updatePartSpy = spyOn(Session, "updatePart").mockResolvedValue(undefined as never)
    questionSpy = spyOn(QuestionModule.Question, "ask").mockResolvedValue([["Yes"]])
    defaultModelSpy = spyOn(Provider, "defaultModel").mockResolvedValue({
      providerID: providerID("test"),
      modelID: modelID("model"),
    })
    streamSpy = spyOn(MessageV2, "stream").mockImplementation((async function* () {}) as any)
  })

  afterEach(async () => {
    getSpy.mockRestore()
    planSpy.mockRestore()
    updateMessageSpy.mockRestore()
    updatePartSpy.mockRestore()
    questionSpy.mockRestore()
    defaultModelSpy.mockRestore()
    streamSpy.mockRestore()
    await fs.rm(root, { recursive: true, force: true })
  })

  test("supports autonomous plan handoff without interactive approval", async () => {
    const tool = await PlanExitTool.init()

    const result = await Instance.provide({
      directory: root,
      worktree: root,
      project: projectInfo("project_test_plan", root),
      fn: () =>
        tool.execute(
          {
            autoApprove: true,
            summary: "Plan file finalized and ready for execution.",
            satisfiedCriteria: ["Implementation steps are written", "Verification steps are included"],
            remainingQuestions: [],
          },
          ctx,
        ),
    })

    expect(questionSpy).not.toHaveBeenCalled()
    expect(updateMessageSpy).toHaveBeenCalledTimes(1)
    expect(updatePartSpy).toHaveBeenCalledTimes(1)
    expect(updatePartSpy.mock.calls[0][0].text).toContain("approved for autonomous execution")
    expect(result.metadata.approvalMode).toBe("autonomous")
  })

  test("rejects autonomous handoff when questions remain", async () => {
    const tool = await PlanExitTool.init()

    await expect(
      Instance.provide({
        directory: root,
        worktree: root,
        project: projectInfo("project_test_plan", root),
        fn: () =>
          tool.execute(
            {
              autoApprove: true,
              satisfiedCriteria: [],
              remainingQuestions: ["Should migrations be included?"],
            },
            ctx,
          ),
      }),
    ).rejects.toThrow("can only auto-approve")

    expect(questionSpy).not.toHaveBeenCalled()
    expect(updateMessageSpy).not.toHaveBeenCalled()
    expect(updatePartSpy).not.toHaveBeenCalled()
  })
})