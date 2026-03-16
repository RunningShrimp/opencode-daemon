import z from "zod"
import path from "path"
import { Tool } from "./tool"
import { Question } from "../question"
import { Session } from "../session"
import { MessageV2 } from "../session/message-v2"
import { Provider } from "../provider/provider"
import { Instance } from "../project/instance"
import { type SessionID, MessageID, PartID } from "../session/schema"
import EXIT_DESCRIPTION from "./plan-exit.txt"

async function getLastModel(sessionID: SessionID) {
  for await (const item of MessageV2.stream(sessionID)) {
    if (item.info.role === "user" && item.info.model) return item.info.model
  }
  return Provider.defaultModel()
}

export const PlanExitTool = Tool.define("plan_exit", {
  description: EXIT_DESCRIPTION,
  parameters: z.object({
    autoApprove: z.boolean().optional().default(false),
    summary: z.string().optional(),
    satisfiedCriteria: z.array(z.string()).optional().default([]),
    remainingQuestions: z.array(z.string()).optional().default([]),
  }),
  async execute(params, ctx) {
    const session = await Session.get(ctx.sessionID)
    const plan = path.relative(Instance.worktree, Session.plan(session))
    const satisfiedCriteria = params.satisfiedCriteria ?? []
    const remainingQuestions = params.remainingQuestions ?? []
    const autoApprove = params.autoApprove === true

    if (autoApprove) {
      if (remainingQuestions.length > 0 || (satisfiedCriteria.length === 0 && !params.summary?.trim())) {
        throw new Error(
          "The plan_exit tool can only auto-approve when there are no remaining questions and you provide either a summary or at least one satisfied success criterion.",
        )
      }
    } else {
      const answers = await Question.ask({
        sessionID: ctx.sessionID,
        questions: [
          {
            question: `Plan at ${plan} is complete. Would you like to switch to the build agent and start implementing?`,
            header: "Build Agent",
            custom: false,
            options: [
              { label: "Yes", description: "Switch to build agent and start implementing the plan" },
              { label: "No", description: "Stay with plan agent to continue refining the plan" },
            ],
          },
        ],
        tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
      })

      const answer = answers[0]?.[0]
      if (answer === "No") throw new Question.RejectedError()
    }

    const model = await getLastModel(ctx.sessionID)
    const evidenceSummary = [params.summary?.trim(), ...satisfiedCriteria].filter(Boolean).join("\n- ")
    const approvalLine = autoApprove
      ? `The plan at ${plan} is approved for autonomous execution.`
      : `The plan at ${plan} has been approved, you can now edit files.`
    const detailBlock = evidenceSummary ? `\nPlan handoff evidence:\n- ${evidenceSummary}` : ""

    const userMsg: MessageV2.User = {
      id: MessageID.ascending(),
      sessionID: ctx.sessionID,
      role: "user",
      time: {
        created: Date.now(),
      },
      agent: "build",
      model,
    }
    await Session.updateMessage(userMsg)
    await Session.updatePart({
      id: PartID.ascending(),
      messageID: userMsg.id,
      sessionID: ctx.sessionID,
      type: "text",
      text: `${approvalLine}${detailBlock}\nExecute the plan`,
      synthetic: true,
    } satisfies MessageV2.TextPart)

    return {
      title: "Switching to build agent",
      output: autoApprove
        ? "Autonomous approval recorded. Switched to the build agent with the supplied handoff evidence."
        : "User approved switching to build agent. Wait for further instructions.",
      metadata: {
        approvalMode: autoApprove ? "autonomous" : "interactive",
      },
    }
  },
})

/*
export const PlanEnterTool = Tool.define("plan_enter", {
  description: ENTER_DESCRIPTION,
  parameters: z.object({}),
  async execute(_params, ctx) {
    const session = await Session.get(ctx.sessionID)
    const plan = path.relative(Instance.worktree, Session.plan(session))

    const answers = await Question.ask({
      sessionID: ctx.sessionID,
      questions: [
        {
          question: `Would you like to switch to the plan agent and create a plan saved to ${plan}?`,
          header: "Plan Mode",
          custom: false,
          options: [
            { label: "Yes", description: "Switch to plan agent for research and planning" },
            { label: "No", description: "Stay with build agent to continue making changes" },
          ],
        },
      ],
      tool: ctx.callID ? { messageID: ctx.messageID, callID: ctx.callID } : undefined,
    })

    const answer = answers[0]?.[0]

    if (answer === "No") throw new Question.RejectedError()

    const model = await getLastModel(ctx.sessionID)

    const userMsg: MessageV2.User = {
      id: MessageID.ascending(),
      sessionID: ctx.sessionID,
      role: "user",
      time: {
        created: Date.now(),
      },
      agent: "plan",
      model,
    }
    await Session.updateMessage(userMsg)
    await Session.updatePart({
      id: PartID.ascending(),
      messageID: userMsg.id,
      sessionID: ctx.sessionID,
      type: "text",
      text: "User has requested to enter plan mode. Switch to plan mode and begin planning.",
      synthetic: true,
    } satisfies MessageV2.TextPart)

    return {
      title: "Switching to plan agent",
      output: `User confirmed to switch to plan mode. A new message has been created to switch you to plan mode. The plan file will be at ${plan}. Begin planning.`,
      metadata: {},
    }
  },
})
*/
