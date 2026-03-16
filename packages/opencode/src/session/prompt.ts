import path from "path"
import os from "os"
import fs from "fs/promises"
import z from "zod"
import { Filesystem } from "../util/filesystem"
import { SessionID, MessageID, PartID } from "./schema"
import { MessageV2 } from "./message-v2"
import { Log } from "../util/log"
import { SessionRevert } from "./revert"
import { Session } from "."
import { Agent } from "../agent/agent"
import { Provider } from "../provider/provider"
import { ModelID, ProviderID } from "../provider/schema"
import { type Tool as AITool, tool, jsonSchema, type ToolCallOptions, asSchema } from "ai"
import { SessionCompaction } from "./compaction"
import { Instance } from "../project/instance"
import { Bus } from "../bus"
import { Todo } from "./todo"
import { ProviderTransform } from "../provider/transform"
import { createSelfDrivenAgent, SelfDrivenAgent } from "../ai/thinking/self-driven-agent"
import { IntentDetection, type TaskIntent } from "../ai/thinking/intent"
import { SystemPrompt } from "./system"
import { InstructionPrompt } from "./instruction"
import { Plugin } from "../plugin"
import PROMPT_PLAN from "../session/prompt/plan.txt"
import BUILD_SWITCH from "../session/prompt/build-switch.txt"
import MAX_STEPS from "../session/prompt/max-steps.txt"
import { defer } from "../util/defer"
import { ToolRegistry } from "../tool/registry"
import { MCP } from "../mcp"
import { LSP } from "../lsp"
import { ReadTool } from "../tool/read"
import { FileTime } from "../file/time"
import { Flag } from "../flag/flag"
import { ulid } from "ulid"
import { spawn } from "child_process"
import { Command } from "../command"
import { $ } from "bun"
import { pathToFileURL, fileURLToPath } from "url"
import { ConfigMarkdown } from "../config/markdown"
import { SessionSummary } from "./summary"
import { NamedError } from "@opencode-ai/util/error"
import { fn } from "@/util/fn"
import { SessionProcessor } from "./processor"
import { TaskTool } from "@/tool/task"
import { Tool } from "@/tool/tool"
import { PermissionNext } from "@/permission/next"
import { SessionStatus } from "./status"
import { LLM } from "./llm"
import { iife } from "@/util/iife"
import { Shell } from "@/shell/shell"
import { Truncate } from "@/tool/truncation"
import { getController, removeController, type Complexity } from "@/util/dynamic-turn-control"
import { getMCPRouter } from "@/util/smart-router"
import { removeBudget } from "@/util/instance-memory-budget"
import { decodeDataUrl } from "@/util/data-url"
import { buildAutoGroundingContext, extractAutoGroundingQueryFromParts } from "@/ai/rag/auto-context"
import { EvidenceLedger } from "@/ai/evidence/ledger"
import { writeTodoMarkdown } from "./todo-markdown"
import { verifyWithFVA, buildGroundingConstraints } from "@/ai/rag/contra-retriever"
import { WorkflowOrchestrator } from "@/ai/workflow/orchestrator"
import { ProjectMemory } from "@/ai/memory/project-memory"
import { LearningStore } from "@/ai/memory/learning-store"
import { KnowledgeContext } from "@/ai/knowledge/context"
import type { KnowledgeGraph } from "@/ai/knowledge"
import { Personality } from "@/ai/personality"
import { ToolBroker, type ToolDescriptor } from "@/ai/tool-broker"
import { WorkspaceIntelligence } from "@/ai/workspace-intelligence"
import { embeddingBackgroundService } from "@/ai/rag/embedding-bg-service"

// @ts-ignore
globalThis.AI_SDK_LOG_WARNINGS = false

const STRUCTURED_OUTPUT_DESCRIPTION = `Use this tool to return your final response in the requested structured format.

IMPORTANT:
- You MUST call this tool exactly once at the end of your response
- The input must be valid JSON matching the required schema
- Complete all necessary research and tool calls BEFORE calling this tool
- This tool provides your final answer - no further actions are taken after calling it`

const STRUCTURED_OUTPUT_SYSTEM_PROMPT = `IMPORTANT: The user has requested structured output. You MUST use the StructuredOutput tool to provide your final response. Do NOT respond with plain text - you MUST call the StructuredOutput tool with your answer formatted according to the schema.`

export namespace SessionPrompt {
  const log = Log.create({ service: "session.prompt" })

  function mapIntentToTurnComplexity(intent: TaskIntent): Complexity {
    if (intent.type === "implementation") return intent.complexity
    if (intent.type === "review") return intent.scope === "performance" || intent.scope === "security" ? "complex" : "moderate"
    if (intent.type === "debugging") return "moderate"
    if (intent.type === "exploration") return "simple"
    return "moderate"
  }

  /** @internal Exported for testing */
  export function shouldRunAnswerVerification(input: { intent?: TaskIntent }) {
    return !(input.intent?.type === "exploration" && input.intent.mode === "question")
  }

  /** @internal Exported for testing */
  export function resolveVerificationIntent(input: {
    intent?: TaskIntent
    userInput?: string
    assistantText?: string
  }) {
    if (input.intent) return input.intent
    const candidate = (input.userInput || input.assistantText || "").trim()
    if (!candidate) return undefined
    return IntentDetection.detect(candidate)
  }

  function tokenCount(tokens: MessageV2.Assistant["tokens"]) {
    return tokens.total || tokens.input + tokens.output + tokens.reasoning + tokens.cache.read + tokens.cache.write
  }

  function tokenUsage(tokens: MessageV2.Assistant["tokens"]) {
    return {
      input: tokens.input + tokens.cache.read + tokens.cache.write,
      output: tokens.output + tokens.reasoning,
      total: tokenCount(tokens),
    }
  }

  function inferToolDescriptorSource(id: string): ToolDescriptor["source"] {
    if (["websearch", "webfetch"].includes(id)) return "web"
    if (["rag_query", "rag_index", "read", "grep", "glob", "codesearch"].includes(id)) return "retrieval"
    if (id === "skill") return "skill"
    if (id === "task") return "subagent"
    return "builtin"
  }

  function toolDescriptorsFromResolvedTools(tools: Record<string, AITool>): ToolDescriptor[] {
    return Object.entries(tools).map(([id, item]) => ({
      id,
      description: item.description ?? "",
      source: inferToolDescriptorSource(id),
    }))
  }

  /** @internal Exported for testing */
  export function getLoopBoundary(input: {
    turnControlReady: boolean
    lastFinished?: Pick<MessageV2.Assistant, "tokens">
    turnController: { shouldContinue(current: number): { shouldContinue: boolean; reason: string } }
    step: number
    maxSteps: number
  }) {
    const turnDecision =
      input.turnControlReady && input.lastFinished?.tokens
        ? input.turnController.shouldContinue(tokenCount(input.lastFinished.tokens))
        : undefined
    const shouldWrapUp = !!turnDecision && !turnDecision.shouldContinue
    return {
      turnDecision,
      shouldWrapUp,
      isLastStep: input.step >= input.maxSteps || shouldWrapUp,
    }
  }

  /** @internal Exported for testing */
  export function getVerificationRevisionKey(input: {
    turnUserID?: string
    lastUserID: string
  }) {
    return input.turnUserID ?? input.lastUserID
  }

  export interface CapabilitySystemPromptInput {
    sessionID: string
    projectID: string
    rootDir: string
    userInput: string
    intent?: TaskIntent
    turnControlComplexity: Complexity
    agent: Agent.Info
    toolDescriptors: ToolDescriptor[]
    autoGroundingSystemPrompt?: string
    knowledgeGraph?: KnowledgeGraph
  }

  export async function buildCapabilitySystemPrompts(input: CapabilitySystemPromptInput) {
    const personalityPrompt = Personality.renderSystemPrompt(
      Personality.resolveProfile({
        agent: input.agent,
        intent: input.intent,
        userPrompt: input.userInput,
      }),
    )

    const prompts: string[] = []
    const callouts: RuntimeCapabilityCallout[] = []
    const workflowState = await WorkflowOrchestrator.get(input.sessionID)
    if (workflowState) {
      prompts.push(WorkflowOrchestrator.renderSystemContext(workflowState))
    }
    const projectMemoryPrompt = await ProjectMemory.renderPromptContext(input.projectID, input.userInput)
    if (projectMemoryPrompt) {
      prompts.push(projectMemoryPrompt)
      callouts.push({
        tool: "project_memory",
        title: "Project memory context injected",
        description:
          "Loads durable project memory about constraints, prior failures, and learned facts so the model starts from repository-specific context.",
        output: "Injected project memory context for this turn.",
        input: {
          source: "project_memory",
        },
        metadata: {
          capability: "project_memory",
        },
      })
    }
    const workspacePrompt = await WorkspaceIntelligence.renderPromptContext({
      sessionID: input.sessionID,
      projectID: input.projectID,
      rootDir: input.rootDir,
    })
    if (workspacePrompt) {
      prompts.push(workspacePrompt)
      callouts.push({
        tool: "workspace_context",
        title: "Workspace intelligence context injected",
        description:
          "Adds nearby workspace and recent-session context so the model can reason across related worktrees, branches, and active project areas.",
        output: "Injected workspace intelligence context for this turn.",
        input: {
          root: clipCapabilityValue(input.rootDir, 48),
        },
        metadata: {
          capability: "workspace_intelligence",
        },
      })
    }
    const knowledgeGraphPrompt = await KnowledgeContext.renderPromptContext(input.userInput, {
      rootDir: input.rootDir,
      graph: input.knowledgeGraph,
    })
    if (knowledgeGraphPrompt) {
      prompts.push(knowledgeGraphPrompt)
      callouts.push({
        tool: "knowledge_graph",
        title: "Knowledge graph context injected",
        description:
          "Injects ranked knowledge-graph paths and related project facts so answers can reference structural repository context instead of only raw files.",
        output: "Injected knowledge graph context for this turn.",
        input: {
          query: clipCapabilityValue(input.userInput, 48),
        },
        metadata: {
          capability: "knowledge_graph_context",
        },
      })
    }
    const learnedStrategiesPrompt = await LearningStore.renderPromptContext({
      projectID: input.projectID,
      rootDir: input.rootDir,
      taskType: input.intent?.type ?? "general",
      complexity: input.intent?.type === "implementation" ? input.intent.complexity : input.turnControlComplexity,
    })
    if (learnedStrategiesPrompt) {
      prompts.push(learnedStrategiesPrompt)
    }
    const brokerContext = ToolBroker.renderPromptContext(
      ToolBroker.decide({
        intent: input.intent ?? IntentDetection.detect(input.userInput),
        agent: input.agent,
        tools: await ToolBroker.enrichDescriptors({
          projectID: input.projectID,
          tools: input.toolDescriptors,
        }),
        currentTask: input.userInput,
      }),
    )
    if (brokerContext) {
      prompts.push(brokerContext)
      callouts.push({
        tool: "tool_broker",
        title: "Tool broker guidance injected",
        description:
          "Ranks and explains the best tool sources for the current task so the model gets explicit routing guidance before choosing tools.",
        output: "Injected tool broker routing guidance for this turn.",
        input: {
          tool_candidates: input.toolDescriptors.length,
        },
        metadata: {
          capability: "tool_broker",
        },
      })
    }
    const evidencePrompt = await EvidenceLedger.renderPromptContext(input.sessionID, input.projectID)
    if (evidencePrompt) {
      prompts.push(evidencePrompt)
    }
    if (input.intent?.type === "exploration" && input.intent.mode === "question") {
      prompts.push(
        [
          "<response_style>",
          "This turn is a direct question, not a multi-step implementation workflow.",
          "Answer directly and keep the default response concise.",
          "Do not produce plans, todo lists, or extended explanations unless the user asks for more depth or the evidence is genuinely conflicting.",
          "</response_style>",
        ].join("\n"),
      )
    }
    if (input.autoGroundingSystemPrompt) {
      prompts.push(input.autoGroundingSystemPrompt)
    }

    const embeddingContext = embeddingBackgroundService.getRuntimeContext()
    prompts.push(
      [
        "<embedding_runtime>",
        "Embedding runtime status for retrieval, memory, and evidence quality.",
        `Service status: ${embeddingContext.serviceStatus}`,
        `Target provider: ${embeddingContext.targetProvider} (source=${embeddingContext.source})`,
        `Active provider: ${embeddingContext.activeProvider} (kind=${embeddingContext.activeProviderKind}, mode=${embeddingContext.mode})`,
        embeddingContext.lastError ? `Last provider error: ${embeddingContext.lastError}` : "",
        "</embedding_runtime>",
      ]
        .filter(Boolean)
        .join("\n"),
    )

    return {
      personalityPrompt,
      prompts,
      callouts,
    }
  }

