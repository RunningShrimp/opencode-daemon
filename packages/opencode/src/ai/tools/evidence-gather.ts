import z from "zod"
import { Tool } from "@/tool/tool"
import { Evidence, EvidenceSource, createEvidence } from "@/ai/thinking/evidence"
import { EvidenceLedger } from "@/ai/evidence/ledger"
import { Instance } from "@/project/instance"
import { embeddingService } from "@/ai/rag/embedding"
import { ensureProjectIndexed } from "@/ai/rag/indexer"
import { vectorStore } from "@/ai/rag/vector-store"
import { WorkflowOrchestrator } from "@/ai/workflow/orchestrator"

const SourceTypeSchema = z.enum(["code", "documentation", "test", "config", "llm_reasoning", "previous_session"])

export const EvidenceGatherParameters = z.object({
  hypothesis: z.string().describe("The hypothesis to gather evidence for"),
  searchQuery: z.string().optional().describe("Optional search query"),
  sourceTypes: z.array(SourceTypeSchema).optional().describe("Types of sources to search for evidence"),
  minRelevance: z
    .number()
    .min(0)
    .max(1)
    .default(0.3)
    .optional()
    .describe("Minimum relevance threshold for evidence (0-1)"),
})

export type EvidenceGatherParams = z.infer<typeof EvidenceGatherParameters>

interface EvidenceGatherResult {
  hypothesis: string
  evidence: Evidence[]
  validation: {
    totalEvidence: number
    supportingEvidence: number
    contradictingEvidence: number
    averageRelevance: number
    confidenceLevel: "high" | "medium" | "low"
  }
  recommendation: string
}

const PROJECT_RESULT_LIMIT = 8

function mapSourceTypeToEvidenceSource(sourceType: string): EvidenceSource[] {
  const mapping: Record<string, EvidenceSource[]> = {
    code: [EvidenceSource.CODEBASE],
    documentation: [EvidenceSource.CODEBASE, EvidenceSource.WEB],
    test: [EvidenceSource.CODEBASE],
    config: [EvidenceSource.CODEBASE],
    llm_reasoning: [EvidenceSource.LLM_REASONING],
    previous_session: [EvidenceSource.PREVIOUS_SESSION],
  }
  return mapping[sourceType] || [EvidenceSource.MODEL_GENERATED]
}

function shouldSearchProject(sourceTypes?: string[]) {
  if (!sourceTypes || sourceTypes.length === 0) return true
  return sourceTypes.some((sourceType) => ["code", "documentation", "test", "config"].includes(sourceType))
}

function shouldIncludePreviousSession(sourceTypes?: string[]) {
  if (!sourceTypes || sourceTypes.length === 0) return true
  return sourceTypes.includes("previous_session")
}

function classifyProjectSource(filePath: string): "code" | "documentation" | "test" | "config" {
  const normalized = filePath.toLowerCase()
  if (
    normalized.endsWith("package.json") ||
    normalized.endsWith("tsconfig.json") ||
    normalized.endsWith("bunfig.toml") ||
    normalized.includes("/config") ||
    /(^|\/)[^.]+\.config\./.test(normalized)
  ) {
    return "config"
  }
  if (
    normalized.includes("/__tests__/") ||
    normalized.includes("/test/") ||
    normalized.includes("/tests/") ||
    normalized.includes(".test.") ||
    normalized.includes(".spec.")
  ) {
    return "test"
  }
  if (normalized.endsWith(".md") || normalized.endsWith(".mdx") || normalized.includes("/docs/")) {
    return "documentation"
  }
  return "code"
}

function formatLocation(filePath: string, startLine?: number, endLine?: number) {
  if (typeof startLine !== "number") return filePath
  if (typeof endLine === "number" && endLine !== startLine) {
    return `${filePath}:${startLine}-${endLine}`
  }
  return `${filePath}:${startLine}`
}

function overlapScore(hypothesis: string, content: string) {
  const hypothesisTokens = tokenize(hypothesis)
  const contentTokens = new Set(tokenize(content))
  if (hypothesisTokens.length === 0) return 0
  const matches = hypothesisTokens.filter((token) => contentTokens.has(token)).length
  return matches / hypothesisTokens.length
}

