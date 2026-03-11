import { CritiqueCategory, createCritiqueFinding, type CritiqueFinding } from "./cr"

export interface SelfCritiqueInput {
  task: string
  output: string
  context?: string
}

export interface SelfCritiqueOutput {
  critique: string
  worstCaseScenarios: Array<{
    scenario: string
    likelihood: "low" | "medium" | "high"
    impact: "low" | "medium" | "high"
    mitigation?: string
  }>
  improvements: string[]
  verdict: "pass" | "needs_revision" | "fail"
}

export const DEFAULT_CRITERIA = [
  "Does the output correctly solve the task?",
  "Are there any security vulnerabilities?",
  "Is the code performant?",
  "Is the code maintainable?",
  "Are error cases handled properly?",
  "Are there adequate tests?",
  "Is the documentation complete?",
  "Does the code follow style conventions?",
]

export function generateDefaultCritiques(input: SelfCritiqueInput): string[] {
  return DEFAULT_CRITERIA.map((criterion) => {
    return `${criterion}\n\nAnalysis for "${input.task}":\n- Evidence from output: ${input.output.slice(0, 200)}...\n- Context: ${input.context || "No additional context"}\n- Assessment: `
  })
}

export function calculateVerdict(
  criticalCount: number,
  errorCount: number,
  warningCount: number,
): SelfCritiqueOutput["verdict"] {
  if (criticalCount > 0 || errorCount > 2) return "fail"
  if (errorCount > 0 || warningCount > 3) return "needs_revision"
  return "pass"
}

export function createSelfCritiqueOutput(
  _input: SelfCritiqueInput,
  critique: string,
  improvements: string[],
  verdict: SelfCritiqueOutput["verdict"],
): SelfCritiqueOutput {
  const worstCaseScenarios: SelfCritiqueOutput["worstCaseScenarios"] = []

  worstCaseScenarios.push({
    scenario: "Code introduces security vulnerabilities",
    likelihood: "low",
    impact: "high",
    mitigation: "Use parameterized queries, validate inputs, follow security best practices",
  })

  worstCaseScenarios.push({
    scenario: "Code breaks existing functionality",
    likelihood: "medium",
    impact: "high",
    mitigation: "Run existing tests, verify backward compatibility",
  })

  worstCaseScenarios.push({
    scenario: "Code causes performance degradation",
    likelihood: "low",
    impact: "medium",
    mitigation: "Profile performance, optimize hot paths",
  })

  return {
    critique,
    worstCaseScenarios,
    improvements,
    verdict,
  }
}

export function convertCritiqueToFindings(critique: string): CritiqueFinding[] {
  const findings: CritiqueFinding[] = []

  if (critique.toLowerCase().includes("security")) {
    findings.push(
      createCritiqueFinding(
        CritiqueCategory.enum.security,
        "Security concerns identified in the output",
        "warning",
        undefined,
        critique,
      ),
    )
  }

  if (critique.toLowerCase().includes("error") || critique.toLowerCase().includes("bug")) {
    findings.push(
      createCritiqueFinding(
        CritiqueCategory.enum.correctness,
        "Potential correctness issues identified",
        "error",
        undefined,
        critique,
      ),
    )
  }

  if (critique.toLowerCase().includes("performance") || critique.toLowerCase().includes("slow")) {
    findings.push(
      createCritiqueFinding(
        CritiqueCategory.enum.performance,
        "Performance concerns identified",
        "warning",
        undefined,
        critique,
      ),
    )
  }

  if (findings.length === 0) {
    findings.push(
      createCritiqueFinding(CritiqueCategory.enum.other, "General review completed", "info", undefined, critique),
    )
  }

  return findings
}

export class SelfCritiqueEngine {
  private criteria: string[] = [...DEFAULT_CRITERIA]

  constructor(customCriteria?: string[]) {
    if (customCriteria && customCriteria.length > 0) {
      this.criteria = customCriteria
    }
  }

  critique(input: SelfCritiqueInput): SelfCritiqueOutput {
    const critiques = generateDefaultCritiques(input)
    const allFindings: CritiqueFinding[] = []

    let criticalCount = 0
    let errorCount = 0
    let warningCount = 0

    for (const critiqueText of critiques) {
      const findings = convertCritiqueToFindings(critiqueText)
      allFindings.push(...findings)

      for (const finding of findings) {
        if (finding.severity === "critical") criticalCount++
        else if (finding.severity === "error") errorCount++
        else if (finding.severity === "warning") warningCount++
      }
    }

    const verdict = calculateVerdict(criticalCount, errorCount, warningCount)
    const improvements = this.generateImprovements(allFindings)

    return createSelfCritiqueOutput(input, critiques.join("\n\n"), improvements, verdict)
  }

  private generateImprovements(findings: CritiqueFinding[]): string[] {
    const improvements: string[] = []

    for (const finding of findings) {
      if (finding.suggestion) {
        improvements.push(finding.suggestion)
      }
      if (finding.fixSuggestion) {
        improvements.push(finding.fixSuggestion)
      }
    }

    if (improvements.length === 0) {
      improvements.push("Review findings and apply appropriate fixes")
    }

    return [...new Set(improvements)]
  }

  getCriteria(): string[] {
    return [...this.criteria]
  }

  addCriterion(criterion: string): void {
    this.criteria.push(criterion)
  }
}
