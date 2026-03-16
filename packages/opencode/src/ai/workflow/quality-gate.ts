import { Log } from "@/util/log"

export interface GateDecision {
  pass: boolean
  status?: "passed" | "manual_review" | "rejected"
  reason?: string
  suggestions?: any[]
  nextAction?: "proceed" | "collect_evidence" | "rerun_verification" | "address_findings"
  qualityScore?: number
}

export interface QualityMetrics {
  completenessScore: number
  findings: Array<{ severity?: string; message?: string }>
  toolSuccessRatio?: number
  evidenceDensity?: number
  verificationVerdict?: "supported" | "contradicted" | "uncertain" | "unknown"
}

export class QualityGate {
  private log = Log.create({ service: "workflow.quality-gate" })

  check(results: QualityMetrics): GateDecision {
    const {
      completenessScore,
      findings,
      toolSuccessRatio,
      evidenceDensity,
      verificationVerdict,
    } = results

    const criticalFindings = findings?.filter((f) => f.severity === "critical") ?? []
    const errorFindings = findings?.filter((f) => f.severity === "error") ?? []
    const findingMessages = findings?.map((f) => f.message).filter((item): item is string => !!item) ?? []

    this.log.info("Checking quality gate", {
      score: completenessScore,
      findingsCount: findings?.length || 0,
      toolSuccessRatio,
      evidenceDensity,
      verificationVerdict,
    })

    if (criticalFindings.length > 0) {
      this.log.warn("Quality gate rejected due to critical findings", { count: criticalFindings.length })
      return {
        pass: false,
        status: "rejected",
        reason: "Critical findings must be resolved before completion",
        suggestions: findingMessages,
        nextAction: "address_findings",
        qualityScore: completenessScore,
      }
    }

    // Auto-pass: 80%+ and no critical/error findings
    if (completenessScore >= 80 && errorFindings.length === 0) {
      this.log.info("Quality gate passed automatically")
      return {
        pass: true,
        status: "passed",
        reason: "All quality gates passed",
        nextAction: "proceed",
        qualityScore: completenessScore,
      }
    }

    // Manual review: 60-80%
    if (completenessScore >= 60) {
      this.log.info("Quality gate requires manual review")
      return {
        pass: false,
        status: "manual_review",
        reason: "Requires manual review",
        suggestions: findingMessages,
        nextAction: verificationVerdict === "uncertain" ? "rerun_verification" : "collect_evidence",
        qualityScore: completenessScore,
      }
    }

    // Auto-reject: <60%
    this.log.warn("Quality gate rejected", { score: completenessScore })
    return {
      pass: false,
      status: "rejected",
      reason: "Quality too low, automatic rejection",
      suggestions: findingMessages,
      nextAction: "address_findings",
      qualityScore: completenessScore,
    }
  }
}
