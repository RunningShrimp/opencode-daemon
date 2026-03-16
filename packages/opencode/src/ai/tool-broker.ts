import type { Agent } from "@/agent/agent"
import type { TaskIntent } from "@/ai/thinking/intent"
import { Storage } from "@/storage/storage"

export interface ToolDescriptor {
  id: string
  description: string
  source: "builtin" | "mcp" | "skill" | "subagent" | "retrieval" | "web"
  category?: string
  available?: boolean
  historicalSuccess?: number
  recentReliability?: number
  averageLatencyMs?: number
  sampleSize?: number
  lastSuccessAt?: number
  lastFailureAt?: number
  tags?: string[]
  preferredTaskTypes?: string[]
}

interface ToolMetrics {
  tool: string
  source: ToolDescriptor["source"]
  category?: string
  successCount: number
  failureCount: number
  totalLatencyMs: number
  lastLatencyMs?: number
  lastUsedAt: number
  lastSuccessAt?: number
  lastFailureAt?: number
}

interface ToolBrokerSnapshot {
  projectID: string
  tools: Record<string, ToolMetrics>
}

export interface ToolBrokerDecision {
  ranked: string[]
  recommended: string[]
  discouraged: string[]
  guidance?: string
  scores: Record<string, number>
}

const INTENT_TOOL_HINTS: Record<string, string[]> = {
  review: ["read", "grep", "glob", "codesearch", "rag_query"],
  debugging: ["read", "grep", "bash", "rag_query", "lsp"],
  implementation: ["read", "grep", "edit", "write", "apply_patch", "todowrite"],
  exploration: ["read", "grep", "glob", "webfetch", "websearch", "rag_query"],
}

const SOURCE_BONUS: Record<ToolDescriptor["source"], Record<string, number>> = {
  builtin: { implementation: 0.5, debugging: 0.3, review: 0.2, exploration: 0.1 },
  mcp: { implementation: 0.15, debugging: 0.15, review: 0.2, exploration: 0.35 },
  skill: { implementation: 0.2, debugging: 0.15, review: 0.2, exploration: 0.25 },
  subagent: { implementation: 0.2, debugging: 0.2, review: 0.1, exploration: 0.15 },
  retrieval: { implementation: 0.25, debugging: 0.3, review: 0.25, exploration: 0.35 },
  web: { implementation: 0.05, debugging: 0.1, review: 0.1, exploration: 0.3 },
}

const CATEGORY_BONUS: Record<string, Partial<Record<TaskIntent["type"], number>>> = {
  editing: { implementation: 0.9, debugging: 0.5 },
  retrieval: { implementation: 0.4, debugging: 0.6, review: 0.7, exploration: 0.8 },
  execution: { implementation: 0.5, debugging: 0.6 },
  planning: { implementation: 0.2, debugging: 0.1, exploration: 0.1 },
  delegation: { implementation: 0.25, debugging: 0.25, review: 0.1, exploration: 0.15 },
  documentation: { implementation: 0.4, exploration: 0.3 },
  search: { review: 0.3, exploration: 0.5, debugging: 0.3 },
}

const cache = new Map<string, ToolBrokerSnapshot>()

function textScore(task: string, descriptor: ToolDescriptor) {
  const taskTerms = tokenize(task)
  const haystack = tokenize(
    `${descriptor.id} ${descriptor.description} ${descriptor.category ?? ""} ${(descriptor.tags ?? []).join(" ")} ${(descriptor.preferredTaskTypes ?? []).join(" ")}`,
  )
  if (taskTerms.length === 0 || haystack.length === 0) return 0
  let matches = 0
  for (const term of taskTerms) {
    if (haystack.some((candidate) => candidate.includes(term) || term.includes(candidate))) matches += 1
  }
  return matches / taskTerms.length
}

function tokenize(text: string) {
  return text.toLowerCase().split(/[^a-z0-9_\u4e00-\u9fff]+/g).filter((item) => item.length > 1)
}

function inferSource(descriptor: ToolDescriptor): ToolDescriptor["source"] {
  if (descriptor.id === "skill") return "skill"
  if (descriptor.id === "task") return "subagent"
  if (["rag_query", "codesearch", "grep", "glob", "read"].includes(descriptor.id)) return "retrieval"
  if (["webfetch", "websearch"].includes(descriptor.id)) return "web"
  return descriptor.source
}

function key(projectID: string) {
  return ["tool_broker", projectID]
}

