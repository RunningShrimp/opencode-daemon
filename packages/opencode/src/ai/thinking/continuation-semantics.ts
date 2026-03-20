import { embeddingService } from "@/ai/rag/embedding"

export interface SemanticContinuationSegment {
  label: "next_step" | "remaining_work"
  text: string
  continuationScore: number
  stopScore: number
  actionabilityScore: number
}

export interface SemanticContinuationAnalysis {
  carryoverSegments: SemanticContinuationSegment[]
  explicitStop: boolean
  rolloverHandoff: boolean
}

const MAX_CARRYOVER_SEGMENTS = 4
const MIN_SEGMENT_LENGTH = 6
const CONTINUATION_SCORE_THRESHOLD = 0.26
const ACTIONABILITY_SCORE_THRESHOLD = 0.18
const STOP_MARGIN = 0.03
const SUMMARY_MARGIN = 0.02
const EXPLICIT_STOP_THRESHOLD = 0.36

const AUTONOMOUS_WRAP_UP_MARKERS = [
  "summary of work completed",
  "work completed summary",
  "summary of work accomplished",
  "accomplished tasks",
] as const

const AUTONOMOUS_HANDOFF_MARKERS = ["remaining tasks", "exact next step", "recommendations"] as const

const EXPLICIT_CONTINUATION_MARKERS = [
  /\bnext\s+round\s+action\b/i,
  /\bnext(?:\s+round|\s+action|\s+step)?\s*[:：]/i,
  /\bfollow-up\s+action\s*[:：]/i,
  /\bimmediate\s+next\s+step\s*[:：]/i,
  /\bexact\s+next\s+(?:step|action)\b/i,
  /下一步\s*[:：]/u,
  /接下来\s*[:：]/u,
  /剩余任务\s*[:：]/u,
  /待办事项\s*[:：]/u,
] as const

const EXPLICIT_STOP_MARKERS = [
  /\ball\s+done\b/i,
  /\ball\s+work\s+is\s+complete\b/i,
  /\beverything\s+is\s+finished\b/i,
  /\btask\s+completed\b/i,
  /\btask\s+complete\b/i,
  /\breport\s+(?:is\s+)?complete\b/i,
  /\breport\s+delivered\b/i,
  /\baudit\s+report\s+complete\b/i,
  /\bno\s+further\s+action\s+(?:is\s+)?required\b/i,
  /\bno\s+further\s+action\s+needed\b/i,
  /\bwait\s+for\s+user\s+input\b/i,
  /\bawait\s+user\s+input\b/i,
  /\bunless\s+the\s+user\s+requests\b/i,
  /\bunless\s+user\s+requests\b/i,
  /所有工作都已完成/u,
  /无需继续/u,
  /没有下一步/u,
  /没有剩余任务/u,
  /等待用户/u,
] as const

const SEMANTIC_PROTOTYPES = {
  next_step: [
    "Next step: continue this work in the next autonomous round.",
    "Follow-up action: execute this concrete next step immediately.",
    "Immediate next step: keep implementing and verifying the remaining work.",
    "下一步：在下一轮继续执行这个具体动作。",
    "接下来：立即推进这个明确的后续步骤。",
    "下一步：补充回归测试并继续实施。",
  ],
  remaining_work: [
    "Remaining tasks: there is still unfinished work that should continue next round.",
    "Unfinished work items still need implementation or verification.",
    "Carry these remaining tasks into the next autonomous round.",
    "剩余任务：这些未完成工作需要在下一轮继续处理。",
    "未完成任务：后续还要继续实施和验证。",
    "剩余任务：重新构建二进制并检查日志。",
    "剩余任务：继续完成后续实施并验证结果。",
    "待办事项：还有工作没有做完，需要下一轮继续。",
  ],
  actionable: [
    "This paragraph gives a concrete next step.",
    "This paragraph lists remaining tasks that should be executed next.",
    "This text tells the agent what to continue doing next.",
    "Remaining tasks: rebuild the binary and verify the logs next.",
    "这段内容给出了明确的下一步动作。",
    "这段文字列出了接下来要继续完成的任务。",
    "这段话说明了下一轮要继续做什么。",
    "剩余任务：重新构建二进制并检查日志。",
    "待办事项：继续执行这些后续任务。",
  ],
  stop: [
    "All work is complete and no further autonomous action is required.",
    "There is no next step, no remaining task, and the autonomous loop should stop.",
    "Everything is finished and the agent should stop instead of continuing.",
    "No next step. No remaining tasks. Stop autonomous continuation.",
    "所有工作都已完成，不需要继续自主执行。",
    "没有下一步，也没有剩余任务，自驱动应当停止。",
    "已经全部完成，无需继续执行后续任务。",
    "没有下一步。没有剩余任务。停止继续执行。",
  ],
  summary_only: [
    "This text is only a progress summary and does not assign another task.",
    "This paragraph reports status but does not describe a concrete next action.",
    "Completed work summary: this describes what was already finished.",
    "Implemented the parser.",
    "Completed the main fix.",
    "This round finished the main implementation work.",
    "这段内容只是进度总结，没有给出新的执行任务。",
    "这是状态汇报，不包含明确的下一步动作。",
    "本轮已完成主要修复，这只是已完成内容的总结。",
    "本轮已完成主要修复。",
    "已经完成当前修复工作。",
  ],
} as const

