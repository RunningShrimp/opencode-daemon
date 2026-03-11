/**
 * Evidence-driven reasoning core module
 *
 * Provides type definitions and utilities for evidence collection,
 * hypothesis validation, and agent thought tracking.
 *
 * @module ai/thinking/evidence
 */

import { z } from "zod"

/**
 * Sources of evidence in the system
 */
export enum EvidenceSource {
  /** Code search results */
  SEARCH = "search",
  /** Direct codebase access */
  CODEBASE = "codebase",
  /** User-provided information */
  USER_INPUT = "user_input",
  /** Web search results */
  WEB = "web",
  /** Tool execution results */
  TOOL_RESULT = "tool_result",
  /** Model-generated content */
  MODEL_GENERATED = "model_generated",
  /** LLM reasoning output */
  LLM_REASONING = "llm_reasoning",
  /** Previous session context */
  PREVIOUS_SESSION = "previous_session",
}

/**
 * Evidence schema definition
 */
export const Evidence = z.object({
  /** Unique identifier */
  id: z.string(),
  /** Source of the evidence */
  source: z.nativeEnum(EvidenceSource),
  /** Content of the evidence */
  content: z.string(),
  /** Relevance score (0-1) */
  relevance: z.number().min(0).max(1),
  /** Timestamp when created */
  timestamp: z.number(),
  /** Optional quoted text */
  quote: z.string().optional(),
  /** Optional location reference */
  location: z.string().optional(),
  /** Whether this evidence contradicts a hypothesis */
  contradicts: z.boolean().default(false),
  /** Additional metadata */
  metadata: z.record(z.string(), z.unknown()).optional(),
})

export type Evidence = z.infer<typeof Evidence>

/**
 * Pessimistic check schema for hypothesis validation
 */
export const PessimisticCheck = z.object({
  /** The check being performed */
  check: z.string(),
  /** Worst case scenario */
  worstCase: z.string(),
  /** Mitigation strategy */
  mitigation: z.string().optional(),
  /** Whether the check passed */
  passed: z.boolean(),
})

export type PessimisticCheck = z.infer<typeof PessimisticCheck>

/**
 * Hypothesis schema with evidence backing
 */
export const Hypothesis = z.object({
  /** Unique identifier */
  id: z.string(),
  /** The hypothesis statement */
  statement: z.string(),
  /** IDs of supporting evidence */
  evidenceIds: z.array(z.string()).min(1),
  /** Confidence level (0-1) */
  confidence: z.number().min(0).max(1),
  /** When created */
  createdAt: z.number(),
  /** Pessimistic checks performed */
  pessimisticChecks: z.array(PessimisticCheck).optional(),
  /** Notes from reflection */
  reflectionNotes: z.string().optional(),
})

export type Hypothesis = z.infer<typeof Hypothesis>

/**
 * Record of search operations
 */
export const SearchRecord = z.object({
  /** Search query */
  query: z.string(),
  /** Search results */
  results: z.array(z.string()),
  /** When performed */
  timestamp: z.number(),
  /** Tool used for search */
  toolName: z.string(),
})

export type SearchRecord = z.infer<typeof SearchRecord>

/**
 * Agent thought at a specific step
 */
export const AgentThought = z.object({
  /** Unique identifier */
  id: z.string(),
  /** Step number in reasoning */
  step: z.number(),
  /** The thought content */
  thought: z.string(),
  /** Evidence collected at this step */
  evidence: z.array(Evidence),
  /** Hypotheses at this step */
  hypotheses: z.array(Hypothesis),
  /** Search history at this step */
  searchHistory: z.array(SearchRecord),
  /** When created */
  timestamp: z.number(),
})

export type AgentThought = z.infer<typeof AgentThought>

/**
 * Validate a hypothesis against evidence
 *
 * @param hypothesis - The hypothesis to validate
 * @param evidenceMap - Map of evidence IDs to evidence objects
 * @returns Whether the hypothesis is valid
 */
export function validateHypothesis(hypothesis: Hypothesis, evidenceMap: Map<string, Evidence>): boolean {
  if (hypothesis.evidenceIds.length < 1) return false

  let totalRelevance = 0
  for (const evidenceId of hypothesis.evidenceIds) {
    const evidence = evidenceMap.get(evidenceId)
    if (!evidence) return false
    totalRelevance += evidence.relevance
  }

  const avgRelevance = totalRelevance / hypothesis.evidenceIds.length
  return avgRelevance >= 0.3
}

/**
 * Create a new evidence object
 *
 * @param source - Source of the evidence
 * @param content - Content of the evidence
 * @param relevance - Relevance score
 * @param metadata - Optional metadata
 * @param options - Optional quote, location, and contradicts flag
 * @returns A new Evidence object
 */
export function createEvidence(
  source: EvidenceSource,
  content: string,
  relevance: number,
  metadata?: Record<string, unknown>,
  options?: { quote?: string; location?: string; contradicts?: boolean },
): Evidence {
  return Evidence.parse({
    id: crypto.randomUUID(),
    source,
    content,
    relevance,
    timestamp: Date.now(),
    metadata,
    quote: options?.quote,
    location: options?.location,
    contradicts: options?.contradicts,
  })
}

/**
 * Create a new hypothesis object
 *
 * @param statement - The hypothesis statement
 * @param evidenceIds - IDs of supporting evidence
 * @param options - Optional pessimistic checks and reflection notes
 * @returns A new Hypothesis object
 */
