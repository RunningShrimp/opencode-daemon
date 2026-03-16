import { Storage } from "@/storage/storage"
import { Log } from "@/util/log"
import type { TaskIntent } from "@/ai/thinking/intent"
import { activatePlan, analyzePlanExecution, completePlan, updateTaskStatus } from "@/ai/thinking/planning"
import { buildStructuredTaskPlan, renderStructuredTaskPlan, type StructuredTaskPlan } from "@/ai/thinking/task-planner"
import { QualityGate, type GateDecision } from "./quality-gate"

const log = Log.create({ service: "workflow.orchestrator" })

export type WorkflowPhase =
  | "decompose"
  | "clarify"
  | "discover_tools"
  | "discover_skills"
  | "retrieve"
  | "reason"
  | "execute"
  | "verify"
  | "finalize"

export interface WorkflowState {
  version: 1
  sessionID: string
  intentType: string
  currentPhase: WorkflowPhase
  completedPhases: WorkflowPhase[]
  plan: StructuredTaskPlan
  toolHistory: string[]
  toolSuccessCount: number
  toolFailureCount: number
  evidence: string[]
  latestVerificationVerdict?: "supported" | "contradicted" | "uncertain" | "unknown"
  latestVerificationConfidence?: number
  gateDecision?: GateDecision
  completenessScore?: number
  createdAt: number
  updatedAt: number
}

const cache = new Map<string, WorkflowState>()
const plannerPhases = ["clarify", "inspect", "retrieve", "implement", "verify", "finalize"] as const

type PlannerPhase = (typeof plannerPhases)[number]

function phases(): WorkflowPhase[] {
  return ["decompose", "clarify", "discover_tools", "discover_skills", "retrieve", "reason", "execute", "verify", "finalize"]
}

function key(sessionID: string) {
  return ["workflow", sessionID]
}

function nextPhase(current: WorkflowPhase): WorkflowPhase {
  const list = phases()
  const index = list.indexOf(current)
  return list[Math.min(list.length - 1, index + 1)]
}

export namespace WorkflowOrchestrator {
  async function persist(state: WorkflowState) {
    cache.set(state.sessionID, state)
    await Storage.write(key(state.sessionID), state).catch((error) => {
      log.warn("failed to persist workflow", { sessionID: state.sessionID, error: String(error) })
    })
  }

  export async function initialize(input: { sessionID: string; prompt: string; intent: TaskIntent }) {
    const existing = cache.get(input.sessionID)
    if (existing && existing.plan.goal === input.prompt.trim()) return normalizeState(existing)
    const plan = syncPlanProgress(buildStructuredTaskPlan({ sessionID: input.sessionID, prompt: input.prompt, intent: input.intent }), "decompose")
    const state: WorkflowState = {
      version: 1,
      sessionID: input.sessionID,
      intentType: input.intent.type,
      currentPhase: "decompose",
      completedPhases: [],
      plan,
      toolHistory: [],
      toolSuccessCount: 0,
      toolFailureCount: 0,
      evidence: [],
      latestVerificationVerdict: "unknown",
      createdAt: Date.now(),
      updatedAt: Date.now(),
    }
    await persist(state)
    return state
  }

  export async function get(sessionID: string) {
    const cached = cache.get(sessionID)
    if (cached) return normalizeState(cached)
    const stored = await Storage.read<WorkflowState>(key(sessionID)).catch(() => undefined)
    if (!stored) return undefined
    const normalized = normalizeState(stored)
    cache.set(sessionID, normalized)
    return normalized
  }

  export async function noteTool(sessionID: string, tool: string, options?: { success?: boolean }) {
    const state = await get(sessionID)
    if (!state) return undefined
    const currentPhase = advancePhase(state.currentPhase, tool)
    const completed = state.completedPhases.includes(state.currentPhase)
      ? state.completedPhases
      : [...state.completedPhases, state.currentPhase]
    const toolSuccessCount = options?.success === true ? state.toolSuccessCount + 1 : state.toolSuccessCount
    const toolFailureCount = options?.success === false ? state.toolFailureCount + 1 : state.toolFailureCount
    const next: WorkflowState = {
      ...state,
      plan: syncPlanProgress(state.plan, currentPhase),
      toolHistory: [...state.toolHistory, tool].slice(-30),
      toolSuccessCount,
      toolFailureCount,
      completedPhases: completed as WorkflowPhase[],
      currentPhase,
      updatedAt: Date.now(),
    }
    await persist(next)
    return next
  }

