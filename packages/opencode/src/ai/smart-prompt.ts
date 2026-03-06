import { Log } from "@/util/log"

const log = Log.create({ service: "smart-prompt" })

export interface SmartPromptConfig {
  basePrompt: string
  enableEvidenceTracking: boolean
  enableSelfCritique: boolean
  enablePessimisticCheck: boolean
  enableProductionCheck: boolean
  pessimisticSeverity: "strict" | "normal" | "relaxed"
  context?: {
    files?: string[]
    previousFindings?: Array<{ severity: string; description: string }>
    evidence?: Array<{ content: string; relevance: number }>
  }
}

export interface GeneratedPrompt {
  systemPrompt: string
  userPrompt: string
  thinkingGuidance: string[]
}

export function generateSmartPrompt(config: SmartPromptConfig): GeneratedPrompt {
  const { basePrompt, context } = config

  const systemPromptParts: string[] = []
  const userPromptParts: string[] = [basePrompt]
  const thinkingGuidance: string[] = []

  if (config.enableEvidenceTracking) {
    systemPromptParts.push(generateEvidenceInstructions())
    thinkingGuidance.push(
      "Collect and cite evidence from searches, codebase analysis, and tool results",
      "Ensure each claim is backed by relevant evidence with source attribution",
    )
  }

  if (config.enableSelfCritique) {
    systemPromptParts.push(generateSelfCritiqueInstructions())
    thinkingGuidance.push(
      "Critique your own output before finalizing",
      "Identify potential issues and areas for improvement",
    )
  }

  if (config.enablePessimisticCheck) {
    systemPromptParts.push(generatePessimisticCheckInstructions(config.pessimisticSeverity))
    thinkingGuidance.push(
      "Consider worst-case scenarios and potential failure modes",
      "Evaluate edge cases and error conditions",
    )
  }

  if (config.enableProductionCheck) {
    systemPromptParts.push(generateProductionGradeInstructions())
    thinkingGuidance.push(
      "Ensure code meets production standards: error handling, logging, tests",
      "Verify security, performance, and maintainability",
    )
  }

  if (context?.files && context.files.length > 0) {
    userPromptParts.push(`\n\nRelevant files to analyze:\n${context.files.map((f) => `- ${f}`).join("\n")}`)
  }

  if (context?.previousFindings && context.previousFindings.length > 0) {
    const findingsSummary = context.previousFindings
      .map((f) => `- [${f.severity.toUpperCase()}] ${f.description}`)
      .join("\n")
    userPromptParts.push(`\n\nPrevious findings to address:\n${findingsSummary}`)
  }

  if (context?.evidence && context.evidence.length > 0) {
    const evidenceSummary = context.evidence
      .slice(0, 5)
      .map((e) => `- ${e.content.slice(0, 100)}... (relevance: ${e.relevance})`)
      .join("\n")
    userPromptParts.push(`\n\nEvidence collected:\n${evidenceSummary}`)
  }

  return {
    systemPrompt: systemPromptParts.join("\n\n"),
    userPrompt: userPromptParts.join("\n"),
    thinkingGuidance,
  }
}

export function generateEvidenceInstructions(): string {
  return `## Evidence Tracking

When making claims or conclusions, you MUST:
1. Collect evidence from searches, codebase analysis, and tool results
2. Cite specific sources with file paths, line numbers, or search results
3. Rate evidence relevance (0-1 scale) based on how directly it supports your claim
4. Track at least 1 piece(s) of relevant evidence for important conclusions

Evidence types to collect:
- Search results from grep, glob, or web searches
- Code snippets from file reads
- Tool execution results
- Web fetch content
- Previous session context`
}

export function generateSelfCritiqueInstructions(): string {
  return `## Self-Critique

Before providing your final output, critically examine it against these criteria:
1. Does the solution correctly solve the task?
2. Are there any security vulnerabilities or risks?
3. Is the code performant and efficient?
4. Is the code maintainable and follows best practices?
5. Are error cases and edge cases handled properly?
6. Is the documentation complete and accurate?

If issues are found, revise your output before presenting it.`
}

export function generatePessimisticCheckInstructions(severity: string): string {
  const instructions: Record<string, string> = {
    strict: `## Pessimistic Check (Strict Mode)

You MUST actively seek out ways your solution could fail:
1. Identify at least 3 potential failure modes or edge cases
2. For each failure, assess likelihood (rare/unlikely/likely/certain) and impact
3. Provide mitigation strategies for high-likelihood or high-impact failures
4. Question your assumptions and consider alternative interpretations
5. Be skeptical of results that seem too good to be true`,
    normal: `## Pessimistic Check (Normal Mode)

Consider potential issues with your approach:
1. Think about edge cases and boundary conditions
2. Identify potential failure points in your solution
3. Consider what could go wrong in production
4. Evaluate alternative approaches and their tradeoffs`,
    relaxed: `## Pessimistic Check (Relaxed Mode)

Be aware of potential issues:
1. Consider common pitfalls and edge cases
2. Think about error handling and robustness
3. Review your solution for obvious issues`,
  }

  return instructions[severity] || instructions.normal
}

export function generateProductionGradeInstructions(): string {
  return `## Production-Grade Requirements

Your output must meet production standards:

**Error Handling:**
- Handle all error cases gracefully
- Provide meaningful error messages
- Use appropriate error types

**Security:**
- Validate all inputs
- Avoid security vulnerabilities (injection, XSS, etc.)
- Follow security best practices

**Performance:**
- Consider time and space complexity
- Optimize hot paths
- Avoid unnecessary computations

**Testing:**
- Include appropriate test coverage
- Test edge cases
- Ensure tests are meaningful

**Documentation:**
- Document public APIs
- Explain complex logic
- Keep docs in sync with code

**Logging:**
- Add appropriate logging for debugging
- Log important events
- Avoid sensitive data in logs

**Maintainability:**
- Follow code style conventions
- Write clean, readable code
- Use meaningful names`
}