  const selfDrivenAgents = new Map<string, SelfDrivenAgent>()

  function getSelfDrivenAgent(sessionID: string) {
    if (!selfDrivenAgents.has(sessionID)) {
      selfDrivenAgents.set(sessionID, createSelfDrivenAgent())
    }
    return selfDrivenAgents.get(sessionID)!
  }

  type RuntimeCapabilityCallout = {
    tool: string
    title: string
    description: string
    output: string
    input?: Record<string, string | number | boolean>
    metadata?: Record<string, unknown>
  }

  function clipCapabilityValue(value: string, max = 80) {
    const normalized = value.replace(/\s+/g, " ").trim()
    if (normalized.length <= max) return normalized
    return normalized.slice(0, max - 1).trimEnd() + "…"
  }

  function summarizeIntent(intent: TaskIntent): Record<string, string | number | boolean> {
    switch (intent.type) {
      case "review":
        return {
          type: intent.type,
          scope: intent.scope,
          target: clipCapabilityValue(intent.target),
        }
      case "implementation":
        return {
          type: intent.type,
          complexity: intent.complexity,
        }
      case "debugging":
        return {
          type: intent.type,
          error: clipCapabilityValue(intent.error),
        }
      case "exploration":
        return {
          type: intent.type,
          query: clipCapabilityValue(intent.query),
          mode: intent.mode,
        }
      default:
        return {
          type: "unknown",
        }
    }
  }

  function formatCapabilityProgress(value: unknown) {
    if (typeof value !== "number" || !Number.isFinite(value)) return "unknown"
    return `${Math.round(value * 100)}%`
  }