  export async function noteEvidence(sessionID: string, evidence: string[]) {
    const state = await get(sessionID)
    if (!state || evidence.length === 0) return state
    const currentPhase = state.currentPhase === "retrieve" ? ("reason" as WorkflowPhase) : state.currentPhase
    const next: WorkflowState = {
      ...state,
      plan: syncPlanProgress(state.plan, currentPhase),
      evidence: [...new Set([...state.evidence, ...evidence])].slice(-40),
      completedPhases: (state.completedPhases.includes("retrieve") ? state.completedPhases : [...state.completedPhases, "retrieve"]) as WorkflowPhase[],
      currentPhase,
      updatedAt: Date.now(),
    }
    await persist(next)
    return next
  }

  export async function markVerified(sessionID: string, verified: boolean, summary?: string) {
    const state = await get(sessionID)
    if (!state) return undefined
    const currentPhase = verified ? "finalize" : "reason"
    const completed = [...new Set([...state.completedPhases, "verify" as WorkflowPhase])] as WorkflowPhase[]
    const evidence = summary ? [...state.evidence, summary].slice(-40) : state.evidence
    const partialState: WorkflowState = { ...state, completedPhases: completed, evidence }
    const completenessScore = computeCompleteness(partialState, verified)
    const latestVerificationVerdict = deriveVerificationVerdict(summary, verified)
    const latestVerificationConfidence = deriveVerificationConfidence(summary)
    const gateDecision = new QualityGate().check({
      completenessScore,
      findings: buildFindings(partialState, verified),
      toolSuccessRatio: computeToolSuccessRatio(partialState),
      evidenceDensity: computeEvidenceDensity(partialState),
      verificationVerdict: latestVerificationVerdict,
    })
    const next: WorkflowState = {
      ...state,
      plan: syncPlanProgress(state.plan, currentPhase as WorkflowPhase),
      completedPhases: completed as WorkflowPhase[],
      currentPhase: currentPhase as WorkflowPhase,
      evidence,
      latestVerificationVerdict,
      latestVerificationConfidence,
      gateDecision,
      completenessScore,
      updatedAt: Date.now(),
    }
    await persist(next)
    return next
  }

  export async function complete(sessionID: string) {
    const state = await get(sessionID)
    if (!state) return undefined
    const dagBlockers = collectDependencyBlockers(state.plan.plan)
    const dependencyReady = dagBlockers.length === 0
    const completedPhases = dependencyReady
      ? [...new Set([...state.completedPhases, "finalize" as WorkflowPhase])] as WorkflowPhase[]
      : state.completedPhases
    const partialState: WorkflowState = { ...state, completedPhases }
    const completenessScore = computeCompleteness(partialState, true)
    const findings = buildFindings(partialState, true)
    if (!dependencyReady) {
      findings.push({
        severity: "critical",
        message: `Task dependency graph still blocked (${dagBlockers.length} unresolved dependency edge(s))`,
      })
    }

    const qualityDecision = new QualityGate().check({
      completenessScore,
      findings,
      toolSuccessRatio: computeToolSuccessRatio(partialState),
      evidenceDensity: computeEvidenceDensity(partialState),
      verificationVerdict: partialState.latestVerificationVerdict,
    })
    const gateDecision = !dependencyReady
      ? {
          pass: false,
          status: "rejected" as const,
          reason: "Cannot finalize: unresolved task dependencies remain",
          suggestions: dagBlockers,
          nextAction: "address_findings" as const,
          qualityScore: completenessScore,
        }
      : qualityDecision

    const canFinalize = dependencyReady && gateDecision.pass
    const requiresManualReview = dependencyReady && gateDecision.status === "manual_review"
    const manualReviewCollectEvidence = requiresManualReview && gateDecision.nextAction === "collect_evidence"

    const nextPhase: WorkflowPhase = canFinalize
      ? "finalize"
      : manualReviewCollectEvidence
        ? "reason"
        : "verify"

    const nextPlan = canFinalize
      ? syncPlanProgress(state.plan, "finalize", true)
      : syncPlanProgress(state.plan, nextPhase)

    const next: WorkflowState = {
      ...state,
      plan: nextPlan,
      currentPhase: nextPhase,
      completedPhases,
      gateDecision,
      completenessScore,
      updatedAt: Date.now(),
    }
    await persist(next)
    return next
  }

