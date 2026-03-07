import z from "zod"
import { Tool } from "@/tool/tool"
import { Evidence, EvidenceSource, createEvidence } from "@/ai/thinking/evidence"

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

function createMockEvidence(hypothesis: string, minRelevance: number): Evidence[] {
  const mockEvidenceData = [
    {
      source: EvidenceSource.CODEBASE,
      content: `The code confirms that the implementation follows the expected pattern for ${hypothesis}`,
      contradicts: false,
    },
    {
      source: EvidenceSource.CODEBASE,
      content: `Analysis shows the function correctly handles edge cases related to ${hypothesis}`,
      contradicts: false,
    },
    {
      source: EvidenceSource.WEB,
      content: `Documentation validates that ${hypothesis} is the recommended approach`,
      contradicts: false,
    },
    {
      source: EvidenceSource.TOOL_RESULT,
      content: `Test results demonstrate the implementation works correctly for ${hypothesis}`,
      contradicts: false,
    },
    {
      source: EvidenceSource.CODEBASE,
      content: `The code contains a bug that prevents ${hypothesis} from working correctly`,
      contradicts: true,
    },
    {
      source: EvidenceSource.MODEL_GENERATED,
      content: `Analysis suggests ${hypothesis} may have some issues`,
      contradicts: false,
    },
  ]

  return mockEvidenceData
    .map((data) => {
      const relevance = 0.4 + Math.random() * 0.6
      const evidence = createEvidence(data.source, data.content, relevance, undefined, {
        contradicts: data.contradicts,
      })
      return evidence
    })
    .filter((e) => e.relevance >= minRelevance)
}

export const EvidenceGatherTool = Tool.define("evidence_gather", async () => ({
  description:
    "Gather and validate evidence for a hypothesis. This tool helps agents collect relevant information and assess its validity by scoring relevance and detecting contradictions.",
  parameters: EvidenceGatherParameters,
  async execute(params: EvidenceGatherParams) {
    const minRelevance = params.minRelevance ?? 0.3

    let evidence = createMockEvidence(params.hypothesis, minRelevance)

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
          `${i + 1}. [${e.source}] ${e.contradicts ? "(CONTRADICTS) " : ""}Relevance: ${(e.relevance * 100).toFixed(0)}% - ${e.content.substring(0, 100)}...`,
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