function inferCategory(descriptor: ToolDescriptor) {
  if (descriptor.category) return descriptor.category
  if (["read", "grep", "glob", "codesearch", "rag_query", "rag_index"].includes(descriptor.id)) return "retrieval"
  if (["websearch", "webfetch"].includes(descriptor.id)) return "search"
  if (["edit", "write", "apply_patch"].includes(descriptor.id)) return "editing"
  if (["bash", "lsp"].includes(descriptor.id)) return "execution"
  if (["todowrite", "todoread"].includes(descriptor.id)) return "documentation"
  if (descriptor.id === "task") return "delegation"
  if (descriptor.id === "skill") return "planning"
  return descriptor.source === "mcp" ? "integration" : "general"
}

function metricsToDescriptor(metrics: ToolMetrics) {
  const total = metrics.successCount + metrics.failureCount
  const historicalSuccess = total > 0 ? (metrics.successCount + 1.5) / (total + 2.5) : undefined
  const recentReliability = total > 0 ? computeRecentReliability(metrics) : undefined
  return {
    historicalSuccess,
    recentReliability,
    averageLatencyMs: total > 0 ? metrics.totalLatencyMs / total : undefined,
    sampleSize: total,
    category: metrics.category,
    lastSuccessAt: metrics.lastSuccessAt,
    lastFailureAt: metrics.lastFailureAt,
  }
}

function computeRecentReliability(metrics: ToolMetrics) {
  const total = metrics.successCount + metrics.failureCount
  const baseline = (metrics.successCount + 1) / (total + 2)
  const now = Date.now()
  const lastFailureAt = metrics.lastFailureAt ?? 0
  const lastSuccessAt = metrics.lastSuccessAt ?? 0

  if (lastFailureAt > lastSuccessAt) {
    const ageMs = Math.max(0, now - lastFailureAt)
    const penalty = ageMs < 15 * 60_000 ? 0.3 : ageMs < 2 * 60 * 60_000 ? 0.18 : ageMs < 12 * 60 * 60_000 ? 0.08 : 0
    return Math.max(0.05, baseline - penalty)
  }

  if (lastSuccessAt > lastFailureAt && lastSuccessAt > 0) {
    return Math.min(0.98, baseline + 0.05)
  }

  return baseline
}

async function read(projectID: string) {
  const cached = cache.get(projectID)
  if (cached) return cached
  const stored = await Storage.read<ToolBrokerSnapshot>(key(projectID)).catch(() => undefined)
  const snapshot =
    stored ??
    ({
      projectID,
      tools: {},
    } satisfies ToolBrokerSnapshot)
  cache.set(projectID, snapshot)
  return snapshot
}

async function persist(snapshot: ToolBrokerSnapshot) {
  cache.set(snapshot.projectID, snapshot)
  await Storage.write(key(snapshot.projectID), snapshot).catch(() => undefined)
}

function scoreDescriptor(input: {
  task: string
  descriptor: ToolDescriptor
  intent: TaskIntent
}) {
  const descriptor = { ...input.descriptor, source: inferSource(input.descriptor) }
  const preferred = INTENT_TOOL_HINTS[input.intent.type] ?? []
  const sampleSize = descriptor.sampleSize ?? 0
  const reliability = descriptor.recentReliability ?? descriptor.historicalSuccess ?? 0.7
  const historyWeight = 0.35 + Math.min(1, sampleSize / 6) * 0.65
  let score = preferred.includes(descriptor.id) ? 5 : 0
  score += textScore(input.task, descriptor) * 3
  score += SOURCE_BONUS[descriptor.source][input.intent.type] ?? 0
  score += CATEGORY_BONUS[inferCategory(descriptor)]?.[input.intent.type] ?? 0
  score += (reliability - 0.65) * 2.5 * historyWeight
  if (descriptor.averageLatencyMs) {
    score -= Math.min(1.5, descriptor.averageLatencyMs / 5_000) * historyWeight
  }
  if (descriptor.preferredTaskTypes?.includes(input.intent.type)) {
    score += 0.75
  }
  if (descriptor.lastFailureAt && (!descriptor.lastSuccessAt || descriptor.lastFailureAt > descriptor.lastSuccessAt)) {
    const ageMs = Date.now() - descriptor.lastFailureAt
    if (ageMs < 15 * 60_000) score -= 1.25
    else if (ageMs < 2 * 60 * 60_000) score -= 0.6
  }
  if (descriptor.available === false) {
    score -= 10
  }
  if (descriptor.id === "task" && input.intent.type === "exploration") {
    score -= 1.5
  }
  if (descriptor.id === "websearch" && /workspace|repo|project|code/i.test(input.task)) {
    score -= 1.5
  }
  if (["todoread", "todowrite"].includes(descriptor.id) && input.intent.type === "implementation") {
    score += 0.8
  }
  return score
}