function tokenize(value: string) {
  return [...new Set(value.toLowerCase().split(/[^a-z0-9_./-]+/g).filter((token) => token.length > 2))]
}

function dedupeEvidence(items: Evidence[]) {
  const seen = new Set<string>()
  const result: Evidence[] = []
  for (const item of items.sort((left, right) => right.relevance - left.relevance)) {
    const key = `${item.source}:${item.location ?? ""}:${item.content.slice(0, 120)}`
    if (seen.has(key)) continue
    seen.add(key)
    result.push(item)
  }
  return result
}

async function gatherProjectEvidence(
  hypothesis: string,
  searchQuery: string | undefined,
  sourceTypes: string[] | undefined,
  minRelevance: number,
) {
  const project = Instance.project
  if (!project || !shouldSearchProject(sourceTypes)) return []

  if ((await vectorStore.getProjectSize(project.id)) === 0) {
    await ensureProjectIndexed({
      rootDir: project.worktree,
      fallbackDir: Instance.directory,
      projectId: project.id,
      vectorStore,
    }).catch(() => undefined)
  }

  const query = searchQuery?.trim() || hypothesis
  const queryEmbeddings = await embeddingService.getQueryEmbeddings(query)
  const results = await vectorStore.search(queryEmbeddings, {
    projectId: project.id,
    limit: PROJECT_RESULT_LIMIT,
    minScore: Math.max(0.15, minRelevance * 0.5),
  })

  return results
    .filter((result) => {
      const category = classifyProjectSource(result.path)
      return !sourceTypes || sourceTypes.length === 0 || sourceTypes.includes(category)
    })
    .map((result) => {
      const location = formatLocation(result.path, result.startLine, result.endLine)
      const relevance = Math.max(result.score, overlapScore(hypothesis, `${result.path}\n${result.content}`))
      return createEvidence(
        EvidenceSource.CODEBASE,
        result.content,
        Math.min(1, relevance),
        {
          filePath: result.path,
          category: classifyProjectSource(result.path),
        },
        {
          quote: result.content.slice(0, 200),
          location,
        },
      )
    })
}

async function gatherPreviousSessionEvidence(hypothesis: string, sessionID: string, projectID: string, minRelevance: number) {
  const snapshot = await EvidenceLedger.read(sessionID, projectID)
  return snapshot.claims
    .flatMap((claim) => {
      const location = `session:${snapshot.sessionID}:claim:${claim.id}`
      const support = claim.evidence.map((item) =>
        createEvidence(
          EvidenceSource.PREVIOUS_SESSION,
          `${claim.claim}\n${item.quote ?? item.content}`,
          Math.max(item.relevance, overlapScore(hypothesis, `${claim.claim}\n${item.content}`)),
          {
            claim: claim.claim,
            originalSource: claim.source,
          },
          {
            quote: item.quote,
            location,
            contradicts: item.contradicts,
          },
        ),
      )
      const counter = claim.counterEvidence.map((item) =>
        createEvidence(
          EvidenceSource.PREVIOUS_SESSION,
          `${claim.claim}\n${item.quote ?? item.content}`,
          Math.max(item.relevance, overlapScore(hypothesis, `${claim.claim}\n${item.content}`)),
          {
            claim: claim.claim,
            originalSource: claim.source,
          },
          {
            quote: item.quote,
            location,
            contradicts: true,
          },
        ),
      )
      return [...support, ...counter]
    })
    .filter((item) => item.relevance >= minRelevance)
}

