/**
 * FVA-RAG: Falsification-Verification Alignment for Mitigating Hallucinations
 *
 * This module implements the FVA-RAG approach from 2025 research:
 * - Treats initial responses as hypotheses
 * - Explicitly retrieves counter-evidence to stress-test answers
 * - Addresses "retrieval sycophancy" where retrievers prefer supporting evidence
 *
 * Reference: arxiv.org/abs/2512.07015
 */

import { Log } from "@/util/log"
import { vectorStore } from "./vector-store"
import { embeddingService } from "./embedding"
import { ensureEmbeddingBackgroundServiceStarted } from "./embedding-bg-service"
import { Instance } from "@/project/instance"
import { Ripgrep } from "@/file/ripgrep"
import { EvidenceSource } from "@/ai/thinking/evidence"
import {
  GroundingBundle,
  type GroundingEvidence,
  createGroundingEvidence,
  evidenceFromRipgrepResult,
  evidenceFromVectorResult,
} from "./evidence"

const log = Log.create({ service: "fva-rag" })

/**
 * Social sycophancy patterns: openers that validate rather than inform.
 * Detecting these in a response signals the model may be agreeing rather than reasoning.
 */
const SYCOPHANTIC_OPENERS = [
  /^(great|excellent|wonderful|perfect|brilliant|fantastic|amazing)([ !,]|$)/i,
  /^(absolutely|definitely|certainly|of course|sure thing|you bet)([ !,]|$)/i,
  /^you('re| are) (right|correct|spot on|absolutely right|so right)/i,
  /^(yes|yeah),? (you're|that's|this is|you are) (right|correct|a good point|valid)/i,
  /^(that's|this is) (absolutely|definitely|certainly|totally) (right|correct|true|valid)/i,
  /^(i completely|i totally|i fully) (agree|concur|understand)([ !,]|$)/i,
  /^(no worries|no problem|of course|happy to help|glad (to hear|you mentioned))([ !,]|$)/i,
  /^(good (point|question|observation|catch)|great (point|question|observation|catch))([ !,]|$)/i,
  /^(exactly|precisely|correct|right)([ !,.]|$)/i,
  /^(i see what you mean|i understand your concern|i appreciate (your|that))/i,
  /^(well said|very good|nice|wise (choice|decision))([ !,]|$)/i,
  /^(you('re| are) absolutely|you('re| are) completely) (right|correct)/i,
  /^(完全正确|你说得对|你完全说对了|你这个想法太棒了|这个问题非常好|说得太好了|非常赞同|我完全同意)/,
  /^(没错|当然|确实如此|绝对是这样|这个思路非常棒)([，。！!\s]|$)/,
  /^(你的判断很准确|你抓得很准|你的观察很到位)([，。！!\s]|$)/,
]

/**
 * Mid-body sycophancy patterns: validation language embedded after the opening.
 * These indicate agreement-bias even when the opener seems neutral.
 */
const SYCOPHANTIC_MID_BODY = [
  /\b(great point|good point|excellent point|valid point)[ !,.]/i,
  /\byou('re| are) (absolutely|completely|totally|so) (right|correct)\b/i,
  /\b(i completely|i totally|i fully) (agree|concur) with (you|that|this)\b/i,
  /\b(as you (correctly|rightly|wisely) (noted|mentioned|pointed out|said))\b/i,
  /\b(i couldn't agree more|couldn't have said it better)\b/i,
  /\b(well (observed|noted|spotted|caught))\b/i,
  /\bi (largely|mostly|strongly) agree (with you|with that)\b/i,
  /(正如你(正确|准确|非常准确)指出|你这个观点(非常|确实)有道理|你说得(非常|很)对)/,
  /(这个想法(太棒了|很好)|这个问题(非常好|问得很好)|你的观察(非常到位|很准确))/,
  /(我(完全|非常)同意你(的看法|这个判断)|这点我(完全|非常)赞同)/,
]

function detectSocialAgreement(text: string): boolean {
  // Scan first 300 chars for opener patterns (expanded from 100)
  const opener = text.trimStart().slice(0, 300)
  if (SYCOPHANTIC_OPENERS.some((p) => p.test(opener))) return true
  return false
}

function detectMidBodySycophancy(text: string): boolean {
  return SYCOPHANTIC_MID_BODY.some((p) => p.test(text))
}

export interface VerificationResult {
  claim: string
  supporting: GroundingEvidence[]
  contradicting: GroundingEvidence[]
  neutral: GroundingEvidence[]
  verdict: "supported" | "contradicted" | "uncertain"
  confidence: number
  pessimisticHypotheses: string[]
  grounding: GroundingBundle
}

export interface ExtractedHypothesis {
  claims: string[]
  keyFacts: string[]
  assumptions: string[]
}

export interface FVARRAGConfig {
  maxClaims: number
  minRelevance: number
  contradictionThreshold: number
  useNegations: boolean
  includeNeutral: boolean
}

const DEFAULT_CONFIG: FVARRAGConfig = {
  maxClaims: 5,
  minRelevance: 0.3,
  contradictionThreshold: 0.4,
  useNegations: true,
  includeNeutral: true,
}

const NEGATION_PATTERNS = [
  { pattern: "not ", prefix: "" },
  { pattern: "never ", prefix: "" },
  { pattern: "without ", prefix: "" },
  { pattern: "failed to ", prefix: "" },
  { pattern: "error", prefix: "no " },
  { pattern: "null", prefix: "not " },
  { pattern: "undefined", prefix: "defined as " },
  { pattern: "false", prefix: "true " },
  { pattern: "exception", prefix: "no " },
]

export class FVARRAG {
  private config: FVARRAGConfig

  constructor(config: Partial<FVARRAGConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...config }
  }

  async verify(response: string, query: string, options: { projectId?: string } = {}): Promise<VerificationResult> {
    let projectInfo: { id?: string } | undefined
    try { projectInfo = Instance.project } catch { projectInfo = undefined }
    const projectId = options.projectId || projectInfo?.id || "default"

    log.debug("FVA-RAG verification start", { responseLength: response.length, query: query.slice(0, 50) })

    const hypotheses = this.extractHypotheses(response)
    log.debug("extracted hypotheses", { count: hypotheses.claims.length })

    const allSupporting: GroundingEvidence[] = []
    const allContradicting: GroundingEvidence[] = []
    const allNeutral: GroundingEvidence[] = []
    const pessimisticHypotheses: string[] = []

    for (const claim of hypotheses.claims.slice(0, this.config.maxClaims)) {
      const evidence = await this.verifyClaim(claim, query, projectId)
      allSupporting.push(...evidence.supporting)
      allContradicting.push(...evidence.contradicting)
      if (evidence.pessimisticHypothesis) {
        pessimisticHypotheses.push(evidence.pessimisticHypothesis)
      }
      if (this.config.includeNeutral) {
        allNeutral.push(...evidence.neutral)
      }
    }

    const verdict = this.determineVerdict(allSupporting, allContradicting)
    const confidence = this.calculateConfidence(allSupporting, allContradicting, allNeutral)
    const grounding = GroundingBundle.parse({
      claim: hypotheses.claims.join(" | "),
      confidence,
      evidence: [...allSupporting, ...allNeutral],
      counterEvidence: allContradicting,
    })

    log.debug("FVA-RAG verification complete", {
      verdict,
      supporting: allSupporting.length,
      contradicting: allContradicting.length,
      confidence,
    })

    return {
      claim: hypotheses.claims.join(" | "),
      supporting: allSupporting,
      contradicting: allContradicting,
      neutral: allNeutral,
      verdict,
      confidence,
      pessimisticHypotheses,
      grounding,
    }
  }

  private extractHypotheses(response: string): ExtractedHypothesis {
    const sentences = response.split(/[.!?]\s+/).filter((s) => s.trim().length > 10)
    const claims: string[] = []
    const facts: string[] = []
    const assumptions: string[] = []

    for (const sentence of sentences) {
      if (sentence.split(/\s+/).length < 3) continue

      if (
        sentence.includes("returns") ||
        sentence.includes("provides") ||
        sentence.includes("calls") ||
        sentence.includes("imports") ||
        sentence.includes("uses")
      ) {
        facts.push(sentence.trim())
        claims.push(sentence.trim())
      } else if (
        sentence.includes("should") ||
        sentence.includes("would") ||
        sentence.includes("might") ||
        sentence.includes("probably")
      ) {
        assumptions.push(sentence.trim())
        claims.push(sentence.trim())
      } else if (sentence.length > 20) {
        claims.push(sentence.trim())
      }
    }

    return {
      claims: claims.slice(0, this.config.maxClaims),
      keyFacts: facts.slice(0, 3),
      assumptions: assumptions.slice(0, 2),
    }
  }

  private async verifyClaim(
    claim: string,
    _originalQuery: string,
    projectId: string,
  ): Promise<{
    supporting: GroundingEvidence[]
    contradicting: GroundingEvidence[]
    neutral: GroundingEvidence[]
    pessimisticHypothesis?: string
  }> {
    const supporting: GroundingEvidence[] = []
    const contradicting: GroundingEvidence[] = []
    const neutral: GroundingEvidence[] = []

    const supportResults = await this.searchEvidence(claim, projectId)
    for (const result of supportResults) {
      supporting.push(this.withEvidenceRole(result, "supporting"))
    }

    let pessimisticHypothesis: string | undefined
    if (this.config.useNegations) {
      const negatedClaim = this.negateClaim(claim)
      pessimisticHypothesis = negatedClaim
      const contraResults = await this.searchEvidence(negatedClaim, projectId)
      for (const result of contraResults) {
        contradicting.push(this.withEvidenceRole(result, "contradicting"))
      }
    }

    if (this.config.includeNeutral && supporting.length > 0) {
      const keywords = this.extractKeywords(claim)
      if (keywords.length > 0) {
        const altQuery = keywords.slice(0, 2).join(" ")
        const altResults = await this.searchEvidence(altQuery, projectId)
        const existingIds = new Set([...supporting, ...contradicting].map((e) => e.attribution))
        for (const result of altResults) {
          if (!existingIds.has(result.attribution) && result.score >= this.config.minRelevance) {
            neutral.push(this.withEvidenceRole(result, "neutral"))
          }
        }
      }
    }

    return { supporting, contradicting, neutral, pessimisticHypothesis }
  }

  private async searchEvidence(query: string, projectId: string): Promise<GroundingEvidence[]> {
    const results: GroundingEvidence[] = []

    try {
      const worktree = Instance.project?.worktree || process.cwd()
      const rgResults = await Ripgrep.search({
        cwd: worktree,
        pattern: query,
        limit: 10,
      })

      for (const r of rgResults) {
        results.push(
          evidenceFromRipgrepResult({
            content: r.lines.text.trim(),
            filePath: r.path.text,
            lineNumber: r.line_number,
            score: Math.min(1, r.lines.text.split(/\s+/).length / 10),
          }),
        )
      }
    } catch (error) {
      log.warn("Evidence search failed", { error: String(error) })
    }

    try {
      await ensureEmbeddingBackgroundServiceStarted().catch(() => undefined)
      const queryEmbeddings = await embeddingService.getQueryEmbeddings(query)
      if (queryEmbeddings.coarse.length > 0) {
        const vectorResults = await vectorStore.search(queryEmbeddings, {
          limit: 5,
          projectId,
        })

        for (const vr of vectorResults) {
          results.push(evidenceFromVectorResult(vr))
        }
      }
    } catch (error) {
      log.warn("Vector evidence search failed", { error: String(error) })
    }

    const unique = new Map<string, GroundingEvidence>()
    for (const r of results) {
      const key = r.attribution
      const existing = unique.get(key)
      if (!existing || r.score > existing.score) {
        unique.set(key, r)
      }
    }

    return Array.from(unique.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
  }

  private withEvidenceRole(
    evidence: GroundingEvidence,
    role: "supporting" | "contradicting" | "neutral",
  ): GroundingEvidence {
    return createGroundingEvidence({
      ...evidence,
      attribution: evidence.attribution,
      metadata: {
        ...(evidence.metadata ?? {}),
        evidenceRole: role,
      },
    })
  }

  private negateClaim(claim: string): string {
    const lower = claim.toLowerCase()

    for (const { pattern, prefix } of NEGATION_PATTERNS) {
      if (lower.includes(pattern)) {
        return prefix + claim
      }
    }

    return `not ${claim}`
  }

  private extractKeywords(claim: string): string[] {
    const stopWords = new Set([
      "the",
      "a",
      "an",
      "is",
      "are",
      "was",
      "were",
      "be",
      "been",
      "being",
      "have",
      "has",
      "had",
      "do",
      "does",
      "did",
      "will",
      "would",
      "could",
      "should",
      "may",
      "might",
      "must",
      "shall",
      "can",
      "need",
      "dare",
      "to",
      "of",
      "in",
      "for",
      "on",
      "with",
      "at",
      "by",
      "from",
      "as",
      "into",
      "through",
      "during",
      "before",
      "after",
      "above",
      "below",
      "this",
      "that",
      "these",
      "those",
      "it",
      "its",
      "which",
      "who",
      "what",
      "where",
      "when",
      "why",
      "how",
      "and",
      "but",
      "or",
      "not",
    ])

    return claim
      .toLowerCase()
      .split(/\s+/)
      .filter((w) => w.length > 3 && !stopWords.has(w))
      .slice(0, 5)
  }

  private determineVerdict(
    supporting: GroundingEvidence[],
    contradicting: GroundingEvidence[],
  ): "supported" | "contradicted" | "uncertain" {
    const supportScore = supporting.reduce((sum, e) => sum + e.score, 0)
    const contraScore = contradicting.reduce((sum, e) => sum + e.score, 0)

    if (supporting.length === 0 && contradicting.length === 0) {
      return "uncertain"
    }

    if (contraScore > supportScore * (1 + this.config.contradictionThreshold)) {
      return "contradicted"
    }

    if (supportScore > contraScore * (1 + this.config.contradictionThreshold)) {
      return "supported"
    }

    return "uncertain"
  }

  private calculateConfidence(
    supporting: GroundingEvidence[],
    contradicting: GroundingEvidence[],
    neutral: GroundingEvidence[],
  ): number {
    const total = supporting.length + contradicting.length + neutral.length

    if (total === 0) return 0

    const supportScore = supporting.reduce((sum, e) => sum + e.score, 0)
    const contraScore = contradicting.reduce((sum, e) => sum + e.score, 0)

    const maxScore = Math.max(supportScore, contraScore)
    const minScore = Math.min(supportScore, contraScore)
    const spread = maxScore > 0 ? (maxScore - minScore) / maxScore : 0

    return Math.min(1, spread * (total / 10))
  }

  updateConfig(config: Partial<FVARRAGConfig>): void {
    this.config = { ...this.config, ...config }
  }
}

export const globalFVARRAG = new FVARRAG()

export async function verifyWithFVA(
  response: string,
  query: string,
  options?: { projectId?: string; maxClaims?: number },
): Promise<VerificationResult> {
  const verifier = new FVARRAG({ maxClaims: options?.maxClaims ?? 5 })
  const result = await verifier.verify(response, query, { projectId: options?.projectId })

  const hasOpenerSycophancy = detectSocialAgreement(response)
  const hasMidBodySycophancy = detectMidBodySycophancy(response)

  if (hasOpenerSycophancy || hasMidBodySycophancy) {
    const patternKind = hasOpenerSycophancy ? "opener" : "mid-body"
    result.pessimisticHypotheses.push(
      `Social-agreement ${patternKind} pattern detected: response uses validation language. Verify the core claims are grounded in evidence, not agreeableness.`,
    )
    // Force the verdict to uncertain so prompt.ts triggers the revision path.
    // Only downgrade from "supported" — contradicted stays contradicted.
    if (result.verdict === "supported") {
      result.verdict = "uncertain"
    }
    // Inject a synthetic contradicting evidence item so the caller can expose
    // the sycophancy signal in grounding output even when no document evidence
    // was found to contradict the claim.
    result.contradicting.push(
      createGroundingEvidence({
        source: EvidenceSource.MODEL_GENERATED,
        filePath: "<synthetic-sycophancy-detector>",
        quote: "",
        content: `Sycophantic ${patternKind} detected — agreement-bias may override evidence-based reasoning`,
        attribution: "sycophancy-detector",
        score: 0.6,
        modality: "text",
        metadata: { evidenceRole: "contradicting", sycophancyKind: patternKind },
      }),
    )
  }

  return result
}

/**
 * Build pre-generation grounding constraints by checking whether the user query embeds
 * any false assumptions that contradict known codebase facts.
 * Returns a <known_constraints> block (contradictions) and/or a <pessimistic_warnings>
 * block (risk hypotheses) to inject into the system prompt before generation.
 */
export async function buildGroundingConstraints(
  query: string,
  projectId?: string,
): Promise<string | undefined> {
  if (query.length < 15) return undefined
  try {
    const verifier = new FVARRAG({ maxClaims: 3 })
    // Treat the query itself as the hypothesis to stress-test
    const result = await verifier.verify(query, query, { projectId })

    const parts: string[] = []

    const contradictions = result.contradicting
      .slice(0, 3)
      .map((e) => `- ${e.content.slice(0, 150).replace(/\n/g, " ")}`)
    if (contradictions.length > 0) {
      parts.push(
        [
          "<known_constraints>",
          "The following codebase evidence contradicts assumptions in the current request. Do NOT repeat false premises:",
          ...contradictions,
          "</known_constraints>",
        ].join("\n"),
      )
    }

    const warnings = result.pessimisticHypotheses.slice(0, 3).map((h) => `- ${h}`)
    if (warnings.length > 0) {
      parts.push(
        [
          "<pessimistic_warnings>",
          "The following risk hypotheses were identified during pre-generation analysis. Address them proactively if relevant:",
          ...warnings,
          "</pessimistic_warnings>",
        ].join("\n"),
      )
    }

    return parts.length > 0 ? parts.join("\n") : undefined
  } catch {
    return undefined
  }
}