  export function renderSystemContext(state: WorkflowState) {
    const execution = analyzePlanExecution(state.plan.plan)
    const lines = [
      "<workflow_state>",
      `Current phase: ${state.currentPhase}`,
      `Completed phases: ${state.completedPhases.join(", ") || "none"}`,
      `Recent tools: ${state.toolHistory.slice(-5).join(", ") || "none"}`,
      renderStructuredTaskPlan(state.plan),
    ]
    if (execution.readyTasks.length > 0) {
      lines.push("Next ready tasks:")
      for (const task of execution.readyTasks.slice(0, 3)) lines.push(`- ${task.description}`)
    }
    const allPlanTasks = state.plan.plan.steps.flatMap((step) => step.tasks)
    const blockedTasks = allPlanTasks.filter(
      (task) => task.status === "pending" && !execution.readyTasks.some((r) => r.id === task.id),
    )
    if (blockedTasks.length > 0) {
      lines.push("Blocked tasks (dependencies not yet met — do not start these):")
      for (const task of blockedTasks.slice(0, 3)) {
        const deps = task.dependencies.slice(0, 2).join(", ")
        lines.push(`- ${task.description}${deps ? ` [awaiting: ${deps}]` : ""}`)
      }
    }
    if (execution.stalled) {
      lines.push("Plan blockers:")
      for (const reason of execution.reasons.slice(0, 4)) lines.push(`- ${reason}`)
    }
    if (state.gateDecision && !state.gateDecision.pass) {
      if (state.gateDecision.status === "manual_review") {
        lines.push(`Quality gate: MANUAL REVIEW — ${state.gateDecision.reason ?? "requires additional evidence"}`)
        if (state.gateDecision.nextAction) {
          lines.push(`Next action: ${state.gateDecision.nextAction}`)
        }
      } else {
        lines.push(`Quality gate: FAILED — ${state.gateDecision.reason ?? "quality threshold not met"}`)
      }
      if (state.completenessScore !== undefined) {
        lines.push(`Completeness score: ${state.completenessScore}/100 (threshold: 60)`)
      }
    }
    if (state.evidence.length > 0) {
      lines.push("Recent evidence:")
      for (const item of state.evidence.slice(-5)) lines.push(`- ${item}`)
    }
    lines.push("</workflow_state>")
    return lines.join("\n")
  }

  export function resetForTest() {
    cache.clear()
  }

  /**
   * Code-level DAG enforcement: returns whether `taskId` is cleared to run.
   * A task is runnable only when ALL its declared dependency task-IDs appear in
   * the set of completed task nodes for the session's current plan.
   *
   * Returns `{ allowed: true }` when the task may proceed.
   * Returns `{ allowed: false, blockedBy: string[] }` listing the unsatisfied deps.
   */
  export async function canRunTask(
    sessionID: string,
    taskId: string,
  ): Promise<{ allowed: true } | { allowed: false; blockedBy: string[] }> {
    const state = await get(sessionID)
    if (!state) return { allowed: true } // No plan — don't block

    const allTasks = state.plan.plan.steps.flatMap((step) => step.tasks)
    const target = allTasks.find((t) => t.id === taskId)
    if (!target) return { allowed: true } // Unknown task — don't block

    const completedIds = new Set(
      allTasks.filter((t) => t.status === "completed").map((t) => t.id),
    )

    const blockedBy = (target.dependencies ?? []).filter((dep) => !completedIds.has(dep))
    if (blockedBy.length === 0) return { allowed: true }
    return { allowed: false, blockedBy }
  }
}

function syncPlanProgress(plan: StructuredTaskPlan, workflowPhase: WorkflowPhase, finalize = false): StructuredTaskPlan {
  let nextPlan = plan.plan.status === "draft" ? activatePlan(plan.plan) : plan.plan
  const completed = completedPlannerPhases(workflowPhase)
  const active = finalize ? undefined : nextPlannerPhase(plan, completed)

  for (const task of plan.taskGraph) {
    const status = finalize || completed.has(task.phase)
      ? "completed"
      : task.phase === active
        ? "in_progress"
        : "pending"
    nextPlan = updateTaskStatus(nextPlan, task.id, status)
  }

  if (finalize) {
    nextPlan = completePlan(nextPlan)
  }

  return {
    ...plan,
    plan: nextPlan,
  }
}

function nextPlannerPhase(plan: StructuredTaskPlan, completed: Set<PlannerPhase>) {
  const phasesInPlan = new Set(plan.taskGraph.map((task) => task.phase))
  return plannerPhases.find((phase) => phasesInPlan.has(phase) && !completed.has(phase))
}

function completedPlannerPhases(workflowPhase: WorkflowPhase) {
  switch (workflowPhase) {
    case "discover_tools":
    case "discover_skills":
      return new Set<PlannerPhase>(["clarify"])
    case "retrieve":
      return new Set<PlannerPhase>(["clarify", "inspect"])
    case "reason":
      return new Set<PlannerPhase>(["clarify", "inspect"])
    case "execute":
      return new Set<PlannerPhase>(["clarify", "inspect", "retrieve"])
    case "verify":
      return new Set<PlannerPhase>(["clarify", "inspect", "retrieve", "implement"])
    case "finalize":
      return new Set<PlannerPhase>(["clarify", "inspect", "retrieve", "implement", "verify"])
    default:
      return new Set<PlannerPhase>()
  }
}