  function textFromParts(parts: MessageV2.Part[]) {
    return parts
      .filter((part): part is MessageV2.TextPart => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim()
  }

  function isSyntheticPart(part: MessageV2.Part) {
    return "synthetic" in part && !!part.synthetic
  }

  /** @internal Exported for testing */
  export function resolveTurnUserContext(input: {
    history: Array<Pick<MessageV2.WithParts, "info" | "parts">>
  }) {
    for (let i = input.history.length - 1; i >= 0; i--) {
      const message = input.history[i]
      if (message.info.role !== "user") continue

      const nonSyntheticParts = message.parts.filter((part) => !isSyntheticPart(part))
      if (nonSyntheticParts.length === 0) continue

      return {
        userID: message.info.id,
        parts: nonSyntheticParts,
        userInput: textFromParts(nonSyntheticParts),
      }
    }
    return undefined
  }

  async function emitCapabilityCallout(input: {
    sessionID: string
    messageID: string
    callout: RuntimeCapabilityCallout
  }) {
    const started = Date.now()
    await Session.updatePart({
      id: PartID.ascending(),
      messageID: input.messageID,
      sessionID: input.sessionID,
      type: "tool",
      callID: ulid(),
      tool: input.callout.tool,
      state: {
        status: "completed",
        input: input.callout.input ?? {},
        output: input.callout.output,
        title: input.callout.title,
        metadata: {
          description: input.callout.description,
          internal: true,
          ...(input.callout.metadata ?? {}),
        },
        time: {
          start: started,
          end: started,
        },
      },
    } satisfies MessageV2.ToolPart)
  }

  async function createInternalAssistantMessage(input: {
    sessionID: string
    parentID: string
    agent: string
    variant?: string
    model: {
      providerID: string
      modelID: string
    }
  }) {
    return (await Session.updateMessage({
      id: MessageID.ascending(),
      parentID: input.parentID,
      role: "assistant",
      mode: input.agent,
      agent: input.agent,
      variant: input.variant,
      path: {
        cwd: Instance.directory,
        root: Instance.worktree,
      },
      cost: 0,
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      modelID: input.model.modelID,
      providerID: input.model.providerID,
      time: {
        created: Date.now(),
        completed: Date.now(),
      },
      sessionID: input.sessionID,
    })) as MessageV2.Assistant
  }

  let stateCache: any = null

  const getState = () => {
    if (!stateCache) {
      stateCache = Instance.state(
        () => {
          const data: Record<
            string,
            {
              abort: AbortController
              callbacks: {
                resolve(input: MessageV2.WithParts): void
                reject(reason?: any): void
              }[]
            }
          > = {}
          return data
        },
        async (current) => {
          for (const item of Object.values(current)) {
            item.abort.abort()
          }
        },
      )()
    }
    return stateCache!
  }

  // Alias for backward compatibility
  const state = getState

  export function assertNotBusy(sessionID: SessionID) {
    const match = state()[sessionID]
    if (match) throw new Session.BusyError(sessionID)
  }

  export const PromptInput = z.object({
    sessionID: SessionID.zod,
    messageID: MessageID.zod.optional(),
    model: z
      .object({
        providerID: ProviderID.zod,
        modelID: ModelID.zod,
      })
      .optional(),
    agent: z.string().optional(),
    noReply: z.boolean().optional(),
    tools: z
      .record(z.string(), z.boolean())
      .optional()
      .describe(
        "@deprecated tools and permissions have been merged, you can set permissions on the session itself now",
      ),
    format: MessageV2.Format.optional(),
    system: z.string().optional(),
    variant: z.string().optional(),
    parts: z.array(
      z.discriminatedUnion("type", [
        MessageV2.TextPart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "TextPartInput",
          }),
        MessageV2.FilePart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "FilePartInput",
          }),
        MessageV2.AgentPart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "AgentPartInput",
          }),
        MessageV2.SubtaskPart.omit({
          messageID: true,
          sessionID: true,
        })
          .partial({
            id: true,
          })
          .meta({
            ref: "SubtaskPartInput",
          }),
      ]),
    ),
  })
  export type PromptInput = z.infer<typeof PromptInput>

  export const prompt = fn(PromptInput, async (input) => {
    const session = await Session.get(input.sessionID)
    await SessionRevert.cleanup(session)

    const message = await createUserMessage(input)
    await Session.touch(input.sessionID)

    // this is backwards compatibility for allowing `tools` to be specified when
    // prompting
    const permissions: PermissionNext.Ruleset = []
    for (const [tool, enabled] of Object.entries(input.tools ?? {})) {
      permissions.push({
        permission: tool,
        action: enabled ? "allow" : "deny",
        pattern: "*",
      })
    }
    if (permissions.length > 0) {
      session.permission = permissions
      await Session.setPermission({ sessionID: session.id, permission: permissions })
    }

    if (input.noReply === true) {
      return message
    }

    return loop({ sessionID: input.sessionID })
  })

  export async function resolvePromptParts(template: string): Promise<PromptInput["parts"]> {
    const parts: PromptInput["parts"] = [
      {
        type: "text",
        text: template,
      },
    ]
    const files = ConfigMarkdown.files(template)
    const seen = new Set<string>()
    await Promise.all(
      files.map(async (match) => {
        const name = match[1]
        if (seen.has(name)) return
        seen.add(name)
        const filepath = name.startsWith("~/")
          ? path.join(os.homedir(), name.slice(2))
          : path.resolve(Instance.worktree, name)

        const stats = await fs.stat(filepath).catch(() => undefined)
        if (!stats) {
          const agent = await Agent.get(name)
          if (agent) {
            parts.push({
              type: "agent",
              name: agent.name,
            })
          }
          return
        }

        if (stats.isDirectory()) {
          parts.push({
            type: "file",
            url: pathToFileURL(filepath).href,
            filename: name,
            mime: "application/x-directory",
          })
          return
        }

        parts.push({
          type: "file",
          url: pathToFileURL(filepath).href,
          filename: name,
          mime: "text/plain",
        })
      }),
    )
    return parts
  }

  function start(sessionID: SessionID) {
    const s = state()
    if (s[sessionID]) return
    const controller = new AbortController()
    s[sessionID] = {
      abort: controller,
      callbacks: [],
    }
    return controller.signal
  }

  function resume(sessionID: SessionID) {
    const s = state()
    if (!s[sessionID]) return

    return s[sessionID].abort.signal
  }

  export function cancel(sessionID: SessionID) {
    log.info("cancel", { sessionID })
    const s = state()
    const match = s[sessionID]
    if (!match) {
      SessionStatus.set(sessionID, { type: "idle" })
      return
    }
    match.abort.abort()
    delete s[sessionID]
    SessionStatus.set(sessionID, { type: "idle" })
    return
  }

  export const LoopInput = z.object({
    sessionID: SessionID.zod,
    resume_existing: z.boolean().optional(),
  })
  export const loop = fn(LoopInput, async (input) => {
    const { sessionID, resume_existing } = input

    const abort = resume_existing ? resume(sessionID) : start(sessionID)
    if (!abort) {
      return new Promise<MessageV2.WithParts>((resolve, reject) => {
        const callbacks = getState()[sessionID].callbacks
        callbacks.push({ resolve, reject })
      })
    }

    using _ = defer(() => {
      cancel(sessionID)
      removeController(sessionID)
      removeBudget(sessionID)
      // Always sync todo list on exit — covers exceptions, aborts, and clean exits
      void Todo.get(sessionID)
        .then((todos) => todos.length > 0 ? writeTodoMarkdown(sessionID, todos) : undefined)
        .catch(() => undefined)
    })

    // Structured output state
    // Note: On session resumption, state is reset but outputFormat is preserved
    // on the user message and will be retrieved from lastUser below
    let structuredOutput: unknown | undefined

    const sdAgent = getSelfDrivenAgent(sessionID)
    const turnController = getController(sessionID)
    let turnControlComplexity: Complexity = "moderate"
    let turnControlReady = false
    let turnControlReminderSent = false
    let autoGroundingUserID: string | undefined
    let autoGroundingSystemPrompt: string | undefined
    let turnIntent: TaskIntent | undefined
    let turnUserInput = ""
    let turnUserID: string | undefined
    const verificationRevisionCount = new Map<string, number>()

    let step = 0
    const session = await Session.get(sessionID)
    while (true) {
      SessionStatus.set(sessionID, { type: "busy" })
      log.info("loop", { step, sessionID })
      if (abort.aborted) break
      let msgs = await MessageV2.filterCompacted(MessageV2.stream(sessionID))
      const capabilityCallouts: RuntimeCapabilityCallout[] = []

      let lastUser: MessageV2.User | undefined
      let lastUserParts: MessageV2.Part[] = []
      let lastAssistant: MessageV2.Assistant | undefined
      let lastFinished: MessageV2.Assistant | undefined
      let tasks: (MessageV2.CompactionPart | MessageV2.SubtaskPart)[] = []
      for (let i = msgs.length - 1; i >= 0; i--) {
        const msg = msgs[i]
        if (!lastUser && msg.info.role === "user") {
          lastUser = msg.info as MessageV2.User
          lastUserParts = msg.parts
        }
        if (!lastAssistant && msg.info.role === "assistant") lastAssistant = msg.info as MessageV2.Assistant
        if (!lastFinished && msg.info.role === "assistant" && msg.info.finish)
          lastFinished = msg.info as MessageV2.Assistant
        if (lastUser && lastFinished) break
        const task = msg.parts.filter((part) => part.type === "compaction" || part.type === "subtask")
        if (task && !lastFinished) {
          tasks.push(...task)
        }
      }

      if (!lastUser) throw new Error("No user message found in stream. This should never happen.")

      const turnUserContext = resolveTurnUserContext({ history: msgs })
      if (!turnUserContext) throw new Error("No non-synthetic user message found in stream. This should never happen.")

      if (turnUserContext.userID !== autoGroundingUserID) {
        autoGroundingUserID = turnUserContext.userID
        autoGroundingSystemPrompt = undefined
        const query = extractAutoGroundingQueryFromParts(turnUserContext.parts)
        const grounding = query
          ? await buildAutoGroundingContext({
              query,
              projectId: session.projectID,
              rootDir: Instance.project.worktree,
              fallbackDir: Instance.directory,
            })
          : undefined

        if (grounding) {
          void EvidenceLedger.recordGrounding({
            sessionID,
            projectID: session.projectID,
            bundle: grounding.grounding,
            source: "retrieval",
            metadata: {
              autoIndexed: grounding.autoIndexed,
              channel: "auto_grounding",
            },
          }).catch(() => undefined)
          void WorkflowOrchestrator.noteEvidence(
            sessionID,
            grounding.evidence.map((item) => item.attribution),
          ).catch(() => undefined)
          autoGroundingSystemPrompt = grounding.system
          capabilityCallouts.push({
            tool: "rag_query",
            title: grounding.autoIndexed ? "Project context retrieved after auto-index" : "Project context retrieved",
            description:
              "Automatically retrieves relevant project code context for the current turn and injects it into the model call as grounding evidence.",
            output: `Retrieved ${grounding.evidence.length} grounded code references for this turn.`,
            input: {
              query: clipCapabilityValue(grounding.query, 60),
              references: grounding.evidence.length,
              auto_indexed: grounding.autoIndexed,
            },
            metadata: {
              capability: "rag_auto_grounding",
              evidence: grounding.evidence.map((item) => item.attribution),
            },
          })
        }

        // Pre-generation contra-retrieval: inject known contradictions to the query as constraints
        if (query) {
          const constraints = await buildGroundingConstraints(query, session.projectID).catch(() => undefined)
          if (constraints) {
            autoGroundingSystemPrompt = autoGroundingSystemPrompt ? `${autoGroundingSystemPrompt}\n${constraints}` : constraints
          }
        }
      }
      
      // Initialize Self-Driven Agent if this is a new turn
      if (lastUser && step === 0) {
        turnUserID = turnUserContext.userID
        turnUserInput = turnUserContext.userInput
        const detectedIntent = IntentDetection.detect(turnUserInput)
        turnIntent = detectedIntent
        turnControlComplexity = mapIntentToTurnComplexity(detectedIntent)
        const learningComplexity = detectedIntent.type === "implementation" ? detectedIntent.complexity : turnControlComplexity
        capabilityCallouts.push({
          tool: "intent",
          title: "Intent detected",
          description:
            "Classifies the current user turn so the session loop can choose review, implementation, debugging, or exploration behavior.",
          output: `Detected ${detectedIntent.type} intent for this turn.`,
          input: summarizeIntent(detectedIntent),
          metadata: {
            capability: "intent_detection",
          },
        })

        const workflowState = await WorkflowOrchestrator.initialize({
          sessionID,
          prompt: turnUserInput,
          intent: detectedIntent,
        })
        await ProjectMemory.rememberPromptConstraints(session.projectID, turnUserInput)
        await LearningStore.startTask(
          {
            projectID: session.projectID,
            rootDir: Instance.project.worktree,
            taskType: detectedIntent.type,
            complexity: learningComplexity,
          },
          [detectedIntent.type],
        )
        capabilityCallouts.push({
          tool: "workflow",
          title: "Structured workflow initialized",
          description:
            "Builds a structured plan and workflow state for the current turn so the loop can reason, execute, and verify against the same task model.",
          output: `Initialized ${workflowState.plan.plan.steps.flatMap((step) => step.tasks).length} planned tasks for this turn.`,
          input: {
            phase: workflowState.currentPhase,
            intent: detectedIntent.type,
          },
          metadata: {
            capability: "workflow_orchestrator",
          },
        })
        
      }

      // Defer sdAgent.initialize() to after model is resolved so we can pass Provider.Model

      const shouldExit =
        lastAssistant?.finish &&
        !["tool-calls", "unknown"].includes(lastAssistant.finish) &&
        lastUser.id < lastAssistant.id

      if (shouldExit) {
        // Check for pending todos
        const todos = await Todo.get(sessionID)
        const hasPending = todos.some((t) => t.status === "pending" || t.status === "in_progress")

        if (hasPending) {
          log.info("pending todos found, continuing loop", { sessionID })

          // Create synthetic user message to nudge the agent
          const nextTodo = todos.find((t) => t.status === "in_progress") || todos.find((t) => t.status === "pending")
          const reminder = nextTodo
            ? `You have pending items in your todo list. The next task is: "${nextTodo.content}". Please proceed.`
            : "You have pending items in your todo list. Please proceed to the next task."

          const capabilityMessage = await createInternalAssistantMessage({
            sessionID,
            parentID: lastUser.id,
            agent: lastUser.agent,
            variant: lastUser.variant,
            model: lastUser.model,
          })
          await emitCapabilityCallout({
            sessionID,
            messageID: capabilityMessage.id,
            callout: {
              tool: "todo_continuation",
              title: "Continuation triggered by pending todos",
              description:
                "Keeps the session loop running when tracked todo items are still pending or in progress, instead of exiting early.",
              output: nextTodo
                ? `Pending todo detected: ${clipCapabilityValue(nextTodo.content)}`
                : "Pending todo items detected.",
              input: {
                pending: todos.filter((t) => t.status === "pending").length,
                in_progress: todos.filter((t) => t.status === "in_progress").length,
                next: nextTodo ? clipCapabilityValue(nextTodo.content, 48) : false,
              },
              metadata: {
                capability: "todo_continuation",
              },
            },
          })

          const summaryUserMsg = (await Session.updateMessage({
            id: MessageID.ascending(),
            sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: lastUser.agent,
            model: lastUser.model,
          })) as MessageV2.User

          await Session.updatePart({
            id: PartID.ascending(),
            messageID: summaryUserMsg.id,
            sessionID,
            type: "text",
            text: `<system-reminder>${reminder}</system-reminder>`,
            synthetic: true,
          })

          continue
        }

        // Check for Self-Driven Agent remaining work
        const remainingWork = sdAgent.detectRemainingWork()
        if (remainingWork.hasRemaining && remainingWork.progress < 1.0) {
           log.info("self-driven agent has remaining work", { sessionID, remaining: remainingWork.items })
           
           const nextAction = remainingWork.suggestedActions[0] || "Continue with the next step."
           const reminder = `Self-Correction: You still have incomplete goals. \nRemaining items: ${remainingWork.items.join(", ")}. \nSuggested action: ${nextAction}`

           const capabilityMessage = await createInternalAssistantMessage({
            sessionID,
            parentID: lastUser.id,
            agent: lastUser.agent,
            variant: lastUser.variant,
            model: lastUser.model,
          })
          await emitCapabilityCallout({
            sessionID,
            messageID: capabilityMessage.id,
            callout: {
              tool: "self_correction",
              title: "Self-correction resumed work",
              description:
                "Uses the self-driven agent's remaining-work check to resume the loop when goals are still incomplete.",
              output: `Remaining work detected at ${formatCapabilityProgress(remainingWork.progress)} progress.`,
              input: {
                remaining: remainingWork.items.length,
                progress: formatCapabilityProgress(remainingWork.progress),
                next_action: clipCapabilityValue(nextAction, 48),
              },
              metadata: {
                capability: "self_correction",
                remainingItems: remainingWork.items,
              },
            },
          })

           const summaryUserMsg = (await Session.updateMessage({
            id: MessageID.ascending(),
            sessionID,
            role: "user",
            time: { created: Date.now() },
            agent: lastUser.agent,
            model: lastUser.model,
          })) as MessageV2.User

          await Session.updatePart({
            id: PartID.ascending(),
            messageID: summaryUserMsg.id,
            sessionID,
            type: "text",
            text: `<system-reminder>${reminder}</system-reminder>`,
            synthetic: true,
          })

          continue
        }

        log.info("exiting loop", { sessionID })
        void WorkflowOrchestrator.complete(sessionID).catch(() => undefined)
        break
      }

      step++
      if (step === 1)
        ensureTitle({
          session,
          modelID: lastUser.model.modelID,
          providerID: lastUser.model.providerID,
          history: msgs,
        })

      const model = await Provider.getModel(lastUser.model.providerID, lastUser.model.modelID).catch((e) => {
        if (Provider.ModelNotFoundError.isInstance(e)) {
          const hint = e.data.suggestions?.length ? ` Did you mean: ${e.data.suggestions.join(", ")}?` : ""
          Bus.publish(Session.Event.Error, {
            sessionID,
            error: new NamedError.Unknown({
              message: `Model not found: ${e.data.providerID}/${e.data.modelID}.${hint}`,
            }).toObject(),
          })
        }
        throw e
      })
      if (!turnControlReady) {
        await turnController.initialize(turnControlComplexity, model.limit.input || model.limit.context || 0)
        turnControlReady = true
      }
      if (step === 1) {
        await sdAgent.initialize({
          userInput: turnUserInput,
          intent: turnIntent!,
          history: msgs.map((m) => ({
            role: m.info.role === "assistant" ? "assistant" : m.info.role === "user" ? "user" : "tool",
            content: m.parts.filter((p) => p.type === "text").map((p) => (p as MessageV2.TextPart).text).join("\n"),
          })),
          model,
          sessionID,
        })
      }
      const task = tasks.pop()

      // pending subtask
      // TODO: centralize "invoke tool" logic
      if (task?.type === "subtask") {
        const taskTool = await TaskTool.init()
        const taskModel = task.model ? await Provider.getModel(task.model.providerID, task.model.modelID) : model
        const assistantMessage = (await Session.updateMessage({
          id: MessageID.ascending(),
          role: "assistant",
          parentID: lastUser.id,
          sessionID,
          mode: task.agent,
          agent: task.agent,
          variant: lastUser.variant,
          path: {
            cwd: Instance.directory,
            root: Instance.worktree,
          },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          modelID: taskModel.id,
          providerID: taskModel.providerID,
          time: {
            created: Date.now(),
          },
        })) as MessageV2.Assistant
        let part = (await Session.updatePart({
          id: PartID.ascending(),
          messageID: assistantMessage.id,
          sessionID: assistantMessage.sessionID,
          type: "tool",
          callID: ulid(),
          tool: TaskTool.id,
          state: {
            status: "running",
            input: {
              prompt: task.prompt,
              description: task.description,
              subagent_type: task.agent,
              command: task.command,
            },
            time: {
              start: Date.now(),
            },
          },
        })) as MessageV2.ToolPart
        const taskArgs = {
          prompt: task.prompt,
          description: task.description,
          subagent_type: task.agent,
          command: task.command,
        }
        await Plugin.trigger(
          "tool.execute.before",
          {
            tool: "task",
            sessionID,
            callID: part.id,
          },
          { args: taskArgs },
        )
        let executionError: Error | undefined
        const taskAgent = await Agent.get(task.agent)
        const taskCtx: Tool.Context = {
          agent: task.agent,
          messageID: assistantMessage.id,
          sessionID: sessionID,
          abort,
          callID: part.callID,
          extra: { bypassAgentCheck: true },
          messages: msgs,
          async metadata(input) {
            part = (await Session.updatePart({
              ...part,
              type: "tool",
              state: {
                ...part.state,
                ...input,
              },
            } satisfies MessageV2.ToolPart)) as MessageV2.ToolPart
          },
          async ask(req) {
            await PermissionNext.ask({
              ...req,
              sessionID: sessionID,
              ruleset: PermissionNext.merge(taskAgent.permission, session.permission ?? []),
            })
          },
        }
        const result = await taskTool.execute(taskArgs, taskCtx).catch((error) => {
          executionError = error
          log.error("subtask execution failed", { error, agent: task.agent, description: task.description })
          return undefined
        })
        const attachments = result?.attachments?.map((attachment) => ({
          ...attachment,
          id: PartID.ascending(),
          sessionID,
          messageID: assistantMessage.id,
        }))
        await Plugin.trigger(
          "tool.execute.after",
          {
            tool: "task",
            sessionID,
            callID: part.id,
            args: taskArgs,
          },
          result,
        )
        assistantMessage.finish = "tool-calls"
        assistantMessage.time.completed = Date.now()
        await Session.updateMessage(assistantMessage)
        if (result && part.state.status === "running") {
          await Session.updatePart({
            ...part,
            state: {
              status: "completed",
              input: part.state.input,
              title: result.title,
              metadata: result.metadata,
              output: result.output,
              attachments,
              time: {
                ...part.state.time,
                end: Date.now(),
              },
            },
          } satisfies MessageV2.ToolPart)
        }
        if (!result) {
          await Session.updatePart({
            ...part,
            state: {
              status: "error",
              error: executionError ? `Tool execution failed: ${executionError.message}` : "Tool execution failed",
              time: {
                start: part.state.status === "running" ? part.state.time.start : Date.now(),
                end: Date.now(),
              },
              metadata: "metadata" in part.state ? part.state.metadata : undefined,
              input: part.state.input,
            },
          } satisfies MessageV2.ToolPart)
        }

        if (task.command) {
          // Add synthetic user message to prevent certain reasoning models from erroring
          // If we create assistant messages w/ out user ones following mid loop thinking signatures
          // will be missing and it can cause errors for models like gemini for example
          const summaryUserMsg: MessageV2.User = {
            id: MessageID.ascending(),
            sessionID,
            role: "user",
            time: {
              created: Date.now(),
            },
            agent: lastUser.agent,
            model: lastUser.model,
          }
          await Session.updateMessage(summaryUserMsg)
          await Session.updatePart({
            id: PartID.ascending(),
            messageID: summaryUserMsg.id,
            sessionID,
            type: "text",
            text: "Summarize the task tool output above and continue with your task.",
            synthetic: true,
          } satisfies MessageV2.TextPart)
        }

        continue
      }

      // pending compaction
      if (task?.type === "compaction") {
        const result = await SessionCompaction.process({
          messages: msgs,
          parentID: lastUser.id,
          abort,
          sessionID,
          auto: task.auto,
          overflow: task.overflow,
        })
        if (result === "stop") break
        continue
      }

      // context overflow, needs compaction
      if (
        lastFinished &&
        lastFinished.summary !== true &&
        (await SessionCompaction.isOverflow({ sessionID, tokens: lastFinished.tokens, model }))
      ) {
        await SessionCompaction.create({
          sessionID,
          agent: lastUser.agent,
          model: lastUser.model,
          auto: true,
        })
        continue
      }

      // normal processing
      const agent = await Agent.get(lastUser.agent)
      const maxSteps = agent.steps ?? Infinity
      const { turnDecision, isLastStep } = getLoopBoundary({
        turnControlReady,
        lastFinished,
        turnController,
        step,
        maxSteps,
      })
      msgs = await insertReminders({
        messages: msgs,
        agent,
        session,
      })

      const processor = SessionProcessor.create({
        assistantMessage: (await Session.updateMessage({
          id: MessageID.ascending(),
          parentID: lastUser.id,
          role: "assistant",
          mode: agent.name,
          agent: agent.name,
          variant: lastUser.variant,
          path: {
            cwd: Instance.directory,
            root: Instance.worktree,
          },
          cost: 0,
          tokens: {
            input: 0,
            output: 0,
            reasoning: 0,
            cache: { read: 0, write: 0 },
          },
          modelID: model.id,
          providerID: model.providerID,
          time: {
            created: Date.now(),
          },
          sessionID,
        })) as MessageV2.Assistant,
        sessionID: sessionID,
        model,
        abort,
      })
      using _ = defer(() => InstructionPrompt.clear(processor.message.id))

      for (const callout of capabilityCallouts) {
        await emitCapabilityCallout({
          sessionID,
          messageID: processor.message.id,
          callout,
        })
      }

      if (turnDecision && !turnDecision.shouldContinue) {
        await emitCapabilityCallout({
          sessionID,
          messageID: processor.message.id,
          callout: {
            tool: "turn_control",
            title: "Turn controller requested wrap-up",
            description:
              "Applies the loop boundary heuristic to decide when the agent should wrap up instead of starting more tool work.",
            output: `Wrap-up recommended: ${turnDecision.reason}`,
            input: {
              decision: "wrap_up",
              reason: clipCapabilityValue(turnDecision.reason),
            },
            metadata: {
              capability: "dynamic_turn_control",
            },
          },
        })
      }

      // Check if user explicitly invoked an agent via @ in this turn
      const lastUserMsg = msgs.findLast((m) => m.info.role === "user")
      const bypassAgentCheck = lastUserMsg?.parts.some((p) => p.type === "agent") ?? false

      const tools = await resolveTools({
        agent,
        session,
        model,
        tools: lastUser.tools,
        processor,
        bypassAgentCheck,
        messages: msgs,
        sdAgent,
        intent: turnIntent,
      })
      const format = lastUser.format ?? { type: "text" }

      // Inject StructuredOutput tool if JSON schema mode enabled
      if (format.type === "json_schema") {
        tools["StructuredOutput"] = createStructuredOutputTool({
          schema: format.schema,
          onSuccess(output) {
            structuredOutput = output
          },
        })
      }

      if (step === 1) {
        SessionSummary.summarize({
          sessionID: sessionID,
          messageID: lastUser.id,
        })
      }

      // Ephemerally wrap queued user messages with a reminder to stay on track
      if (step > 1 && lastFinished) {
        for (const msg of msgs) {
          if (msg.info.role !== "user" || msg.info.id <= lastFinished.id) continue
          for (const part of msg.parts) {
            if (part.type !== "text" || part.ignored || part.synthetic) continue
            if (!part.text.trim()) continue
            part.text = [
              "<system-reminder>",
              "The user sent the following message:",
              part.text,
              "",
              "Please address this message and continue with your tasks.",
              "</system-reminder>",
            ].join("\n")
          }
        }
      }

      await Plugin.trigger("experimental.chat.messages.transform", {}, { messages: msgs })

      // Build system prompt, adding structured output instruction if needed
      const skills = await SystemPrompt.skills(agent)
      const system = [
        ...(await SystemPrompt.environment(model)),
        ...(skills ? [skills] : []),
        ...(await InstructionPrompt.system()),
      ]
      const capabilitySystemPrompts = await buildCapabilitySystemPrompts({
        sessionID,
        projectID: session.projectID,
        rootDir: Instance.project.worktree,
        userInput: turnUserInput,
        intent: turnIntent,
        turnControlComplexity,
        agent,
        toolDescriptors: toolDescriptorsFromResolvedTools(tools),
        autoGroundingSystemPrompt,
      })
      system.push(capabilitySystemPrompts.personalityPrompt)
      for (const callout of capabilitySystemPrompts.callouts) {
        await emitCapabilityCallout({
          sessionID,
          messageID: processor.message.id,
          callout,
        })
      }
      if (turnDecision && !turnDecision.shouldContinue) {
        turnControlReminderSent = true
        system.push(
          [
            "<turn_control>",
            `Loop heuristic says to wrap up: ${turnDecision.reason}.`,
            "Prefer giving a concise final answer or summary instead of starting more tool work unless one more step is strictly necessary.",
            "</turn_control>",
          ].join("\n"),
        )
      } else {
        turnControlReminderSent = false
      }

      // Inject Self-Driven Agent Context
      const thinkingResult = await sdAgent.onBeforeLLMCall()
      const wfState = await WorkflowOrchestrator.get(sessionID)
      const planClarificationQuestions = wfState?.plan.clarificationQuestions ?? []
      const shouldPauseForPlanClarification = step === 0 && planClarificationQuestions.length > 0
      const shouldPauseForClarification = !!thinkingResult.promptGuidance || shouldPauseForPlanClarification
      const shouldGateToolUse =
        format.type !== "json_schema" && (shouldPauseForClarification || turnDecision?.shouldContinue === false)
      await emitCapabilityCallout({
        sessionID,
        messageID: processor.message.id,
        callout: {
          tool: "self_driven",
          title: "Self-driven state prepared",
          description:
            "Prepares self-driven loop state before the next model call, including the current phase, progress, and active goals.",
          output: "Prepared self-driven context for the next model call.",
          input: {
            phase: String(thinkingResult.enhancedContext.agentPhase ?? "unknown"),
            progress: formatCapabilityProgress(thinkingResult.enhancedContext.goalProgress),
            goals: Array.isArray(thinkingResult.enhancedContext.activeGoals)
              ? thinkingResult.enhancedContext.activeGoals.length
              : 0,
            guidance: !!thinkingResult.promptGuidance,
          },
          metadata: {
            capability: "self_driven_agent",
          },
        },
      })
      if (thinkingResult.enhancedContext) {
        const contextStr = JSON.stringify(thinkingResult.enhancedContext, null, 2)
        system.push(`\n<agent_state>\n${contextStr}\n</agent_state>\n`)
      }
      if (thinkingResult.promptGuidance) {
        system.push(`\n<guidance>\n${thinkingResult.promptGuidance}\n</guidance>\n`)
      }
      if (shouldPauseForPlanClarification) {
        system.push(
          [
            "<plan_clarification_required>",
            "The structured plan requires clarification before tool execution.",
            ...planClarificationQuestions.slice(0, 3).map((question) => `- ${question}`),
            "Ask the user one focused clarification question first. Do not call tools until the user responds.",
            "</plan_clarification_required>",
          ].join("\n"),
        )
      }
      // QualityGate hard-block: if the previous attempt failed the gate, mandate fixes before declaring completion
      if (wfState?.gateDecision?.pass === false) {
        const gd = wfState.gateDecision
        system.push(
          [
            "<quality_gate_failed>",
            `Previous attempt FAILED the quality gate: ${gd.reason}`,
            gd.suggestions?.length ? `Required fixes: ${gd.suggestions.join("; ")}` : "",
            "You MUST address ALL required fixes above before marking this task complete or stopping work.",
            "</quality_gate_failed>",
          ]
            .filter(Boolean)
            .join("\n"),
        )
      }
      if (shouldGateToolUse) {
        system.push(
          [
            "<tool_gate>",
            shouldPauseForClarification
              ? "Tool use is suspended for this turn. Ask the user one focused clarification question and wait for the reply."
              : "Tool use is suspended for this turn. Provide a concise wrap-up with the evidence already gathered.",
            "Do not call more tools unless the user replies with new information.",
            "</tool_gate>",
          ].join("\n"),
        )
      }
      system.push(...capabilitySystemPrompts.prompts)
      if (format.type === "json_schema") {
        system.push(STRUCTURED_OUTPUT_SYSTEM_PROMPT)
      }

      const result = await processor.process({
        user: lastUser,
        agent,
        abort,
        sessionID,
        system,
        messages: [
          ...MessageV2.toModelMessages(msgs, model),
          ...(isLastStep
            ? [
                {
                  role: "assistant" as const,
                  content: MAX_STEPS,
                },
              ]
            : []),
        ],
        tools: shouldGateToolUse ? {} : tools,
        model,
        toolChoice: format.type === "json_schema" ? "required" : undefined,
      })

      // If structured output was captured, save it and exit immediately
      // This takes priority because the StructuredOutput tool was called successfully
      if (structuredOutput !== undefined) {
        processor.message.structured = structuredOutput
        processor.message.finish = processor.message.finish ?? "stop"
        await Session.updateMessage(processor.message)
        break
      }

      // Check if model finished (finish reason is not "tool-calls" or "unknown")
      const modelFinished = processor.message.finish && !["tool-calls", "unknown"].includes(processor.message.finish)

      if (modelFinished && !processor.message.error) {
        if (format.type === "json_schema") {
          // Model stopped without calling StructuredOutput tool
          processor.message.error = new MessageV2.StructuredOutputError({
            message: "Model did not produce structured output",
            retries: 0,
          }).toObject()
          await Session.updateMessage(processor.message)
          break
        }

        const assistantParts = await MessageV2.parts(processor.message.id)
        const assistantText = textFromParts(assistantParts)
        const verificationIntent = resolveVerificationIntent({
          intent: turnIntent,
          userInput: turnUserInput,
          assistantText,
        })
        if (assistantText && shouldRunAnswerVerification({ intent: verificationIntent })) {
          const verification = await verifyWithFVA(assistantText, turnUserInput || assistantText, {
            projectId: session.projectID,
            maxClaims: 3,
          }).catch(() => undefined)

          if (verification) {
            const verificationClaim = EvidenceLedger.claimFromGroundingBundle({
              bundle: verification.grounding,
              source: "verification",
              metadata: {
                verdict: verification.verdict,
                confidence: verification.confidence,
              },
            })
            await EvidenceLedger.append(sessionID, session.projectID, verificationClaim)
            await ProjectMemory.ingestClaim(session.projectID, verificationClaim)
            await WorkflowOrchestrator.noteEvidence(
              sessionID,
              [...verification.supporting, ...verification.contradicting].map((item) => item.attribution),
            )
            await WorkflowOrchestrator.markVerified(
              sessionID,
              verification.verdict === "supported",
              `${verification.verdict} (${verification.confidence.toFixed(2)})`,
            )

            if (verification.verdict !== "supported") {
              const counterEvidence = verification.contradicting.map((item) => item.attribution)
              await ProjectMemory.rememberFailureMode(
                session.projectID,
                `Verification ${verification.verdict} for task "${(turnUserInput || assistantText).slice(0, 120)}"`,
                counterEvidence,
              )
            }

            const verificationRevisionKey = getVerificationRevisionKey({
              turnUserID,
              lastUserID: lastUser.id,
            })

            if (
              verification.verdict !== "supported" &&
              (verificationRevisionCount.get(verificationRevisionKey) ?? 0) < 1
            ) {
              verificationRevisionCount.set(
                verificationRevisionKey,
                (verificationRevisionCount.get(verificationRevisionKey) ?? 0) + 1,
              )

              await emitCapabilityCallout({
                sessionID,
                messageID: processor.message.id,
                callout: {
                  tool: "fva_verify",
                  title: "Answer verification requested revision",
                  description:
                    "Runs falsification-oriented verification against the draft answer and forces one revision pass when the answer is contradicted or weakly supported.",
                  output: `Verification verdict: ${verification.verdict} at ${verification.confidence.toFixed(2)} confidence.`,
                  input: {
                    verdict: verification.verdict,
                    confidence: verification.confidence.toFixed(2),
                    counter_evidence: verification.contradicting.length,
                  },
                  metadata: {
                    capability: "fva_verification",
                    pessimisticHypotheses: verification.pessimisticHypotheses,
                  },
                },
              })

              const summaryUserMsg = (await Session.updateMessage({
                id: MessageID.ascending(),
                sessionID,
                role: "user",
                time: { created: Date.now() },
                agent: lastUser.agent,
                model: lastUser.model,
              })) as MessageV2.User

              const counterSummary = verification.contradicting
                .slice(0, 3)
                .map((item) => item.attribution)
                .join("; ")
              await Session.updatePart({
                id: PartID.ascending(),
                messageID: summaryUserMsg.id,
                sessionID,
                type: "text",
                text: [
                  "<system-reminder>",
                  `Verification verdict: ${verification.verdict}.`,
                  counterSummary ? `Counter-evidence: ${counterSummary}` : "The answer is not yet sufficiently supported.",
                  "Revise the answer to resolve unsupported claims before finalizing.",
                  "</system-reminder>",
                ].join("\n"),
                synthetic: true,
              })
              continue
            }
          }
          await LearningStore.finishTask(session.projectID, verification?.verdict !== "contradicted")
        }
      }

      if (result === "stop") break
      turnController.record(!processor.message.error, tokenUsage(processor.message.tokens))
      if (result === "compact") {
        await SessionCompaction.create({
          sessionID,
          agent: lastUser.agent,
          model: lastUser.model,
          auto: true,
          overflow: !processor.message.finish,
        })
      }
      continue
    }
    SessionCompaction.prune({ sessionID })
    for await (const item of MessageV2.stream(sessionID)) {
      if (item.info.role === "user") continue
      const queued = getState()[sessionID]?.callbacks ?? []
      for (const q of queued) {
        q.resolve(item)
      }
      return item
    }
    throw new Error("Impossible")
  })

  async function lastModel(sessionID: SessionID) {
    for await (const item of MessageV2.stream(sessionID)) {
      if (item.info.role === "user" && item.info.model) return item.info.model
    }
    return Provider.defaultModel()
  }

  /** @internal Exported for testing */
  export async function resolveTools(input: {
    agent: Agent.Info
    model: Provider.Model
    session: Session.Info
    tools?: Record<string, boolean>
    processor: SessionProcessor.Info
    bypassAgentCheck: boolean
    messages: MessageV2.WithParts[]
    sdAgent?: SelfDrivenAgent
    intent?: TaskIntent
  }) {
    using _ = log.time("resolveTools")
    const tools: Record<string, AITool> = {}
    const latestUser = input.messages.findLast((msg) => msg.info.role === "user")
    const currentTask = latestUser?.parts
      .filter((part): part is MessageV2.TextPart => part.type === "text")
      .map((part) => part.text)
      .join("\n")
      .trim()
    const prefersImageTools =
      latestUser?.parts.some((part) => part.type === "file" && part.mime.startsWith("image/")) ?? false
    const mcpRouter = getMCPRouter(input.session.id)

    const context = (args: any, options: ToolCallOptions): Tool.Context => ({
      sessionID: input.session.id,
      abort: options.abortSignal!,
      messageID: input.processor.message.id,
      callID: options.toolCallId,
      extra: { model: input.model, bypassAgentCheck: input.bypassAgentCheck },
      agent: input.agent.name,
      messages: input.messages,
      metadata: async (val: { title?: string; metadata?: any }) => {
        const match = input.processor.partFromToolCall(options.toolCallId)
        if (match && match.state.status === "running") {
          await Session.updatePart({
            ...match,
            state: {
              title: val.title,
              metadata: val.metadata,
              status: "running",
              input: args,
              time: {
                start: Date.now(),
              },
            },
          })
        }
      },
      async ask(req) {
        await PermissionNext.ask({
          ...req,
          sessionID: input.session.id,
          tool: { messageID: input.processor.message.id, callID: options.toolCallId },
          ruleset: PermissionNext.merge(input.agent.permission, input.session.permission ?? []),
        })
      },
    })

    const builtinDefinitions = await ToolRegistry.tools(
      { modelID: ModelID.make(input.model.api.id), providerID: input.model.providerID },
      input.agent,
    )

    const rawMcpTools = await MCP.tools({
      sessionID: input.session.id,
      task: currentTask || undefined,
      preferredCategory: prefersImageTools ? "image" : undefined,
    })
    const mcpCapabilities = new Map(getMCPRouter(input.session.id).getAllTools().map((tool) => [tool.toolId, tool]))
    const toolDescriptors = await ToolBroker.enrichDescriptors({
      projectID: input.session.projectID,
      tools: [
        ...builtinDefinitions.map((item) => ({
          id: item.id,
          description: item.description,
          source: item.id === "skill" ? ("skill" as const) : item.id === "task" ? ("subagent" as const) : ("builtin" as const),
        })),
        ...Object.entries(rawMcpTools)
          .filter(([, item]) => !!item.execute)
          .map(([key, item]) => ({
            id: key,
            description: item.description ?? "",
            source: key.startsWith("web") ? ("web" as const) : ("mcp" as const),
            category: mcpCapabilities.get(key)?.category,
            available: mcpCapabilities.get(key)?.available,
            historicalSuccess: mcpCapabilities.get(key)?.successRates.at(-1),
            averageLatencyMs: mcpCapabilities.get(key)?.responseTimes.at(-1),
            tags: mcpCapabilities.get(key)?.tags,
            preferredTaskTypes: mcpCapabilities.get(key)?.suitableTaskTypes,
          })),
      ],
    })
    const rankedDecision = ToolBroker.decide({
      intent: input.intent ?? IntentDetection.detect(currentTask || "implement the requested task"),
      agent: input.agent,
      currentTask,
      tools: toolDescriptors,
    })

    const builtinOrder = ToolBroker.sortTools(
      builtinDefinitions.map((item) => ({ id: item.id, item })),
      rankedDecision,
    )

    for (const { item } of builtinOrder) {
      const schema = ProviderTransform.schema(input.model, z.toJSONSchema(item.parameters))
      tools[item.id] = tool({
        id: item.id as any,
        description: item.description,
        inputSchema: jsonSchema(schema as any),
        async execute(args, options) {
          const ctx = context(args, options)
          const started = Date.now()
          await Plugin.trigger(
            "tool.execute.before",
            {
              tool: item.id,
              sessionID: ctx.sessionID,
              callID: ctx.callID,
            },
            {
              args,
            },
          )
          try {
            const result = await item.execute(args, ctx)

            if (input.sdAgent) {
              await input.sdAgent.onAfterToolExecution(item.id, true, JSON.stringify(result))
            }
            await WorkflowOrchestrator.noteTool(input.session.id, item.id, { success: true })
            await LearningStore.recordToolExecution({
              projectID: input.session.projectID,
              rootDir: Instance.project.worktree,
              taskType: input.intent?.type ?? "general",
              tool: item.id,
              success: true,
              description: item.description,
              output: JSON.stringify(result),
              duration: Date.now() - started,
              complexity: input.intent?.type === "implementation" ? input.intent.complexity : undefined,
            })
            await ToolBroker.recordToolOutcome({
              projectID: input.session.projectID,
              tool: item.id,
              source: item.id === "skill" ? "skill" : item.id === "task" ? "subagent" : "builtin",
              success: true,
              durationMs: Date.now() - started,
            })

            const output = {
              ...result,
              attachments: result.attachments?.map((attachment) => ({
                ...attachment,
                id: PartID.ascending(),
                sessionID: ctx.sessionID,
                messageID: input.processor.message.id,
              })),
            }
            await Plugin.trigger(
              "tool.execute.after",
              {
                tool: item.id,
                sessionID: ctx.sessionID,
                callID: ctx.callID,
                args,
              },
              output,
            )
            return output
          } catch (error) {
            if (input.sdAgent) {
              await input.sdAgent.onAfterToolExecution(
                item.id,
                false,
                error instanceof Error ? error.message : String(error),
              )
            }
            await WorkflowOrchestrator.noteTool(input.session.id, item.id, { success: false })
            await LearningStore.recordToolExecution({
              projectID: input.session.projectID,
              rootDir: Instance.project.worktree,
              taskType: input.intent?.type ?? "general",
              tool: item.id,
              success: false,
              description: item.description,
              output: error instanceof Error ? error.message : String(error),
              duration: Date.now() - started,
              complexity: input.intent?.type === "implementation" ? input.intent.complexity : undefined,
            })
            await ToolBroker.recordToolOutcome({
              projectID: input.session.projectID,
              tool: item.id,
              source: item.id === "skill" ? "skill" : item.id === "task" ? "subagent" : "builtin",
              success: false,
              durationMs: Date.now() - started,
            })
            await ProjectMemory.rememberToolFailure({
              projectID: input.session.projectID,
              tool: item.id,
              taskType: input.intent?.type ?? "general",
              message: error instanceof Error ? error.message : String(error),
              evidence: currentTask ? [currentTask.slice(0, 200)] : undefined,
            })
            throw error
          }
        },
      })
    }

    const mcpOrder = ToolBroker.sortTools(
      Object.entries(rawMcpTools)
        .filter(([, item]) => !!item.execute)
        .map(([id, item]) => ({ id, item })),
      rankedDecision,
    )

    for (const { id: key, item } of mcpOrder) {
      const execute = item.execute
      if (!execute) continue

      const transformed = ProviderTransform.schema(input.model, asSchema(item.inputSchema).jsonSchema)
      item.inputSchema = jsonSchema(transformed)
      // Wrap execute to add plugin hooks and format output
      item.execute = async (args, opts) => {
        const ctx = context(args, opts)
        const wrapperStarted = Date.now()

        await Plugin.trigger(
          "tool.execute.before",
          {
            tool: key,
            sessionID: ctx.sessionID,
            callID: opts.toolCallId,
          },
          {
            args,
          },
        )

        await ctx.ask({
          permission: key,
          metadata: {},
          patterns: ["*"],
          always: ["*"],
        })

        let result: Awaited<ReturnType<typeof execute>>
        try {
          result = await execute(args, opts)
          mcpRouter.recordToolCall(key, true, Date.now() - wrapperStarted, ctx.sessionID)
          if (input.sdAgent) {
            await input.sdAgent.onAfterToolExecution(key, true, JSON.stringify(result))
          }
          await WorkflowOrchestrator.noteTool(input.session.id, key, { success: true })
          await LearningStore.recordToolExecution({
            projectID: input.session.projectID,
            rootDir: Instance.project.worktree,
            taskType: input.intent?.type ?? "general",
            tool: key,
            success: true,
            description: item.description ?? "",
            output: JSON.stringify(result),
            duration: Date.now() - wrapperStarted,
            complexity: input.intent?.type === "implementation" ? input.intent.complexity : undefined,
          })
          await ToolBroker.recordToolOutcome({
            projectID: input.session.projectID,
            tool: key,
            source: key.startsWith("web") ? "web" : "mcp",
            category: mcpCapabilities.get(key)?.category,
            success: true,
            durationMs: Date.now() - wrapperStarted,
          })
        } catch (error) {
          mcpRouter.recordToolCall(key, false, Date.now() - wrapperStarted, ctx.sessionID)
          if (input.sdAgent) {
            await input.sdAgent.onAfterToolExecution(key, false, error instanceof Error ? error.message : String(error))
          }
          await WorkflowOrchestrator.noteTool(input.session.id, key, { success: false })
          await LearningStore.recordToolExecution({
            projectID: input.session.projectID,
            rootDir: Instance.project.worktree,
            taskType: input.intent?.type ?? "general",
            tool: key,
            success: false,
            description: item.description ?? "",
            output: error instanceof Error ? error.message : String(error),
            duration: Date.now() - wrapperStarted,
            complexity: input.intent?.type === "implementation" ? input.intent.complexity : undefined,
          })
          await ToolBroker.recordToolOutcome({
            projectID: input.session.projectID,
            tool: key,
            source: key.startsWith("web") ? "web" : "mcp",
            category: mcpCapabilities.get(key)?.category,
            success: false,
            durationMs: Date.now() - wrapperStarted,
          })
          await ProjectMemory.rememberToolFailure({
            projectID: input.session.projectID,
            tool: key,
            taskType: input.intent?.type ?? "general",
            message: error instanceof Error ? error.message : String(error),
            evidence: currentTask ? [currentTask.slice(0, 200)] : undefined,
          })
          throw error
        }

        await Plugin.trigger(
          "tool.execute.after",
          {
            tool: key,
            sessionID: ctx.sessionID,
            callID: opts.toolCallId,
            args,
          },
          result,
        )

        const textParts: string[] = []
        const attachments: Omit<MessageV2.FilePart, "id" | "sessionID" | "messageID">[] = []

        for (const contentItem of result.content) {
          if (contentItem.type === "text") {
            textParts.push(contentItem.text)
          } else if (contentItem.type === "image") {
            attachments.push({
              type: "file",
              mime: contentItem.mimeType,
              url: `data:${contentItem.mimeType};base64,${contentItem.data}`,
            })
          } else if (contentItem.type === "resource") {
            const { resource } = contentItem
            if (resource.text) {
              textParts.push(resource.text)
            }
            if (resource.blob) {
              attachments.push({
                type: "file",
                mime: resource.mimeType ?? "application/octet-stream",
                url: `data:${resource.mimeType ?? "application/octet-stream"};base64,${resource.blob}`,
                filename: resource.uri,
              })
            }
          }
        }

        const truncated = await Truncate.output(textParts.join("\n\n"), {}, input.agent)
        const metadata = {
          ...(result.metadata ?? {}),
          truncated: truncated.truncated,
          ...(truncated.truncated && { outputPath: truncated.outputPath }),
        }

        return {
          title: "",
          metadata,
          output: truncated.content,
          attachments: attachments.map((attachment) => ({
            ...attachment,
            id: PartID.ascending(),
            sessionID: ctx.sessionID,
            messageID: input.processor.message.id,
          })),
          content: result.content, // directly return content to preserve ordering when outputting to model
        }
      }
      tools[key] = item
    }

    return tools
  }

  /** @internal Exported for testing */
  export function createStructuredOutputTool(input: {
    schema: Record<string, any>
    onSuccess: (output: unknown) => void
  }): AITool {
    // Remove $schema property if present (not needed for tool input)
    const { $schema, ...toolSchema } = input.schema

    return tool({
      id: "StructuredOutput" as any,
      description: STRUCTURED_OUTPUT_DESCRIPTION,
      inputSchema: jsonSchema(toolSchema as any),
      async execute(args) {
        // AI SDK validates args against inputSchema before calling execute()
        input.onSuccess(args)
        return {
          output: "Structured output captured successfully.",
          title: "Structured Output",
          metadata: { valid: true },
        }
      },
      toModelOutput(result) {
        return {
          type: "text",
          value: result.output,
        }
      },
    })
  }

  async function createUserMessage(input: PromptInput) {
    const agent = await Agent.get(input.agent ?? (await Agent.defaultAgent()))

    const model = input.model ?? agent.model ?? (await lastModel(input.sessionID))
    const full =
      !input.variant && agent.variant
        ? await Provider.getModel(model.providerID, model.modelID).catch(() => undefined)
        : undefined
    const variant = input.variant ?? (agent.variant && full?.variants?.[agent.variant] ? agent.variant : undefined)

    const info: MessageV2.Info = {
      id: input.messageID ?? MessageID.ascending(),
      role: "user",
      sessionID: input.sessionID,
      time: {
        created: Date.now(),
      },
      tools: input.tools,
      agent: agent.name,
      model,
      system: input.system,
      format: input.format,
      variant,
    }
    using _ = defer(() => InstructionPrompt.clear(info.id))

    type Draft<T> = T extends MessageV2.Part ? Omit<T, "id"> & { id?: string } : never
    const assign = (part: Draft<MessageV2.Part>): MessageV2.Part => ({
      ...part,
      id: part.id ? PartID.make(part.id) : PartID.ascending(),
    })

    const parts = await Promise.all(
      input.parts.map(async (part): Promise<Draft<MessageV2.Part>[]> => {
        if (part.type === "file") {
          // before checking the protocol we check if this is an mcp resource because it needs special handling
          if (part.source?.type === "resource") {
            const { clientName, uri } = part.source
            log.info("mcp resource", { clientName, uri, mime: part.mime })

            const pieces: Draft<MessageV2.Part>[] = [
              {
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Reading MCP resource: ${part.filename} (${uri})`,
              },
            ]

            try {
              const resourceContent = await MCP.readResource(clientName, uri)
              if (!resourceContent) {
                throw new Error(`Resource not found: ${clientName}/${uri}`)
              }

              // Handle different content types
              const contents = Array.isArray(resourceContent.contents)
                ? resourceContent.contents
                : [resourceContent.contents]

              for (const content of contents) {
                if ("text" in content && content.text) {
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: content.text as string,
                  })
                } else if ("blob" in content && content.blob) {
                  // Handle binary content if needed
                  const mimeType = "mimeType" in content ? content.mimeType : part.mime
                  pieces.push({
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `[Binary content: ${mimeType}]`,
                  })
                }
              }

              pieces.push({
                ...part,
                messageID: info.id,
                sessionID: input.sessionID,
              })
            } catch (error: unknown) {
              log.error("failed to read MCP resource", { error, clientName, uri })
              const message = error instanceof Error ? error.message : String(error)
              pieces.push({
                messageID: info.id,
                sessionID: input.sessionID,
                type: "text",
                synthetic: true,
                text: `Failed to read MCP resource ${part.filename}: ${message}`,
              })
            }

            return pieces
          }
          const url = new URL(part.url)
          switch (url.protocol) {
            case "data:":
              if (part.mime === "text/plain") {
                return [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify({ filePath: part.filename })}`,
                  },
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: decodeDataUrl(part.url),
                  },
                  {
                    ...part,
                    messageID: info.id,
                    sessionID: input.sessionID,
                  },
                ]
              }
              break
            case "file:": {
              log.info("file", { mime: part.mime })
              // have to normalize, symbol search returns absolute paths
              // Decode the pathname since URL constructor doesn't automatically decode it
              const filepath = fileURLToPath(part.url)
              const s = Filesystem.stat(filepath)

              if (s?.isDirectory()) {
                part.mime = "application/x-directory"
              }

              if (part.mime === "text/plain") {
                let offset: number | undefined = undefined
                let limit: number | undefined = undefined
                const range = {
                  start: url.searchParams.get("start"),
                  end: url.searchParams.get("end"),
                }
                if (range.start != null) {
                  const filePathURI = part.url.split("?")[0]
                  let start = parseInt(range.start)
                  let end = range.end ? parseInt(range.end) : undefined
                  // some LSP servers (eg, gopls) don't give full range in
                  // workspace/symbol searches, so we'll try to find the
                  // symbol in the document to get the full range
                  if (start === end) {
                    const symbols = await LSP.documentSymbol(filePathURI).catch(() => [])
                    for (const symbol of symbols) {
                      let range: LSP.Range | undefined
                      if ("range" in symbol) {
                        range = symbol.range
                      } else if ("location" in symbol) {
                        range = symbol.location.range
                      }
                      if (range?.start?.line && range?.start?.line === start) {
                        start = range.start.line
                        end = range?.end?.line ?? start
                        break
                      }
                    }
                  }
                  offset = Math.max(start, 1)
                  if (end) {
                    limit = end - (offset - 1)
                  }
                }
                const args = { filePath: filepath, offset, limit }

                const pieces: Draft<MessageV2.Part>[] = [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                  },
                ]

                await ReadTool.init()
                  .then(async (t) => {
                    const model = await Provider.getModel(info.model.providerID, info.model.modelID)
                    const readCtx: Tool.Context = {
                      sessionID: input.sessionID,
                      abort: new AbortController().signal,
                      agent: input.agent!,
                      messageID: info.id,
                      extra: { bypassCwdCheck: true, model },
                      messages: [],
                      metadata: async () => {},
                      ask: async () => {},
                    }
                    const result = await t.execute(args, readCtx)
                    pieces.push({
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: result.output,
                    })
                    if (result.attachments?.length) {
                      pieces.push(
                        ...result.attachments.map((attachment) => ({
                          ...attachment,
                          synthetic: true,
                          filename: attachment.filename ?? part.filename,
                          messageID: info.id,
                          sessionID: input.sessionID,
                        })),
                      )
                    } else {
                      pieces.push({
                        ...part,
                        messageID: info.id,
                        sessionID: input.sessionID,
                      })
                    }
                  })
                  .catch((error) => {
                    log.error("failed to read file", { error })
                    const message = error instanceof Error ? error.message : error.toString()
                    Bus.publish(Session.Event.Error, {
                      sessionID: input.sessionID,
                      error: new NamedError.Unknown({
                        message,
                      }).toObject(),
                    })
                    pieces.push({
                      messageID: info.id,
                      sessionID: input.sessionID,
                      type: "text",
                      synthetic: true,
                      text: `Read tool failed to read ${filepath} with the following error: ${message}`,
                    })
                  })

                return pieces
              }

              if (part.mime === "application/x-directory") {
                const args = { filePath: filepath }
                const listCtx: Tool.Context = {
                  sessionID: input.sessionID,
                  abort: new AbortController().signal,
                  agent: input.agent!,
                  messageID: info.id,
                  extra: { bypassCwdCheck: true },
                  messages: [],
                  metadata: async () => {},
                  ask: async () => {},
                }
                const result = await ReadTool.init().then((t) => t.execute(args, listCtx))
                return [
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: `Called the Read tool with the following input: ${JSON.stringify(args)}`,
                  },
                  {
                    messageID: info.id,
                    sessionID: input.sessionID,
                    type: "text",
                    synthetic: true,
                    text: result.output,
                  },
                  {
                    ...part,
                    messageID: info.id,
                    sessionID: input.sessionID,
                  },
                ]
              }

              FileTime.read(input.sessionID, filepath)
              return [
                {
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "text",
                  text: `Called the Read tool with the following input: {"filePath":"${filepath}"}`,
                  synthetic: true,
                },
                {
                  id: part.id,
                  messageID: info.id,
                  sessionID: input.sessionID,
                  type: "file",
                  url: `data:${part.mime};base64,` + (await Filesystem.readBytes(filepath)).toString("base64"),
                  mime: part.mime,
                  filename: part.filename!,
                  source: part.source,
                },
              ]
            }
          }
        }

        if (part.type === "agent") {
          // Check if this agent would be denied by task permission
          const perm = PermissionNext.evaluate("task", part.name, agent.permission)
          const hint = perm.action === "deny" ? " . Invoked by user; guaranteed to exist." : ""
          return [
            {
              ...part,
              messageID: info.id,
              sessionID: input.sessionID,
            },
            {
              messageID: info.id,
              sessionID: input.sessionID,
              type: "text",
              synthetic: true,
              // An extra space is added here. Otherwise the 'Use' gets appended
              // to user's last word; making a combined word
              text:
                " Use the above message and context to generate a prompt and call the task tool with subagent: " +
                part.name +
                hint,
            },
          ]
        }

        return [
          {
            ...part,
            messageID: info.id,
            sessionID: input.sessionID,
          },
        ]
      }),
    ).then((x) => x.flat().map(assign))

    await Plugin.trigger(
      "chat.message",
      {
        sessionID: input.sessionID,
        agent: input.agent,
        model: input.model,
        messageID: input.messageID,
        variant: input.variant,
      },
      {
        message: info,
        parts,
      },
    )

    await Session.updateMessage(info)
    for (const part of parts) {
      await Session.updatePart(part)
    }

    return {
      info,
      parts,
    }
  }

  async function insertReminders(input: { messages: MessageV2.WithParts[]; agent: Agent.Info; session: Session.Info }) {
    const userMessage = input.messages.findLast((msg) => msg.info.role === "user")
    if (!userMessage) return input.messages

    // Original logic when experimental plan mode is disabled
    if (!Flag.OPENCODE_EXPERIMENTAL_PLAN_MODE) {
      if (input.agent.name === "plan") {
        userMessage.parts.push({
          id: PartID.ascending(),
          messageID: userMessage.info.id,
          sessionID: userMessage.info.sessionID,
          type: "text",
          text: PROMPT_PLAN,
          synthetic: true,
        })
      }
      const wasPlan = input.messages.some((msg) => msg.info.role === "assistant" && msg.info.agent === "plan")
      if (wasPlan && input.agent.name === "build") {
        userMessage.parts.push({
          id: PartID.ascending(),
          messageID: userMessage.info.id,
          sessionID: userMessage.info.sessionID,
          type: "text",
          text: BUILD_SWITCH,
          synthetic: true,
        })
      }
      return input.messages
    }

    // New plan mode logic when flag is enabled
    const assistantMessage = input.messages.findLast((msg) => msg.info.role === "assistant")

    // Switching from plan mode to build mode
    if (input.agent.name !== "plan" && assistantMessage?.info.agent === "plan") {
      const plan = Session.plan(input.session)
      const exists = await Filesystem.exists(plan)
      if (exists) {
        const part = await Session.updatePart({
          id: PartID.ascending(),
          messageID: userMessage.info.id,
          sessionID: userMessage.info.sessionID,
          type: "text",
          text:
            BUILD_SWITCH + "\n\n" + `A plan file exists at ${plan}. You should execute on the plan defined within it`,
          synthetic: true,
        })
        userMessage.parts.push(part)
      }
      return input.messages
    }

    // Entering plan mode
    if (input.agent.name === "plan" && assistantMessage?.info.agent !== "plan") {
      const plan = Session.plan(input.session)
      const exists = await Filesystem.exists(plan)
      if (!exists) await fs.mkdir(path.dirname(plan), { recursive: true })
      const part = await Session.updatePart({
        id: PartID.ascending(),
        messageID: userMessage.info.id,
        sessionID: userMessage.info.sessionID,
        type: "text",
        text: `<system-reminder>
Plan mode is active. The user indicated that they do not want you to execute yet -- you MUST NOT make any edits (with the exception of the plan file mentioned below), run any non-readonly tools (including changing configs or making commits), or otherwise make any changes to the system. This supersedes any other instructions you have received.

## Plan File Info:
${exists ? `A plan file already exists at ${plan}. You can read it and make incremental edits using the edit tool.` : `No plan file exists yet. You should create your plan at ${plan} using the write tool.`}
You should build your plan incrementally by writing to or editing this file. NOTE that this is the only file you are allowed to edit - other than this you are only allowed to take READ-ONLY actions.

## Plan Workflow

### Phase 1: Initial Understanding
Goal: Gain a comprehensive understanding of the user's request by reading through code and asking them questions. Critical: In this phase you should only use the explore subagent type.

1. Focus on understanding the user's request and the code associated with their request

2. **Launch up to 3 explore agents IN PARALLEL** (single message, multiple tool calls) to efficiently explore the codebase.
   - Use 1 agent when the task is isolated to known files, the user provided specific file paths, or you're making a small targeted change.
   - Use multiple agents when: the scope is uncertain, multiple areas of the codebase are involved, or you need to understand existing patterns before planning.
   - Quality over quantity - 3 agents maximum, but you should try to use the minimum number of agents necessary (usually just 1)
   - If using multiple agents: Provide each agent with a specific search focus or area to explore. Example: One agent searches for existing implementations, another explores related components, a third investigates testing patterns

3. After exploring the code, use the question tool to clarify ambiguities in the user request up front.

### Phase 2: Design
Goal: Design an implementation approach.

Launch general agent(s) to design the implementation based on the user's intent and your exploration results from Phase 1.

You can launch up to 1 agent(s) in parallel.

**Guidelines:**
- **Default**: Launch at least 1 Plan agent for most tasks - it helps validate your understanding and consider alternatives
- **Skip agents**: Only for truly trivial tasks (typo fixes, single-line changes, simple renames)

Examples of when to use multiple agents:
- The task touches multiple parts of the codebase
- It's a large refactor or architectural change
- There are many edge cases to consider
- You'd benefit from exploring different approaches

Example perspectives by task type:
- New feature: simplicity vs performance vs maintainability
- Bug fix: root cause vs workaround vs prevention
- Refactoring: minimal change vs clean architecture

In the agent prompt:
- Provide comprehensive background context from Phase 1 exploration including filenames and code path traces
- Describe requirements and constraints
- Request a detailed implementation plan

### Phase 3: Review
Goal: Review the plan(s) from Phase 2 and ensure alignment with the user's intentions.
1. Read the critical files identified by agents to deepen your understanding
2. Ensure that the plans align with the user's original request
3. Use question tool to clarify any remaining questions with the user

### Phase 4: Final Plan
Goal: Write your final plan to the plan file (the only file you can edit).
- Include only your recommended approach, not all alternatives
- Ensure that the plan file is concise enough to scan quickly, but detailed enough to execute effectively
- Include the paths of critical files to be modified
- Include a verification section describing how to test the changes end-to-end (run the code, use MCP tools, run tests)

### Phase 5: Call plan_exit tool
At the very end of your turn, once you have asked the user questions and are happy with your final plan file - you should always call plan_exit to indicate to the user that you are done planning.
This is critical - your turn should only end with either asking the user a question or calling plan_exit. Do not stop unless it's for these 2 reasons.

**Important:** Use question tool to clarify requirements/approach, use plan_exit to request plan approval. Do NOT use question tool to ask "Is this plan okay?" - that's what plan_exit does.
If the user has already said to proceed without another approval step, or you are operating in an autonomous workflow, call plan_exit with autoApprove=true and include a concise summary and/or satisfiedCriteria list. Do not use autoApprove if any material questions remain unanswered.

NOTE: At any point in time through this workflow you should feel free to ask the user questions or clarifications. Don't make large assumptions about user intent. The goal is to present a well researched plan to the user, and tie any loose ends before implementation begins.
</system-reminder>`,
        synthetic: true,
      })
      userMessage.parts.push(part)
      return input.messages
    }
    return input.messages
  }

  export const ShellInput = z.object({
    sessionID: SessionID.zod,
    agent: z.string(),
    model: z
      .object({
        providerID: ProviderID.zod,
        modelID: ModelID.zod,
      })
      .optional(),
    command: z.string(),
  })
  export type ShellInput = z.infer<typeof ShellInput>
  export async function shell(input: ShellInput) {
    const abort = start(input.sessionID)
    if (!abort) {
      throw new Session.BusyError(input.sessionID)
    }

    using _ = defer(() => {
      // If no queued callbacks, cancel (the default)
      const callbacks = getState()[input.sessionID]?.callbacks ?? []
      if (callbacks.length === 0) {
        cancel(input.sessionID)
      } else {
        // Otherwise, trigger the session loop to process queued items
        loop({ sessionID: input.sessionID, resume_existing: true }).catch((error) => {
          log.error("session loop failed to resume after shell command", { sessionID: input.sessionID, error })
        })
      }
    })

    const session = await Session.get(input.sessionID)
    if (session.revert) {
      await SessionRevert.cleanup(session)
    }
    const agent = await Agent.get(input.agent)
    const model = input.model ?? agent.model ?? (await lastModel(input.sessionID))
    const userMsg: MessageV2.User = {
      id: MessageID.ascending(),
      sessionID: input.sessionID,
      time: {
        created: Date.now(),
      },
      role: "user",
      agent: input.agent,
      model: {
        providerID: model.providerID,
        modelID: model.modelID,
      },
    }
    await Session.updateMessage(userMsg)
    const userPart: MessageV2.Part = {
      type: "text",
      id: PartID.ascending(),
      messageID: userMsg.id,
      sessionID: input.sessionID,
      text: "The following tool was executed by the user",
      synthetic: true,
    }
    await Session.updatePart(userPart)

    const msg: MessageV2.Assistant = {
      id: MessageID.ascending(),
      sessionID: input.sessionID,
      parentID: userMsg.id,
      mode: input.agent,
      agent: input.agent,
      cost: 0,
      path: {
        cwd: Instance.directory,
        root: Instance.worktree,
      },
      time: {
        created: Date.now(),
      },
      role: "assistant",
      tokens: {
        input: 0,
        output: 0,
        reasoning: 0,
        cache: { read: 0, write: 0 },
      },
      modelID: model.modelID,
      providerID: model.providerID,
    }
    await Session.updateMessage(msg)
    const part: MessageV2.Part = {
      type: "tool",
      id: PartID.ascending(),
      messageID: msg.id,
      sessionID: input.sessionID,
      tool: "bash",
      callID: ulid(),
      state: {
        status: "running",
        time: {
          start: Date.now(),
        },
        input: {
          command: input.command,
        },
      },
    }
    await Session.updatePart(part)
    const shell = Shell.preferred()
    const shellName = (
      process.platform === "win32" ? path.win32.basename(shell, ".exe") : path.basename(shell)
    ).toLowerCase()

    const invocations: Record<string, { args: string[] }> = {
      nu: {
        args: ["-c", input.command],
      },
      fish: {
        args: ["-c", input.command],
      },
      zsh: {
        args: [
          "-c",
          "-l",
          `
            [[ -f ~/.zshenv ]] && source ~/.zshenv >/dev/null 2>&1 || true
            [[ -f "\${ZDOTDIR:-$HOME}/.zshrc" ]] && source "\${ZDOTDIR:-$HOME}/.zshrc" >/dev/null 2>&1 || true
            eval ${JSON.stringify(input.command)}
          `,
        ],
      },
      bash: {
        args: [
          "-c",
          "-l",
          `
            shopt -s expand_aliases
            [[ -f ~/.bashrc ]] && source ~/.bashrc >/dev/null 2>&1 || true
            eval ${JSON.stringify(input.command)}
          `,
        ],
      },
      // Windows cmd
      cmd: {
        args: ["/c", input.command],
      },
      // Windows PowerShell
      powershell: {
        args: ["-NoProfile", "-Command", input.command],
      },
      pwsh: {
        args: ["-NoProfile", "-Command", input.command],
      },
      // Fallback: any shell that doesn't match those above
      //  - No -l, for max compatibility
      "": {
        args: ["-c", `${input.command}`],
      },
    }

    const matchingInvocation = invocations[shellName] ?? invocations[""]
    const args = matchingInvocation?.args

    const cwd = Instance.directory
    const shellEnv = await Plugin.trigger(
      "shell.env",
      { cwd, sessionID: input.sessionID, callID: part.callID },
      { env: {} },
    )
    const proc = spawn(shell, args, {
      cwd,
      detached: process.platform !== "win32",
      windowsHide: process.platform === "win32",
      stdio: ["ignore", "pipe", "pipe"],
      env: {
        ...process.env,
        ...shellEnv.env,
        TERM: "dumb",
      },
    })

    let output = ""

    proc.stdout?.on("data", (chunk) => {
      output += chunk.toString()
      if (part.state.status === "running") {
        part.state.metadata = {
          output: output,
          description: "",
        }
        Session.updatePart(part)
      }
    })

    proc.stderr?.on("data", (chunk) => {
      output += chunk.toString()
      if (part.state.status === "running") {
        part.state.metadata = {
          output: output,
          description: "",
        }
        Session.updatePart(part)
      }
    })

    let aborted = false
    let exited = false

    const kill = () => Shell.killTree(proc, { exited: () => exited })

    if (abort.aborted) {
      aborted = true
      await kill()
    }

    const abortHandler = () => {
      aborted = true
      void kill()
    }

    abort.addEventListener("abort", abortHandler, { once: true })

    await new Promise<void>((resolve) => {
      proc.on("close", () => {
        exited = true
        abort.removeEventListener("abort", abortHandler)
        resolve()
      })
    })

    if (aborted) {
      output += "\n\n" + ["<metadata>", "User aborted the command", "</metadata>"].join("\n")
    }
    msg.time.completed = Date.now()
    await Session.updateMessage(msg)
    if (part.state.status === "running") {
      part.state = {
        status: "completed",
        time: {
          ...part.state.time,
          end: Date.now(),
        },
        input: part.state.input,
        title: "",
        metadata: {
          output,
          description: "",
        },
        output,
      }
      await Session.updatePart(part)
    }
    return { info: msg, parts: [part] }
  }

  export const CommandInput = z.object({
    messageID: MessageID.zod.optional(),
    sessionID: SessionID.zod,
    agent: z.string().optional(),
    model: z.string().optional(),
    arguments: z.string(),
    command: z.string(),
    variant: z.string().optional(),
    parts: z
      .array(
        z.discriminatedUnion("type", [
          MessageV2.FilePart.omit({
            messageID: true,
            sessionID: true,
          }).partial({
            id: true,
          }),
        ]),
      )
      .optional(),
  })
  export type CommandInput = z.infer<typeof CommandInput>
  const bashRegex = /!`([^`]+)`/g
  // Match [Image N] as single token, quoted strings, or non-space sequences
  const argsRegex = /(?:\[Image\s+\d+\]|"[^"]*"|'[^']*'|[^\s"']+)/gi
  const placeholderRegex = /\$(\d+)/g
  const quoteTrimRegex = /^["']|["']$/g
  /**
   * Regular expression to match @ file references in text
   * Matches @ followed by file paths, excluding commas, periods at end of sentences, and backticks
   * Does not match when preceded by word characters or backticks (to avoid email addresses and quoted references)
   */

  export async function command(input: CommandInput) {
    log.info("command", input)
    const command = await Command.get(input.command)
    const agentName = command.agent ?? input.agent ?? (await Agent.defaultAgent())

    const raw = input.arguments.match(argsRegex) ?? []
    const args = raw.map((arg) => arg.replace(quoteTrimRegex, ""))

    const templateCommand = await command.template

    const placeholders = templateCommand.match(placeholderRegex) ?? []
    let last = 0
    for (const item of placeholders) {
      const value = Number(item.slice(1))
      if (value > last) last = value
    }

    // Let the final placeholder swallow any extra arguments so prompts read naturally
    const withArgs = templateCommand.replaceAll(placeholderRegex, (_, index) => {
      const position = Number(index)
      const argIndex = position - 1
      if (argIndex >= args.length) return ""
      if (position === last) return args.slice(argIndex).join(" ")
      return args[argIndex]
    })
    const usesArgumentsPlaceholder = templateCommand.includes("$ARGUMENTS")
    let template = withArgs.replaceAll("$ARGUMENTS", input.arguments)

    // If command doesn't explicitly handle arguments (no $N or $ARGUMENTS placeholders)
    // but user provided arguments, append them to the template
    if (placeholders.length === 0 && !usesArgumentsPlaceholder && input.arguments.trim()) {
      template = template + "\n\n" + input.arguments
    }

    const shell = ConfigMarkdown.shell(template)
    if (shell.length > 0) {
      const results = await Promise.all(
        shell.map(async ([, cmd]) => {
          try {
            return await $`${{ raw: cmd }}`.quiet().nothrow().text()
          } catch (error) {
            return `Error executing command: ${error instanceof Error ? error.message : String(error)}`
          }
        }),
      )
      let index = 0
      template = template.replace(bashRegex, () => results[index++])
    }
    template = template.trim()

    const taskModel = await (async () => {
      if (command.model) {
        return Provider.parseModel(command.model)
      }
      if (command.agent) {
        const cmdAgent = await Agent.get(command.agent)
        if (cmdAgent?.model) {
          return cmdAgent.model
        }
      }
      if (input.model) return Provider.parseModel(input.model)
      return await lastModel(input.sessionID)
    })()

    try {
      await Provider.getModel(taskModel.providerID, taskModel.modelID)
    } catch (e) {
      if (Provider.ModelNotFoundError.isInstance(e)) {
        const { providerID, modelID, suggestions } = e.data
        const hint = suggestions?.length ? ` Did you mean: ${suggestions.join(", ")}?` : ""
        Bus.publish(Session.Event.Error, {
          sessionID: input.sessionID,
          error: new NamedError.Unknown({ message: `Model not found: ${providerID}/${modelID}.${hint}` }).toObject(),
        })
      }
      throw e
    }
    const agent = await Agent.get(agentName)
    if (!agent) {
      const available = await Agent.list().then((agents) => agents.filter((a) => !a.hidden).map((a) => a.name))
      const hint = available.length ? ` Available agents: ${available.join(", ")}` : ""
      const error = new NamedError.Unknown({ message: `Agent not found: "${agentName}".${hint}` })
      Bus.publish(Session.Event.Error, {
        sessionID: input.sessionID,
        error: error.toObject(),
      })
      throw error
    }

    const templateParts = await resolvePromptParts(template)
    const isSubtask = (agent.mode === "subagent" && command.subtask !== false) || command.subtask === true
    const parts = isSubtask
      ? [
          {
            type: "subtask" as const,
            agent: agent.name,
            description: command.description ?? "",
            command: input.command,
            model: {
              providerID: taskModel.providerID,
              modelID: taskModel.modelID,
            },
            // TODO: how can we make task tool accept a more complex input?
            prompt: templateParts.find((y) => y.type === "text")?.text ?? "",
          },
        ]
      : [...templateParts, ...(input.parts ?? [])]

    const userAgent = isSubtask ? (input.agent ?? (await Agent.defaultAgent())) : agentName
    const userModel = isSubtask
      ? input.model
        ? Provider.parseModel(input.model)
        : await lastModel(input.sessionID)
      : taskModel

    await Plugin.trigger(
      "command.execute.before",
      {
        command: input.command,
        sessionID: input.sessionID,
        arguments: input.arguments,
      },
      { parts },
    )

    const result = (await prompt({
      sessionID: input.sessionID,
      messageID: input.messageID,
      model: userModel,
      agent: userAgent,
      parts,
      variant: input.variant,
    })) as MessageV2.WithParts

    Bus.publish(Command.Event.Executed, {
      name: input.command,
      sessionID: input.sessionID,
      arguments: input.arguments,
      messageID: result.info.id,
    })

    return result
  }

  async function ensureTitle(input: {
    session: Session.Info
    history: MessageV2.WithParts[]
    providerID: ProviderID
    modelID: ModelID
  }) {
    if (input.session.parentID) return
    if (!Session.isDefaultTitle(input.session.title)) return

    // Find first non-synthetic user message
    const firstRealUserIdx = input.history.findIndex(
      (m) => m.info.role === "user" && !m.parts.every((p) => "synthetic" in p && p.synthetic),
    )
    if (firstRealUserIdx === -1) return

    const isFirst =
      input.history.filter((m) => m.info.role === "user" && !m.parts.every((p) => "synthetic" in p && p.synthetic))
        .length === 1
    if (!isFirst) return

    // Gather all messages up to and including the first real user message for context
    // This includes any shell/subtask executions that preceded the user's first prompt
    const contextMessages = input.history.slice(0, firstRealUserIdx + 1)
    const firstRealUser = contextMessages[firstRealUserIdx]

    // For subtask-only messages (from command invocations), extract the prompt directly
    // since toModelMessage converts subtask parts to generic "The following tool was executed by the user"
    const subtaskParts = firstRealUser.parts.filter((p) => p.type === "subtask") as MessageV2.SubtaskPart[]
    const hasOnlySubtaskParts = subtaskParts.length > 0 && firstRealUser.parts.every((p) => p.type === "subtask")

    const agent = await Agent.get("title")
    if (!agent) return
    const model = await iife(async () => {
      if (agent.model) return await Provider.getModel(agent.model.providerID, agent.model.modelID)
      return (
        (await Provider.getSmallModel(input.providerID)) ?? (await Provider.getModel(input.providerID, input.modelID))
      )
    })
    const result = await LLM.stream({
      agent,
      user: firstRealUser.info as MessageV2.User,
      system: [],
      small: true,
      tools: {},
      model,
      abort: new AbortController().signal,
      sessionID: input.session.id,
      retries: 2,
      messages: [
        {
          role: "user",
          content: "Generate a title for this conversation:\n",
        },
        ...(hasOnlySubtaskParts
          ? [{ role: "user" as const, content: subtaskParts.map((p) => p.prompt).join("\n") }]
          : MessageV2.toModelMessages(contextMessages, model)),
      ],
    })
    const text = await result.text.catch((err) => log.error("failed to generate title", { error: err }))
    if (text) {
      const cleaned = text
        .replace(/<think>[\s\S]*?<\/think>\s*/g, "")
        .split("\n")
        .map((line) => line.trim())
        .find((line) => line.length > 0)
      if (!cleaned) return

      const title = cleaned.length > 100 ? cleaned.substring(0, 97) + "..." : cleaned
      return Session.setTitle({ sessionID: input.session.id, title })
    }
  }
}
