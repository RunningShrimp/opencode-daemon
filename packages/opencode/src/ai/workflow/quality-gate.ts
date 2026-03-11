import { Log } from "@/util/log"

export interface GateDecision {
  pass: boolean
  reason?: string
  suggestions?: any[]
}

export interface QualityMetrics {
  completenessScore: number
  findings: any[]
}

export class QualityGate {
  private log = Log.create({ service: "workflow.quality-gate" })

  check(results: QualityMetrics): GateDecision {
    const { completenessScore, findings } = results

    this.log.info("Checking quality gate", { score: completenessScore, findingsCount: findings?.length || 0 })

    // Auto-pass: 80%+ and no critical/error findings
    if (completenessScore >= 80 && !findings?.some((f) => f.severity === "critical" || f.severity === "error")) {
      this.log.info("Quality gate passed automatically")
      return { pass: true, reason: "All quality gates passed" }
    }

    // Manual review: 60-80%
    if (completenessScore >= 60) {
      this.log.info("Quality gate requires manual review")
      return { pass: false, reason: "Requires manual review", suggestions: findings }
    }

    // Auto-reject: <60%
    this.log.warn("Quality gate rejected", { score: completenessScore })
    return { pass: false, reason: "Quality too low, automatic rejection" }
  }
}