function advancePhase(current: WorkflowPhase, tool: string): WorkflowPhase {
  if (["read", "grep", "glob", "webfetch", "websearch", "codesearch", "rag_query"].includes(tool)) {
    if (["decompose", "clarify", "discover_tools", "discover_skills", "retrieve"].includes(current)) return "reason"
  }
  if (["edit", "write", "apply_patch", "bash", "task"].includes(tool)) return "verify"
  if (tool === "skill") return "retrieve"
  return nextPhase(current)
}

function computeCompleteness(
  state: Pick<WorkflowState, "completedPhases" | "evidence" | "toolHistory" | "toolSuccessCount" | "toolFailureCount" | "latestVerificationVerdict" | "plan">,
  verified: boolean,
): number {
  const all = phases()
  const phaseScore = (state.completedPhases.length / all.length) * 40
  const evidenceScore = Math.min(22, computeEvidenceDensity(state) * 22)
  const activityScore = Math.min(10, state.toolHistory.length * 1.2)
  const reliabilityScore = computeToolSuccessRatio(state) * 18
  const verificationScore = verificationScoreWeight(state.latestVerificationVerdict, verified)
  return Math.round(Math.min(100, phaseScore + evidenceScore + activityScore + reliabilityScore + verificationScore))
}

function buildFindings(state: Pick<WorkflowState, "completedPhases" | "evidence" | "toolSuccessCount" | "toolFailureCount" | "plan">, verified: boolean): Array<{ severity: string; message?: string }> {
  const findings: Array<{ severity: string; message: string }> = []
  if (!state.completedPhases.includes("verify")) {
    findings.push({ severity: "critical", message: "Verification phase not completed" })
  }
  if (state.evidence.length === 0) {
    findings.push({ severity: "error", message: "No evidence collected during session" })
  }
  const totalToolCalls = state.toolSuccessCount + state.toolFailureCount
  if (totalToolCalls >= 4 && computeToolSuccessRatio(state) < 0.5) {
    findings.push({ severity: "error", message: "Tool reliability is too low; stabilize execution before finalizing" })
  }
  if (computeEvidenceDensity(state) < 0.2) {
    findings.push({ severity: "error", message: "Evidence density is low for current task graph coverage" })
  }
  if (!verified) {
    findings.push({ severity: "error", message: "Latest verification verdict was not supported" })
  }
  return findings
}

function collectDependencyBlockers(plan: StructuredTaskPlan["plan"]): string[] {
  const tasks = plan.steps.flatMap((step) => step.tasks)
  const byID = new Map(tasks.map((task) => [task.id, task]))
  const blockers: string[] = []

  for (const task of tasks) {
    if (task.status === "completed") continue
    const unmet = task.dependencies.filter((depID) => byID.get(depID)?.status !== "completed")
    if (unmet.length === 0) continue
    blockers.push(`Task \"${task.description}\" blocked by: ${unmet.join(", ")}`)
  }

  return [...new Set(blockers)]
}

function computeToolSuccessRatio(state: Pick<WorkflowState, "toolSuccessCount" | "toolFailureCount">): number {
  const total = state.toolSuccessCount + state.toolFailureCount
  if (total === 0) return 0.5
  return state.toolSuccessCount / total
}

function computeEvidenceDensity(state: Pick<WorkflowState, "evidence" | "plan">): number {
  const taskCount = Math.max(1, state.plan.plan.steps.flatMap((step) => step.tasks).length)
  return Math.min(1, state.evidence.length / taskCount)
}

function deriveVerificationVerdict(summary: string | undefined, verified: boolean): WorkflowState["latestVerificationVerdict"] {
  const normalized = summary?.toLowerCase() ?? ""
  if (normalized.includes("uncertain")) return "uncertain"
  if (normalized.includes("contradicted")) return "contradicted"
  if (normalized.includes("supported")) return "supported"
  return verified ? "supported" : "contradicted"
}

function deriveVerificationConfidence(summary?: string) {
  if (!summary) return undefined
  const match = /\((\d+(?:\.\d+)?)\)/.exec(summary)
  if (!match) return undefined
  const parsed = Number.parseFloat(match[1])
  if (!Number.isFinite(parsed)) return undefined
  return parsed
}

function verificationScoreWeight(verdict: WorkflowState["latestVerificationVerdict"], verified: boolean) {
  if (verdict === "supported") return 10
  if (verdict === "uncertain") return 4
  if (verdict === "contradicted") return 0
  return verified ? 8 : 0
}

function normalizeState(state: WorkflowState): WorkflowState {
  return {
    ...state,
    toolSuccessCount: state.toolSuccessCount ?? 0,
    toolFailureCount: state.toolFailureCount ?? 0,
    latestVerificationVerdict: state.latestVerificationVerdict ?? "unknown",
  }
}