export function createHypothesis(
  statement: string,
  evidenceIds: string[],
  options?: { pessimisticChecks?: PessimisticCheck[]; reflectionNotes?: string },
): Hypothesis {
  return Hypothesis.parse({
    id: crypto.randomUUID(),
    statement,
    evidenceIds,
    confidence: 0.5,
    createdAt: Date.now(),
    pessimisticChecks: options?.pessimisticChecks,
    reflectionNotes: options?.reflectionNotes,
  })
}

/**
 * Create a search record
 *
 * @param query - Search query
 * @param results - Search results
 * @param toolName - Tool used for search
 * @returns A new SearchRecord object
 */
export function createSearchRecord(query: string, results: string[], toolName: string): SearchRecord {
  return SearchRecord.parse({
    query,
    results,
    timestamp: Date.now(),
    toolName,
  })
}

/**
 * Create an agent thought object
 *
 * @param step - Step number
 * @param thought - Thought content
 * @param evidence - Evidence collected
 * @param hypotheses - Hypotheses at this step
 * @param searchHistory - Search history
 * @returns A new AgentThought object
 */
export function createAgentThought(
  step: number,
  thought: string,
  evidence: Evidence[] = [],
  hypotheses: Hypothesis[] = [],
  searchHistory: SearchRecord[] = [],
): AgentThought {
  return AgentThought.parse({
    id: crypto.randomUUID(),
    step,
    thought,
    evidence,
    hypotheses,
    searchHistory,
    timestamp: Date.now(),
  })
}

/**
 * Evidence collector class for managing evidence during reasoning
 */
export class EvidenceCollector {
  private evidence: Map<string, Evidence> = new Map()
  private hypotheses: Map<string, Hypothesis> = new Map()
  private thoughts: AgentThought[] = []

  /**
   * Add evidence to the collector
   */
  addEvidence(evidence: Evidence): void {
    this.evidence.set(evidence.id, evidence)
  }

  /**
   * Add a hypothesis to the collector
   */
  addHypothesis(hypothesis: Hypothesis): void {
    this.hypotheses.set(hypothesis.id, hypothesis)
  }

  /**
   * Record a thought step
   */
  recordThought(thought: AgentThought): void {
    this.thoughts.push(thought)
  }

  /**
   * Get all evidence
   */
  getEvidence(): Evidence[] {
    return Array.from(this.evidence.values())
  }

  /**
   * Get evidence by ID
   */
  getEvidenceById(id: string): Evidence | undefined {
    return this.evidence.get(id)
  }

  /**
   * Get all hypotheses
   */
  getHypotheses(): Hypothesis[] {
    return Array.from(this.hypotheses.values())
  }

  /**
   * Get validated hypotheses
   */
  getValidatedHypotheses(): Hypothesis[] {
    return this.getHypotheses().filter((h) => validateHypothesis(h, this.evidence))
  }

  /**
   * Get all thoughts
   */
  getThoughts(): AgentThought[] {
    return [...this.thoughts]
  }

  /**
   * Get supporting evidence for a hypothesis
   */
  getSupportingEvidence(hypothesisId: string): Evidence[] {
    const hypothesis = this.hypotheses.get(hypothesisId)
    if (!hypothesis) return []

    return hypothesis.evidenceIds
      .map((id) => this.evidence.get(id))
      .filter((e): e is Evidence => e !== undefined && !e.contradicts)
  }

  /**
   * Get contradicting evidence for a hypothesis
   */
  getContradictingEvidence(hypothesisId: string): Evidence[] {
    const hypothesis = this.hypotheses.get(hypothesisId)
    if (!hypothesis) return []

    return hypothesis.evidenceIds
      .map((id) => this.evidence.get(id))
      .filter((e): e is Evidence => e !== undefined && e.contradicts)
  }

  /**
   * Update hypothesis confidence based on evidence
   */
  updateHypothesisConfidence(hypothesisId: string): void {
    const hypothesis = this.hypotheses.get(hypothesisId)
    if (!hypothesis) return

    const supporting = this.getSupportingEvidence(hypothesisId)
    const contradicting = this.getContradictingEvidence(hypothesisId)

    const supportingWeight = supporting.reduce((sum, e) => sum + e.relevance, 0)
    const contradictingWeight = contradicting.reduce((sum, e) => sum + e.relevance, 0)

    const totalEvidence = hypothesis.evidenceIds.length
    if (totalEvidence === 0) return

    const baseConfidence = 0.5
    const supportBoost = supportingWeight / (totalEvidence * 2)
    const contradictPenalty = contradictingWeight / (totalEvidence * 2)

    hypothesis.confidence = Math.max(0, Math.min(1, baseConfidence + supportBoost - contradictPenalty))
  }

  /**
   * Generate a summary of collected evidence
   */
  generateSummary(): {
    totalEvidence: number
    totalHypotheses: number
    validatedHypotheses: number
    averageConfidence: number
    sources: Record<EvidenceSource, number>
  } {
    const hypotheses = this.getHypotheses()
    const validated = this.getValidatedHypotheses()

    const sources: Record<EvidenceSource, number> = {} as Record<EvidenceSource, number>
    for (const e of this.getEvidence()) {
      sources[e.source] = (sources[e.source] || 0) + 1
    }

    return {
      totalEvidence: this.evidence.size,
      totalHypotheses: hypotheses.length,
      validatedHypotheses: validated.length,
      averageConfidence:
        hypotheses.length > 0 ? hypotheses.reduce((sum, h) => sum + h.confidence, 0) / hypotheses.length : 0,
      sources,
    }
  }

  /**
   * Clear all collected data
   */
  clear(): void {
    this.evidence.clear()
    this.hypotheses.clear()
    this.thoughts = []
  }
}
