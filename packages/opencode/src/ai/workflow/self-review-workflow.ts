import { Log } from "@/util/log"

export interface ReviewResult {
  passed: boolean
  critique?: any
  findings?: any[]
  completenessScore?: number
}

export class SelfReviewWorkflow {
  private log = Log.create({ service: "workflow.self-review" })

  async executeAfterImplementation(
    code: string,
    claims: string[],
    callTool: (name: string, args: any) => Promise<any>,
  ): Promise<ReviewResult> {
    this.log.info("Starting self-review workflow", { claims })

    const critique = await callTool("self_critique", {
      workDescription: "Implementation",
      claims,
      code,
      focusAreas: ["correctness", "security", "performance"],
    })

    if (critique?.findings?.some((f: any) => f.severity === "error" || f.severity === "critical")) {
      this.log.info("Critical issues found, running verification")

      const verify = await callTool("review_verify", {
        codeChanges: code,
        reviewDepth: "thorough",
      })

      return {
        passed: false,
        critique,
        findings: verify?.findings || [],
        completenessScore: verify?.completenessScore || 0,
      }
    }

    this.log.info("Self-review passed")
    return {
      passed: true,
      critique,
      findings: critique?.findings || [],
      completenessScore: critique?.completenessScore || 100,
    }
  }
}