function scoreRelevance(evidence: Evidence, hypothesis: string): number {
  const hypothesisLower = hypothesis.toLowerCase()
  const contentLower = evidence.content.toLowerCase()

  const hypothesisWords = hypothesisLower.split(/\s+/).filter((w) => w.length > 2)
  let matchCount = 0
  for (const word of hypothesisWords) {
    if (contentLower.includes(word)) {
      matchCount++
    }
  }

  const baseScore = hypothesisWords.length > 0 ? matchCount / hypothesisWords.length : 0

  const supportingPatterns = [
    "confirms",
    "validates",
    "proves",
    "demonstrates",
    "shows",
    "indicates",
    "supports",
    "works",
    "correct",
    "right",
  ]
  const contradictingPatterns = [
    "contradicts",
    "refutes",
    "disproves",
    "debunks",
    "false",
    "incorrect",
    "error",
    "bug",
    "issue",
    "problem",
  ]

  for (const pattern of supportingPatterns) {
    if (contentLower.includes(pattern)) {
      return evidence.contradicts ? Math.max(baseScore - 0.2, 0) : Math.min(baseScore + 0.2, 1)
    }
  }

  for (const pattern of contradictingPatterns) {
    if (contentLower.includes(pattern)) {
      return evidence.contradicts ? Math.min(baseScore + 0.3, 1) : Math.max(baseScore - 0.2, 0)
    }
  }

  return baseScore
}

function calculateConfidenceLevel(
  totalEvidence: number,
  supportingEvidence: number,
  contradictingEvidence: number,
  averageRelevance: number,
): "high" | "medium" | "low" {
  const supportingRatio = totalEvidence > 0 ? supportingEvidence / totalEvidence : 0
  const contradictingRatio = totalEvidence > 0 ? contradictingEvidence / totalEvidence : 0

  const evidenceStrength = (averageRelevance * (supportingRatio - contradictingRatio + 1)) / 2

  if (totalEvidence >= 5 && evidenceStrength > 0.7 && averageRelevance > 0.6) {
    return "high"
  }
  if (totalEvidence >= 2 && evidenceStrength > 0.4 && averageRelevance > 0.3) {
    return "medium"
  }
  return "low"
}

function generateRecommendation(
  hypothesis: string,
  totalEvidence: number,
  supportingEvidence: number,
  contradictingEvidence: number,
  averageRelevance: number,
  confidenceLevel: "high" | "medium" | "low",
): string {
  if (totalEvidence === 0) {
    return `No evidence found to validate or refute the hypothesis: "${hypothesis}". Consider providing more context or a search query to find relevant evidence.`
  }

  const supportingRatio = totalEvidence > 0 ? supportingEvidence / totalEvidence : 0
  const contradictingRatio = totalEvidence > 0 ? contradictingEvidence / totalEvidence : 0

  if (confidenceLevel === "high" && supportingRatio > 0.7) {
    return `Strong evidence supports the hypothesis. ${supportingEvidence} out of ${totalEvidence} evidence items support this hypothesis with average relevance of ${(averageRelevance * 100).toFixed(0)}%. The hypothesis appears valid.`
  }

  if (confidenceLevel === "high" && contradictingRatio > 0.7) {
    return `Strong evidence contradicts the hypothesis. ${contradictingEvidence} out of ${totalEvidence} evidence items contradict this hypothesis with average relevance of ${(averageRelevance * 100).toFixed(0)}%. The hypothesis appears invalid.`
  }

  if (confidenceLevel === "medium") {
    if (supportingRatio > contradictingRatio) {
      return `Moderate evidence supports the hypothesis. ${supportingEvidence} supporting vs ${contradictingEvidence} contradicting evidence. Consider gathering more evidence to strengthen confidence.`
    }
    if (contradictingRatio > supportingRatio) {
      return `Moderate evidence contradicts the hypothesis. ${contradictingEvidence} contradicting vs ${supportingEvidence} supporting evidence. Consider gathering more evidence to strengthen confidence.`
    }
    return `Mixed evidence found. ${supportingEvidence} supporting and ${contradictingEvidence} contradicting evidence. More evidence needed to draw a conclusion.`
  }

  return `Insufficient evidence to validate the hypothesis. Only ${totalEvidence} evidence items found with average relevance of ${(averageRelevance * 100).toFixed(0)}%. Consider providing a search query or additional context.`
}

