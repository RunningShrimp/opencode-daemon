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
import { Instance } from "@/project/instance"
import { Ripgrep } from "@/file/ripgrep"

const log = Log.create({ service: "fva-rag" })

export interface VerificationResult {
  claim: string
  supporting: Evidence[]
  contradicting: Evidence[]
  neutral: Evidence[]
  verdict: "supported" | "contradicted" | "uncertain"
  confidence: number
}

export interface Evidence {
  content: string
  filePath: string
  lineNumber: number
  relevance: number
  type: "supporting" | "contradicting" | "neutral"
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
    const project = Instance.project
    const projectId = options.projectId || project?.id || "default"

    log.debug("FVA-RAG verification start", { responseLength: response.length, query: query.slice(0, 50) })

    const hypotheses = this.extractHypotheses(response)
    log.debug("extracted hypotheses", { count: hypotheses.claims.length })

    const allSupporting: Evidence[] = []
    const allContradicting: Evidence[] = []
    const allNeutral: Evidence[] = []

    for (const claim of hypotheses.claims.slice(0, this.config.maxClaims)) {
      const evidence = await this.verifyClaim(claim, query, projectId)
      allSupporting.push(...evidence.supporting)
      allContradicting.push(...evidence.contradicting)
      if (this.config.includeNeutral) {
        allNeutral.push(...evidence.neutral)
      }
    }

    const verdict = this.determineVerdict(allSupporting, allContradicting)
    const confidence = this.calculateConfidence(allSupporting, allContradicting, allNeutral)

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
    originalQuery: string,
    projectId: string,
  ): Promise<{ supporting: Evidence[]; contradicting: Evidence[]; neutral: Evidence[] }> {
    const supporting: Evidence[] = []
    const contradicting: Evidence[] = []
    const neutral: Evidence[] = []

    const supportResults = await this.searchEvidence(claim, projectId)
    for (const result of supportResults) {
      supporting.push({
        content: result.content,
        filePath: result.filePath,
        lineNumber: result.lineNumber,
        relevance: result.score,
        type: "supporting",
      })
    }

    if (this.config.useNegations) {
      const negatedClaim = this.negateClaim(claim)
      const contraResults = await this.searchEvidence(negatedClaim, projectId)
      for (const result of contraResults) {
        contradicting.push({
          content: result.content,
          filePath: result.filePath,
          lineNumber: result.lineNumber,
          relevance: result.score,
          type: "contradicting",
        })
      }
    }

    if (this.config.includeNeutral && supporting.length > 0) {
      const keywords = this.extractKeywords(claim)
      if (keywords.length > 0) {
        const altQuery = keywords.slice(0, 2).join(" ")
        const altResults = await this.searchEvidence(altQuery, projectId)
        const existingIds = new Set([...supporting, ...contradicting].map((e) => `${e.filePath}:${e.lineNumber}`))
        for (const result of altResults) {
          const id = `${result.filePath}:${result.lineNumber}`
          if (!existingIds.has(id) && result.score >= this.config.minRelevance) {
            neutral.push({
              content: result.content,
              filePath: result.filePath,
              lineNumber: result.lineNumber,
              relevance: result.score,
              type: "neutral",
            })
          }
        }
      }
    }

    return { supporting, contradicting, neutral }
  }

  private async searchEvidence(
    query: string,
    projectId: string,
  ): Promise<Array<{ content: string; filePath: string; lineNumber: number; score: number }>> {
    const results: Array<{ content: string; filePath: string; lineNumber: number; score: number }> = []

    try {
      const worktree = Instance.project?.worktree || process.cwd()
      const rgResults = await Ripgrep.search({
        cwd: worktree,
        pattern: query,
        limit: 10,
      })

      for (const r of rgResults) {
        results.push({
          content: r.lines.text.trim(),
          filePath: r.path.text,
          lineNumber: r.line_number,
          score: Math.min(1, r.lines.text.split(/\s+/).length / 10),
        })
      }
    } catch (error) {
      log.warn("Evidence search failed", { error: String(error) })
    }

    try {
      const embedding = await embeddingService.getEmbedding(query)
      if (embedding) {
        const vectorResults = await vectorStore.search(embedding, 5)

        for (const vr of vectorResults) {
          results.push({
            content: vr.content || "",
            filePath: vr.path || "",
            lineNumber: 1,
            score: vr.score,
          })
        }
      }
    } catch (error) {
      log.warn("Vector evidence search failed", { error: String(error) })
    }

    const unique = new Map<string, { content: string; filePath: string; lineNumber: number; score: number }>()
    for (const r of results) {
      const key = `${r.filePath}:${r.lineNumber}`
      const existing = unique.get(key)
      if (!existing || r.score > existing.score) {
        unique.set(key, r)
      }
    }

    return Array.from(unique.values())
      .sort((a, b) => b.score - a.score)
      .slice(0, 5)
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
    supporting: Evidence[],
    contradicting: Evidence[],
  ): "supported" | "contradicted" | "uncertain" {
    const supportScore = supporting.reduce((sum, e) => sum + e.relevance, 0)
    const contraScore = contradicting.reduce((sum, e) => sum + e.relevance, 0)

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

  private calculateConfidence(supporting: Evidence[], contradicting: Evidence[], neutral: Evidence[]): number {
    const total = supporting.length + contradicting.length + neutral.length

    if (total === 0) return 0

    const supportScore = supporting.reduce((sum, e) => sum + e.relevance, 0)
    const contraScore = contradicting.reduce((sum, e) => sum + e.relevance, 0)

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
  return await verifier.verify(response, query, { projectId: options?.projectId })
}