type PrototypeGroup = keyof typeof SEMANTIC_PROTOTYPES

const prototypeEmbeddingCache = new Map<PrototypeGroup, Promise<number[][]>>()

function cosineSim(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  return normA > 0 && normB > 0 ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 0
}

function dedupeSegments(values: string[]) {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values.map((item) => item.trim()).filter(Boolean)) {
    if (value.length < MIN_SEGMENT_LENGTH) continue
    if (seen.has(value)) continue
    seen.add(value)
    result.push(value)
  }
  return result
}

function collectCandidateGroups(text: string) {
  const paragraphs = dedupeSegments(
    text
      .split(/\n\s*\n+/)
      .map((paragraph) => paragraph.trim()),
  )
  const lines = dedupeSegments(
    text
      .split("\n")
      .map((line) => line.trim()),
  )
  const sentences = dedupeSegments(
    text
      .split(/(?<=[。！？.!?])\s+/u)
      .map((sentence) => sentence.trim()),
  )

  return [paragraphs, lines, sentences]
}

function maxSimilarity(vector: number[], targets: number[][]) {
  let best = -1
  for (const target of targets) {
    best = Math.max(best, cosineSim(vector, target))
  }
  return best < 0 ? 0 : best
}

function getPrototypeEmbeddings(group: PrototypeGroup) {
  const cached = prototypeEmbeddingCache.get(group)
  if (cached) return cached

  const next = embeddingService.getBatchEmbeddings(
    SEMANTIC_PROTOTYPES[group].map((content) => ({ content, modality: "text" as const })),
  )
  prototypeEmbeddingCache.set(group, next)
  return next
}

function isCarryoverSegment(input: {
  continuationScore: number
  actionabilityScore: number
  stopScore: number
  summaryScore: number
}) {
  return (
    input.continuationScore >= CONTINUATION_SCORE_THRESHOLD &&
    input.actionabilityScore >= ACTIONABILITY_SCORE_THRESHOLD &&
    input.continuationScore > input.stopScore + STOP_MARGIN &&
    input.continuationScore > input.summaryScore + SUMMARY_MARGIN &&
    input.actionabilityScore > input.summaryScore + SUMMARY_MARGIN
  )
}

function looksLikeAutonomousHandoffSummary(text: string) {
  const normalized = text.toLowerCase()
  return (
    AUTONOMOUS_WRAP_UP_MARKERS.some((marker) => normalized.includes(marker)) &&
    AUTONOMOUS_HANDOFF_MARKERS.some((marker) => normalized.includes(marker))
  )
}

function looksLikeExplicitAutonomousStop(text: string) {
  const hasContinuationMarker = EXPLICIT_CONTINUATION_MARKERS.some((pattern) => pattern.test(text))
  if (hasContinuationMarker) return false
  return EXPLICIT_STOP_MARKERS.some((pattern) => pattern.test(text))
}

function extractExplicitContinuationSegments(text: string): SemanticContinuationSegment[] {
  const patterns: Array<{ label: SemanticContinuationSegment["label"]; pattern: RegExp }> = [
    {
      label: "next_step",
      pattern:
        /(?:^|.*?\b)(next\s+round\s+action\s*[:：]\s*[\s\S]+|next(?:\s+round|\s+action|\s+step)?\s*[:：]\s*[\s\S]+|follow-up\s+action\s*[:：]\s*[\s\S]+|immediate\s+next\s+step\s*[:：]\s*[\s\S]+|(?:the\s+)?exact\s+next\s+(?:step|action)(?:\s+if\s+autonomous\s+work\s+should\s+continue\s+in\s+the\s+next\s+round)?\s*[:：]\s*[\s\S]+)$/i,
    },
    {
      label: "next_step",
      pattern: /(?:^|.*?)(下一步\s*[:：]\s*[\s\S]+|接下来\s*[:：]\s*[\s\S]+)$/u,
    },
    {
      label: "remaining_work",
      pattern:
        /(?:^|.*?\b)(remaining\s+tasks?(?:\s+that\s+were\s+not\s+completed)?\s*[:：]\s*[\s\S]+|unfinished\s+work(?:\s+items)?\s*[:：]\s*[\s\S]+|remaining\s+items\s*[:：]\s*[\s\S]+)$/i,
    },
    {
      label: "remaining_work",
      pattern: /(?:^|.*?)(剩余任务\s*[:：]\s*[\s\S]+|待办事项\s*[:：]\s*[\s\S]+)$/u,
    },
  ]

  const candidates = dedupeSegments(
    [
      ...text.split(/\n\s*\n+/).map((paragraph) => paragraph.trim()),
      ...text.split("\n").map((line) => line.trim()),
    ],
  )

  const segments: SemanticContinuationSegment[] = []
  const seen = new Set<string>()

  for (const candidate of candidates) {
    for (const { label, pattern } of patterns) {
      const match = candidate.match(pattern)
      const extracted = match?.[1]?.trim()
      if (!extracted || seen.has(extracted)) continue
      seen.add(extracted)
      segments.push({
        label,
        text: extracted,
        continuationScore: 1,
        stopScore: 0,
        actionabilityScore: 1,
      })
      break
    }
  }

  return segments.slice(0, MAX_CARRYOVER_SEGMENTS)
}