export const EvidenceGatherTool = Tool.define("evidence_gather", async () => ({
  description:
    "Gather and validate evidence for a hypothesis. This tool helps agents collect relevant information and assess its validity by scoring relevance and detecting contradictions.",
  parameters: EvidenceGatherParameters,
  async execute(params: EvidenceGatherParams, ctx) {
    const minRelevance = params.minRelevance ?? 0.3

    const projectEvidence = await gatherProjectEvidence(
      params.hypothesis,
      params.searchQuery,
      params.sourceTypes,
      minRelevance,
    ).catch(() => [])
    const previousSessionEvidence = shouldIncludePreviousSession(params.sourceTypes) && Instance.project
      ? await gatherPreviousSessionEvidence(params.hypothesis, ctx.sessionID, Instance.project.id, minRelevance).catch(() => [])
      : []

    let evidence = dedupeEvidence([...projectEvidence, ...previousSessionEvidence])

    if (params.sourceTypes && params.sourceTypes.length > 0) {
      const allowedSources = params.sourceTypes.flatMap(mapSourceTypeToEvidenceSource)
      evidence = evidence.filter((e) => allowedSources.includes(e.source))
    }

    const scoredEvidence = evidence.map((e) => {
      const newRelevance = scoreRelevance(e, params.hypothesis)
      return { ...e, relevance: Math.max(e.relevance, newRelevance) }
    })

    const filteredEvidence = scoredEvidence.filter((e) => e.relevance >= minRelevance)

    const supportingEvidence = filteredEvidence.filter((e) => !e.contradicts).length
    const contradictingEvidence = filteredEvidence.filter((e) => e.contradicts).length
    const totalEvidence = filteredEvidence.length

    const averageRelevance =
      totalEvidence > 0 ? filteredEvidence.reduce((sum, e) => sum + e.relevance, 0) / totalEvidence : 0

    const confidenceLevel = calculateConfidenceLevel(
      totalEvidence,
      supportingEvidence,
      contradictingEvidence,
      averageRelevance,
    )

    const recommendation = generateRecommendation(
      params.hypothesis,
      totalEvidence,
      supportingEvidence,
      contradictingEvidence,
      averageRelevance,
      confidenceLevel,
    )

    const result: EvidenceGatherResult = {
      hypothesis: params.hypothesis,
      evidence: filteredEvidence,
      validation: {
        totalEvidence,
        supportingEvidence,
        contradictingEvidence,
        averageRelevance,
        confidenceLevel,
      },
      recommendation,
    }

    const evidenceSummary = result.evidence
      .map(
        (e, i) =>
          `${i + 1}. [${e.source}] ${e.contradicts ? "(CONTRADICTS) " : ""}Relevance: ${(e.relevance * 100).toFixed(0)}%${e.location ? ` @ ${e.location}` : ""} - ${e.content.substring(0, 100)}...`,
      )
      .join("\n")

    const output = `## Hypothesis
${params.hypothesis}

## Evidence (${result.validation.totalEvidence} items)
${evidenceSummary || "No evidence found matching the criteria."}

## Validation
- **Total Evidence:** ${result.validation.totalEvidence}
- **Supporting:** ${result.validation.supportingEvidence}
- **Contradicting:** ${result.validation.contradictingEvidence}
- **Average Relevance:** ${(result.validation.averageRelevance * 100).toFixed(0)}%
- **Confidence Level:** ${result.validation.confidenceLevel.toUpperCase()}

## Recommendation
${result.recommendation}`

    void EvidenceLedger.recordEvidenceCollection({
      sessionID: ctx.sessionID,
      projectID: Instance.project.id,
      hypothesis: params.hypothesis,
      evidence: filteredEvidence,
      confidence:
        confidenceLevel === "high" ? 0.85 : confidenceLevel === "medium" ? 0.6 : totalEvidence > 0 ? 0.35 : 0,
      source: "tool",
      metadata: {
        tool: "evidence_gather",
        searchQuery: params.searchQuery,
        sourceTypes: params.sourceTypes,
      },
    }).catch(() => undefined)
    void WorkflowOrchestrator.noteEvidence(
      ctx.sessionID,
      filteredEvidence.map((item) => item.location ?? item.quote ?? item.content.slice(0, 120)),
    ).catch(() => undefined)

    return {
      title: `Evidence: ${confidenceLevel} confidence`,
      metadata: {
        totalEvidence: result.validation.totalEvidence,
        supportingEvidence: result.validation.supportingEvidence,
        contradictingEvidence: result.validation.contradictingEvidence,
        confidenceLevel: result.validation.confidenceLevel,
      },
      output,
    }
  },
}))
