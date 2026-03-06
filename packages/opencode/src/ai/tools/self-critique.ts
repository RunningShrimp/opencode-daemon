import z from "zod"
import { Tool } from "@/tool/tool"
import { type PessimisticCheck } from "@/ai/thinking/evidence"
import { type CRSeverity, CritiqueCategory, CritiqueFinding, createCritiqueFinding } from "@/ai/thinking/cr"

const SelfCritiqueParameters = z.object({
  workDescription: z.string().describe("Description of work to critique"),
  claims: z.array(z.string()).describe("Claims made by the agent"),
  code: z.string().optional().describe("Code to critique if applicable"),
  focusAreas: z
    .array(z.enum(["correctness", "security", "performance", "maintainability"]))
    .optional()
    .describe("Areas to focus the critique on"),
})

type SelfCritiqueParams = z.infer<typeof SelfCritiqueParameters>

type SelfCritiqueResult = {
  findings: CritiqueFinding[]
  pessimisticChecks: PessimisticCheck[]
  overallAssessment: string
  confidenceLevel: "high" | "medium" | "low"
}

const DEFAULT_FOCUS_AREAS = ["correctness", "security", "performance", "maintainability"] as const

interface ClaimAnalysis {
  claim: string
  issues: string[]
  severity: CRSeverity
  category: CritiqueCategory
}

function analyzeClaim(claim: string, code: string | undefined, focusAreas: readonly string[]): ClaimAnalysis {
  const issues: string[] = []
  let severity: CRSeverity = "low"
  let category: CritiqueCategory = "correctness"

  const claimLower = claim.toLowerCase()

  if (focusAreas.includes("correctness")) {
    if (claimLower.includes("works") || claimLower.includes("works correctly") || claimLower.includes("solved")) {
      if (code) {
        if (code.includes("any") && !code.includes("as any")) {
          issues.push("Code uses 'any' type - loses type safety")
          severity = "medium"
          category = "correctness"
        }
        if (code.includes("TODO") || code.includes("FIXME")) {
          issues.push("Code contains TODO/FIXME comments - incomplete implementation")
          severity = "medium"
          category = "correctness"
        }
      }
      if (!claimLower.includes("edge case") && !claimLower.includes("error handling")) {
        issues.push("Claim does not address edge cases or error handling")
      }
    }
  }

  if (focusAreas.includes("security")) {
    if (code) {
      if (code.includes("eval(") || code.includes("new Function")) {
        issues.push("Code uses eval() or Function constructor - potential code injection vulnerability")
        severity = "high"
        category = "security"
      }
      if (code.includes("SQL injection") || (code.includes("query") && code.includes("+ "))) {
        issues.push("Potential SQL injection vulnerability - use parameterized queries")
        severity = "high"
        category = "security"
      }
      if (code.includes("innerHTML") || code.includes("dangerouslySetInnerHTML")) {
        issues.push("Potential XSS vulnerability - sanitize user input before rendering")
        severity = "high"
        category = "security"
      }
    }
    if (claimLower.includes("secure") || claimLower.includes("safe")) {
      if (!code && !claimLower.includes("validated")) {
        issues.push("Security claim without concrete validation evidence")
        severity = "medium"
        category = "security"
      }
    }
  }

  if (focusAreas.includes("performance")) {
    if (code) {
      if (code.includes("for (") && code.includes("forEach")) {
        issues.push("Consider using for...of or map/filter for better performance")
        severity = "medium"
        category = "performance"
      }
      if (code.includes("JSON.parse") && code.includes("JSON.stringify")) {
        issues.push("Excessive serialization/deserialization may impact performance")
        severity = "low"
        category = "performance"
      }
    }
    if (claimLower.includes("fast") || claimLower.includes("efficient") || claimLower.includes("performant")) {
      if (!code && !claimLower.includes("optimized")) {
        issues.push("Performance claim without evidence of optimization")
        severity = "low"
        category = "performance"
      }
    }
  }

  if (focusAreas.includes("maintainability")) {
    if (code) {
      const lines = code.split("\n")
      const longLines = lines.filter((l) => l.length > 120)
      if (longLines.length > 3) {
        issues.push("Code contains lines exceeding 120 characters - reduces readability")
        severity = "low"
        category = "maintainability"
      }
    }
  }

  if (issues.length === 0) {
    issues.push("Claim appears reasonable but should be verified through testing")
  }

  return { claim, issues, severity, category }
}