export namespace ToolBroker {
  export async function enrichDescriptors(input: { projectID: string; tools: ToolDescriptor[] }) {
    const snapshot = await read(input.projectID)
    return input.tools.map((descriptor) => {
      const metrics = snapshot.tools[descriptor.id]
      const derived = metrics ? metricsToDescriptor(metrics) : undefined
      return {
        ...descriptor,
        ...derived,
        source: inferSource(descriptor),
        category: descriptor.category ?? derived?.category ?? inferCategory(descriptor),
      }
    })
  }

  export async function recordToolOutcome(input: {
    projectID: string
    tool: string
    source: ToolDescriptor["source"]
    category?: string
    success: boolean
    durationMs: number
  }) {
    const snapshot = await read(input.projectID)
    const existing = snapshot.tools[input.tool]
    const next: ToolMetrics = {
      tool: input.tool,
      source: input.source,
      category: input.category ?? existing?.category ?? inferCategory({
        id: input.tool,
        description: "",
        source: input.source,
      }),
      successCount: (existing?.successCount ?? 0) + (input.success ? 1 : 0),
      failureCount: (existing?.failureCount ?? 0) + (input.success ? 0 : 1),
      totalLatencyMs: (existing?.totalLatencyMs ?? 0) + Math.max(0, input.durationMs),
      lastLatencyMs: Math.max(0, input.durationMs),
      lastUsedAt: Date.now(),
      lastSuccessAt: input.success ? Date.now() : existing?.lastSuccessAt,
      lastFailureAt: input.success ? existing?.lastFailureAt : Date.now(),
    }
    const updated: ToolBrokerSnapshot = {
      ...snapshot,
      tools: {
        ...snapshot.tools,
        [input.tool]: next,
      },
    }
    await persist(updated)
  }

  export function decide(input: { intent: TaskIntent; agent: Agent.Info; tools: ToolDescriptor[]; currentTask?: string }): ToolBrokerDecision {
    const task = input.currentTask ?? ""
    const scored = input.tools
      .map((descriptor) => ({
        descriptor,
        score: scoreDescriptor({ task, descriptor, intent: input.intent }),
      }))
      .sort(
        (a, b) =>
          b.score - a.score ||
          (b.descriptor.sampleSize ?? 0) - (a.descriptor.sampleSize ?? 0) ||
          a.descriptor.id.localeCompare(b.descriptor.id),
      )

    const ranked = scored.map((item) => item.descriptor.id)
    const recommended = scored.filter((item) => item.score >= 3).slice(0, 6).map((item) => item.descriptor.id)
    const discouraged = input.tools.map((tool) => tool.id).filter((tool) => {
      if (tool === "task") return input.intent.type === "exploration"
      if (tool === "websearch") return /workspace|repo|project|code/i.test(task)
      return false
    })

    const guidance = recommended.length
      ? `Prefer these tools first for this ${input.intent.type} turn: ${recommended.join(", ")}.`
      : undefined

    return {
      ranked,
      recommended,
      discouraged,
      guidance,
      scores: Object.fromEntries(scored.map((item) => [item.descriptor.id, Number(item.score.toFixed(3))])),
    }
  }

  export function sortTools<T extends { id: string }>(tools: T[], decision: ToolBrokerDecision) {
    const order = new Map(decision.ranked.map((id, index) => [id, index]))
    return [...tools].sort((a, b) => (order.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (order.get(b.id) ?? Number.MAX_SAFE_INTEGER))
  }

  export function renderPromptContext(decision: ToolBrokerDecision) {
    if (decision.recommended.length === 0 && decision.discouraged.length === 0 && !decision.guidance) return undefined
    const lines = ["<tool_broker>"]
    if (decision.guidance) lines.push(decision.guidance)
    if (decision.recommended.length > 0) lines.push(`Recommended: ${decision.recommended.join(", ")}`)
    if (decision.discouraged.length > 0) lines.push(`Discouraged: ${decision.discouraged.join(", ")}`)
    const top = decision.ranked.slice(0, 5)
    if (top.length > 0) {
      lines.push(`Ranked: ${top.map((id) => `${id}(${decision.scores[id] ?? 0})`).join(", ")}`)
    }
    lines.push("</tool_broker>")
    return lines.join("\n")
  }

  export function resetForTest() {
    cache.clear()
  }
}