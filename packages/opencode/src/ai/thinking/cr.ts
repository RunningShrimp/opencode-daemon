import { z } from "zod"

export const CRSeverity = z.enum(["low", "medium", "high", "critical"])
export type CRSeverity = z.infer<typeof CRSeverity>

export const CRLikelihood = z.enum(["low", "medium", "high", "rare", "unlikely", "likely", "certain"])
export type CRLikelihood = z.infer<typeof CRLikelihood>

export const CritiqueCategory = z.enum(["logic", "security", "performance", "maintainability", "correctness", "other"])
export type CritiqueCategory = z.infer<typeof CritiqueCategory>

export enum CRPhase {
  PRE_CR = "pre_cr",
  POST_CR = "post_cr",
  FINAL_REVIEW = "final_review",
}

export const WorstCaseAssumption = z.object({
  scenario: z.string(),
  severity: CRSeverity.default("medium"),
  likelihood: z.enum(["low", "medium", "high", "rare", "unlikely", "likely", "certain"]).default("unlikely"),
  impact: z.string().optional(),
  mitigation: z.string().optional(),
})

export type WorstCaseAssumption = z.infer<typeof WorstCaseAssumption>

export const CritiqueFinding = z.object({
  id: z.string(),
  category: CritiqueCategory.default("other"),
  description: z.string(),
  severity: z.enum(["info", "warning", "error", "critical"]),
  location: z.string().optional(),
  evidence: z.string().optional(),
  worstCaseAssumption: WorstCaseAssumption.optional(),
  suggestion: z.string().optional(),
  autoFixable: z.boolean().default(false),
  fixSuggestion: z.string().optional(),
})

export type CritiqueFinding = z.infer<typeof CritiqueFinding>

export const CRFeedback = z.object({
  phase: z.nativeEnum(CRPhase),
  findings: z.array(CritiqueFinding),
  overallRisk: z.enum(["low", "medium", "high", "critical"]),
  summary: z.string(),
  timestamp: z.number(),
})

export type CRFeedback = z.infer<typeof CRFeedback>

export const SelfCritiqueResult = z.object({
  originalOutput: z.string(),
  critique: z.string(),
  improvements: z.array(z.string()),
  verdict: z.enum(["pass", "needs_revision", "fail"]),
  timestamp: z.number(),
})

export type SelfCritiqueResult = z.infer<typeof SelfCritiqueResult>

export const ReviewVerification = z.object({
  originalSuggestions: z.array(z.string()),
  verifiedItems: z.array(z.string()),
  unverifiedItems: z.array(z.string()),
  verificationDate: z.number(),
})

export type ReviewVerification = z.infer<typeof ReviewVerification>

export const CRReport = z.object({
  id: z.string(),
  sessionId: z.string(),
  preCR: CRFeedback.optional(),
  postCR: CRFeedback.optional(),
  finalReview: ReviewVerification.optional(),
  createdAt: z.number(),
  updatedAt: z.number(),
})

export type CRReport = z.infer<typeof CRReport>

export function createCritiqueFinding(
  category: CritiqueCategory,
  description: string,
  severity: CritiqueFinding["severity"],
  location?: string,
  evidence?: string,
  suggestion?: string,
  autoFixable?: boolean,
  fixSuggestion?: string,
): CritiqueFinding {
  return CritiqueFinding.parse({
    id: crypto.randomUUID(),
    category,
    description,
    severity,
    location,
    evidence,
    suggestion,
    autoFixable,
    fixSuggestion,
  })
}

export function createWorstCaseAssumption(
  scenario: string,
  likelihood: WorstCaseAssumption["likelihood"],
  impact?: WorstCaseAssumption["impact"],
  mitigation?: string,
  severity?: WorstCaseAssumption["severity"],
): WorstCaseAssumption {
  return WorstCaseAssumption.parse({
    scenario,
    severity,
    likelihood,
    impact,
    mitigation,
  })
}

export function createCRFeedback(phase: CRPhase, findings: CritiqueFinding[], summary: string): CRFeedback {
  const riskCounts = { low: 0, medium: 0, high: 0, critical: 0 }
  for (const f of findings) {
    if (f.severity in riskCounts) {
      riskCounts[f.severity as keyof typeof riskCounts]++
    }
  }

  let overallRisk: CRFeedback["overallRisk"] = "low"
  if (riskCounts.critical > 0) overallRisk = "critical"
  else if (riskCounts.high > 0) overallRisk = "high"
  else if (riskCounts.medium > 0) overallRisk = "medium"

  return CRFeedback.parse({
    phase,
    findings,
    overallRisk,
    summary,
    timestamp: Date.now(),
  })
}

export function createSelfCritiqueResult(
  originalOutput: string,
  critique: string,
  improvements: string[],
  verdict: SelfCritiqueResult["verdict"],
): SelfCritiqueResult {
  return SelfCritiqueResult.parse({
    originalOutput,
    critique,
    improvements,
    verdict,
    timestamp: Date.now(),
  })
}

export function createReviewVerification(
  originalSuggestions: string[],
  verifiedItems: string[],
  unverifiedItems: string[],
): ReviewVerification {
  return ReviewVerification.parse({
    originalSuggestions,
    verifiedItems,
    unverifiedItems,
    verificationDate: Date.now(),
  })
}

export function createCRReport(sessionId: string): CRReport {
  return CRReport.parse({
    id: crypto.randomUUID(),
    sessionId,
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
}