function generatePessimisticChecks(
  claim: string,
  code: string | undefined,
  focusAreas: readonly string[],
): PessimisticCheck[] {
  const checks: PessimisticCheck[] = []
  const claimLower = claim.toLowerCase()

  if (focusAreas.includes("correctness")) {
    checks.push({
      check: "Does the implementation handle all edge cases?",
      worstCase: "Edge cases cause runtime errors or incorrect behavior in production",
      mitigation: "Add comprehensive edge case handling and automated tests",
      passed: claimLower.includes("edge case") || claimLower.includes("error handling"),
    })
  }

  if (focusAreas.includes("security")) {
    if (code) {
      const hasSecurityIssues =
        code.includes("eval(") || code.includes("innerHTML") || (code.includes("query") && code.includes("+ "))
      checks.push({
        check: "Is the code secure against common vulnerabilities?",
        worstCase: "Security vulnerabilities are exploited in production",
        mitigation: "Use secure APIs and validate all inputs",
        passed: !hasSecurityIssues,
      })
    } else {
      checks.push({
        check: "Is the solution secure?",
        worstCase: "Security vulnerabilities are discovered after deployment",
        mitigation: "Review code for security best practices",
        passed: claimLower.includes("secure") || claimLower.includes("safe"),
      })
    }
  }

  if (focusAreas.includes("performance")) {
    checks.push({
      check: "Does the implementation perform well under load?",
      worstCase: "Performance degrades with scale or large inputs",
      mitigation: "Profile and optimize hot paths, consider caching",
      passed: claimLower.includes("performance") || claimLower.includes("optimized"),
    })
  }

  if (focusAreas.includes("maintainability")) {
    checks.push({
      check: "Is the code maintainable and easy to understand?",
      worstCase: "Code becomes difficult to modify or debug",
      mitigation: "Add documentation, use clear naming, follow style guides",
      passed: claimLower.includes("maintainable") || claimLower.includes("documented"),
    })
  }

  return checks
}

function generateOverallAssessment(
  findings: CritiqueFinding[],
  pessimisticChecks: PessimisticCheck[],
): { assessment: string; confidence: "high" | "medium" | "low" } {
  const criticalCount = findings.filter((f) => f.severity === "critical").length
  const errorCount = findings.filter((f) => f.severity === "error").length
  const warningCount = findings.filter((f) => f.severity === "warning").length

  const failedChecks = pessimisticChecks.filter((c) => !c.passed).length

  let assessment: string
  let confidence: "high" | "medium" | "low"

  if (criticalCount > 0 || errorCount > 2) {
    assessment =
      "The work has significant issues that should be addressed before proceeding. Multiple critical or error-level findings were identified."
    confidence = "high"
  } else if (errorCount > 0 || warningCount > 3 || failedChecks > 2) {
    assessment =
      "The work has some issues that should be reviewed. Several warnings or failed pessimistic checks were identified."
    confidence = "medium"
  } else if (warningCount > 0 || failedChecks > 0) {
    assessment =
      "The work appears generally sound but has minor issues to consider. A few warnings or pessimistic checks were not fully satisfied."
    confidence = "medium"
  } else {
    assessment = "The work appears to be in good shape. No significant issues were identified during the critique."
    confidence = "high"
  }

  return { assessment, confidence }
}

export const SelfCritiqueTool = Tool.define("self_critique", async () => ({
  description:
    "Use this tool to critique your own work before presenting it to the user. It analyzes claims, code, and generates pessimistic checks to identify potential issues.",
  parameters: SelfCritiqueParameters,
  async execute(params: SelfCritiqueParams) {
    const focusAreas = params.focusAreas ?? DEFAULT_FOCUS_AREAS
    const findings: CritiqueFinding[] = []
    const allPessimisticChecks: PessimisticCheck[] = []

    for (const claim of params.claims) {
      const analysis = analyzeClaim(claim, params.code, focusAreas)

      for (const issue of analysis.issues) {
        findings.push(
          createCritiqueFinding(
            analysis.category,
            issue,
            analysis.severity === "high" || analysis.severity === "critical"
              ? analysis.severity === "critical"
                ? "critical"
                : "error"
              : analysis.severity === "medium"
                ? "warning"
                : "info",
            undefined,
            `Claim: "${claim}"`,
          ),
        )
      }

      const checks = generatePessimisticChecks(claim, params.code, focusAreas)
      allPessimisticChecks.push(...checks)
    }

    if (params.code) {
      const codeLines = params.code.split("\n").length
      if (codeLines > 500) {
        findings.push(
          createCritiqueFinding(
            "maintainability",
            "Code file is very large (>500 lines)",
            "warning",
            "entire file",
            "Large files are harder to maintain and understand",
            "Consider splitting into smaller, focused modules",
          ),
        )
      }

      if (
        !params.code.includes("try") &&
        !params.code.includes("catch") &&
        !params.code.includes("error") &&
        params.code.includes("async")
      ) {
        findings.push(
          createCritiqueFinding(
            "correctness",
            "Async code without apparent error handling",
            "warning",
            undefined,
            "Missing try-catch blocks in async functions",
            "Add error handling for async operations",
          ),
        )
      }
    }

    const { assessment, confidence } = generateOverallAssessment(findings, allPessimisticChecks)

    const result: SelfCritiqueResult = {
      findings,
      pessimisticChecks: allPessimisticChecks,
      overallAssessment: assessment,
      confidenceLevel: confidence,
    }

    const output = `## Self Critique Results

### Overall Assessment
${assessment}

### Confidence Level: ${confidence.toUpperCase()}

### Findings (${findings.length})
${findings.map((f) => `- [${f.severity}] ${f.category}: ${f.description}`).join("\n")}

### Pessimistic Checks (${allPessimisticChecks.length})
${allPessimisticChecks.map((c) => `- ${c.check} (${c.passed ? "PASS" : "FAIL"})`).join("\n")}`

    return {
      title: `Self Critique: ${confidence} confidence`,
      metadata: {
        findingsCount: findings.length,
        checksCount: allPessimisticChecks.length,
        confidenceLevel: confidence,
      },
      output,
    }
  },
}))
