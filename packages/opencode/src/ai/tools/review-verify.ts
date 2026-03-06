import z from "zod"
import { Tool } from "@/tool/tool"
import { createCritiqueFinding, type CritiqueCategory, type CritiqueFinding } from "@/ai/thinking/cr"

const ReviewVerifyParameters = z.object({
  codeChanges: z.string().describe("The code changes to review"),
  reviewComments: z.array(z.string()).optional().describe("Existing review comments"),
  focusAreas: z
    .array(z.enum(["logic", "security", "performance", "maintainability", "correctness"]))
    .optional()
    .describe("Areas to focus the review on"),
  reviewDepth: z
    .enum(["shallow", "normal", "thorough"])
    .default("normal")
    .optional()
    .describe("How thorough the review should be"),
})

type ReviewVerifyParams = z.infer<typeof ReviewVerifyParameters>

interface CoverageReport {
  logic: boolean
  security: boolean
  performance: boolean
  maintainability: boolean
  correctness: boolean
}

interface ReviewVerifyResult {
  findings: CritiqueFinding[]
  coverageReport: CoverageReport
  completenessScore: number
  missingAreas: string[]
  recommendation: string
}

function analyzeCodeForFindings(code: string, focusAreas?: string[], depth?: string): CritiqueFinding[] {
  const findings: CritiqueFinding[] = []
  const lines = code.split("\n")

  const patterns: Record<string, Array<{ regex: RegExp; message: string }>> = {
    logic: [
      { regex: /\b(if|for|while|switch)\s*\([^)]*\)\s*\{?/, message: "Potential control flow issue" },
      { regex: /\belse\s*$/, message: "Unmatched else statement" },
    ],
    security: [
      { regex: /\b(eval|exec|spawn)\s*\(/, message: "Potential code injection risk" },
      { regex: /\b(password|secret|apiKey|token|auth)\s*[:=]/i, message: "Potential hardcoded secret detected" },
      { regex: /\b(sql|SQL)\s*['"`]/i, message: "Potential SQL injection risk" },
    ],
    performance: [
      { regex: /\bfor\s*\(\s*let\s+\w+\s+in\s+/, message: "Consider using for-of instead of for-in for arrays" },
      {
        regex: /\.map\s*\(\s*\w+\s*=>\s*\{[^}]*\}\s*\)/,
        message: "Consider if map is needed or if forEach would suffice",
      },
    ],
    maintainability: [
      { regex: /\bfunction\s+[a-z][A-Za-z0-9_]*[A-Z][A-Za-z0-9_]*/, message: "Function name should use camelCase" },
      { regex: /\/\/\s*TODO|\/\*\s*TODO/, message: "TODO comment found - needs follow-up" },
      { regex: /function\s+\w+\s*\([^)]{50,}\)/, message: "Function has too many parameters" },
    ],
    correctness: [
      { regex: /\bundefined\b/, message: "Potential undefined reference" },
      { regex: /===?\s*null\s*===?/, message: "Consider using nullish coalescing or optional chaining" },
      { regex: /\bcatch\s*\(\s*\)\s*\{/, message: "Empty catch block - errors are silently ignored" },
    ],
  }

  const categoriesToCheck = focusAreas
    ? (focusAreas as Array<keyof typeof patterns>)
    : (Object.keys(patterns) as Array<keyof typeof patterns>)

  const depthMultiplier = depth === "shallow" ? 0.3 : depth === "thorough" ? 1.5 : 1

  for (const [index, line] of lines.entries()) {
    if (!line.trim() || line.trim().startsWith("//") || line.trim().startsWith("/*")) continue

    for (const category of categoriesToCheck) {
      const categoryPatterns = patterns[category]
      if (!categoryPatterns) continue

      for (const pattern of categoryPatterns) {
        if (pattern.regex.test(line)) {
          const severity = category === "security" || category === "correctness" ? "warning" : "info"
          const adjustedSeverity =
            depth === "thorough"
              ? severity === "warning"
                ? "error"
                : severity === "info"
                  ? "warning"
                  : severity
              : severity

          if (Math.random() < depthMultiplier || depth === "thorough") {
            findings.push(
              createCritiqueFinding(
                category as CritiqueCategory,
                `${pattern.message} at line ${index + 1}`,
                adjustedSeverity as CritiqueFinding["severity"],
                `Line ${index + 1}: ${line.trim().substring(0, 50)}`,
              ),
            )
          }
        }
      }
    }
  }

  if (code.trim() && findings.length === 0) {
    findings.push(
      createCritiqueFinding(
        "correctness",
        "Code review completed with no significant issues found",
        "info",
        undefined,
        "No immediate issues detected in the provided code changes",
      ),
    )
  }

  return findings
}

function calculateCoverage(
  findings: CritiqueFinding[],
  reviewComments?: string[],
  focusAreas?: string[],
): { report: CoverageReport; missing: string[] } {
  const categories: Array<keyof CoverageReport> = ["logic", "security", "performance", "maintainability", "correctness"]

  const covered = new Set(findings.map((f) => f.category))

  if (reviewComments) {
    for (const comment of reviewComments) {
      const lowerComment = comment.toLowerCase()
      if (lowerComment.includes("logic")) covered.add("logic")
      if (lowerComment.includes("security")) covered.add("security")
      if (lowerComment.includes("performance")) covered.add("performance")
      if (lowerComment.includes("maintain")) covered.add("maintainability")
      if (lowerComment.includes("correct") || lowerComment.includes("bug") || lowerComment.includes("fix"))
        covered.add("correctness")
    }
  }

  const report: CoverageReport = {
    logic: covered.has("logic"),
    security: covered.has("security"),
    performance: covered.has("performance"),
    maintainability: covered.has("maintainability"),
    correctness: covered.has("correctness"),
  }

  const targetAreas = focusAreas || categories
  const missing = categories.filter((c) => !report[c] && targetAreas.includes(c))

  return { report, missing }
}

function calculateCompleteness(
  coverage: CoverageReport,
  findingsCount: number,
  reviewCommentsCount: number,
  depth?: string,
): number {
  let score = 0

  const coverageValues = Object.values(coverage)
  const coveredCount = coverageValues.filter(Boolean).length
  score += (coveredCount / 5) * 40

  const depthMultiplier = depth === "shallow" ? 0.5 : depth === "thorough" ? 1.2 : 1
  const findingsScore = Math.min(findingsCount * 5 * depthMultiplier, 30)
  score += findingsScore

  const engagementScore = Math.min(reviewCommentsCount * 5, 20)
  score += engagementScore

  if (depth === "thorough") score += 10
  else if (depth === "normal") score += 5

  return Math.min(Math.round(score), 100)
}

function generateRecommendation(
  score: number,
  missingAreas: string[],
  findingsCount: number,
  coverage: CoverageReport,
): string {
  if (score >= 80) {
    return "Review is comprehensive. All major areas have been addressed. Consider final approval."
  }

  if (score >= 60) {
    const missing = missingAreas.join(", ")
    return `Review is good but missing coverage in: ${missing}. Consider addressing these areas.`
  }

  if (findingsCount === 0 && !coverage.logic && !coverage.security) {
    return "Review appears incomplete. No findings or coverage detected. Please provide more detailed review comments."
  }

  const critical = missingAreas.filter((m) => m === "security" || m === "correctness")
  if (critical.length > 0) {
    return `Critical areas not covered: ${critical.join(", ")}. These must be addressed before approval.`
  }

  return "Review needs improvement. Add more detailed analysis in the missing areas."
}

export const ReviewVerifyTool = Tool.define("review_verify", async () => ({
  description:
    "Verifies the completeness and quality of a code review by analyzing code changes, existing review comments, and generating findings across various categories.",
  parameters: ReviewVerifyParameters,
  async execute(params: ReviewVerifyParams) {
    const { codeChanges, reviewComments, focusAreas, reviewDepth } = params

    const findings = analyzeCodeForFindings(codeChanges, focusAreas, reviewDepth)

    const { report: coverageReport, missing: missingAreas } = calculateCoverage(findings, reviewComments, focusAreas)

    const completenessScore = calculateCompleteness(
      coverageReport,
      findings.length,
      reviewComments?.length || 0,
      reviewDepth,
    )

    const recommendation = generateRecommendation(completenessScore, missingAreas, findings.length, coverageReport)

    const result: ReviewVerifyResult = {
      findings,
      coverageReport,
      completenessScore,
      missingAreas,
      recommendation,
    }

    const output = `## Review Verification Results

### Completeness Score: ${completenessScore}%

### Coverage Report
- Logic: ${coverageReport.logic ? "✓" : "✗"}
- Security: ${coverageReport.security ? "✓" : "✗"}
- Performance: ${coverageReport.performance ? "✓" : "✗"}
- Maintainability: ${coverageReport.maintainability ? "✓" : "✗"}
- Correctness: ${coverageReport.correctness ? "✓" : "✗"}

### Findings (${findings.length})
${findings.map((f) => `- [${f.severity.toUpperCase()}] ${f.category}: ${f.description}`).join("\n")}

### Missing Areas
${missingAreas.length > 0 ? missingAreas.join(", ") : "None"}

### Recommendation
${recommendation}`

    return {
      title: `Review Score: ${completenessScore}%`,
      metadata: {
        completenessScore: result.completenessScore,
        findingsCount: result.findings.length,
        missingAreas: result.missingAreas,
      },
      output,
    }
  },
}))