export async function analyzeSemanticContinuation(text?: string): Promise<SemanticContinuationAnalysis> {
  const latestAssistant = text?.trim()
  if (!latestAssistant) {
    return {
      carryoverSegments: [],
      explicitStop: false,
      rolloverHandoff: false,
    }
  }

  const rolloverHandoff = looksLikeAutonomousHandoffSummary(latestAssistant)
  if (rolloverHandoff) {
    return {
      carryoverSegments: [],
      explicitStop: false,
      rolloverHandoff: true,
    }
  }

  if (looksLikeExplicitAutonomousStop(latestAssistant)) {
    return {
      carryoverSegments: [],
      explicitStop: true,
      rolloverHandoff: false,
    }
  }

  const explicitCarryoverSegments = extractExplicitContinuationSegments(latestAssistant)
  if (explicitCarryoverSegments.length > 0) {
    return {
      carryoverSegments: explicitCarryoverSegments,
      explicitStop: false,
      rolloverHandoff: false,
    }
  }

  const candidateGroups = collectCandidateGroups(latestAssistant).filter((group) => group.length > 0)
  if (candidateGroups.length === 0) {
    return {
      carryoverSegments: [],
      explicitStop: false,
      rolloverHandoff: false,
    }
  }

  const [messageEmbedding, nextStepEmbeddings, remainingWorkEmbeddings, actionableEmbeddings, stopEmbeddings, summaryEmbeddings] =
    await Promise.all([
      embeddingService.getEmbedding({ content: latestAssistant, modality: "text" as const }),
      getPrototypeEmbeddings("next_step"),
      getPrototypeEmbeddings("remaining_work"),
      getPrototypeEmbeddings("actionable"),
      getPrototypeEmbeddings("stop"),
      getPrototypeEmbeddings("summary_only"),
    ])

  let segments: SemanticContinuationSegment[] = []
  for (const candidates of candidateGroups) {
    const candidateEmbeddings = await embeddingService.getBatchEmbeddings(
      candidates.map((content) => ({ content, modality: "text" as const })),
    )

    segments = candidates
      .map((text, index) => {
        const vector = candidateEmbeddings[index] ?? []
        const nextStepScore = maxSimilarity(vector, nextStepEmbeddings)
        const remainingWorkScore = maxSimilarity(vector, remainingWorkEmbeddings)
        const continuationScore = Math.max(nextStepScore, remainingWorkScore)
        const label: SemanticContinuationSegment["label"] =
          nextStepScore >= remainingWorkScore ? "next_step" : "remaining_work"
        const actionabilityScore = maxSimilarity(vector, actionableEmbeddings)
        const stopScore = maxSimilarity(vector, stopEmbeddings)
        const summaryScore = maxSimilarity(vector, summaryEmbeddings)

        return {
          label,
          text,
          continuationScore,
          stopScore,
          actionabilityScore,
          summaryScore,
        }
      })
      .filter((segment) =>
        isCarryoverSegment({
          continuationScore: segment.continuationScore,
          actionabilityScore: segment.actionabilityScore,
          stopScore: segment.stopScore,
          summaryScore: segment.summaryScore,
        }),
      )
      .slice(0, MAX_CARRYOVER_SEGMENTS)

    if (segments.length > 0) {
      break
    }
  }

  const messageStopScore = maxSimilarity(messageEmbedding, stopEmbeddings)
  const messageActionabilityScore = maxSimilarity(messageEmbedding, actionableEmbeddings)
  const explicitStop =
    segments.length === 0 &&
    messageStopScore >= EXPLICIT_STOP_THRESHOLD &&
    messageStopScore > messageActionabilityScore + STOP_MARGIN

  return {
    carryoverSegments: segments,
    explicitStop,
    rolloverHandoff: false,
  }
}