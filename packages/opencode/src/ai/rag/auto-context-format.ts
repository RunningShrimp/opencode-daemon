import type { GroundingEvidence } from "./evidence"

export function extractAutoGroundingQueryFromParts(
  parts: Array<{ type: string; text?: string; synthetic?: boolean; ignored?: boolean }>,
) {
  return parts
    .filter((part) => part.type === "text" && !part.synthetic && !part.ignored && typeof part.text === "string")
    .map((part) => part.text!.trim())
    .filter(Boolean)
    .join("\n")
    .trim()
}

export function shouldAutoGroundQuery(query: string) {
  const normalized = query.replace(/\s+/g, " ").trim()
  if (!normalized) return false
  if (normalized.length < 18) return false
  if (normalized.startsWith("<system-reminder>")) return false
  if (/^\/[a-z0-9_-]+(?:\s|$)/i.test(normalized)) return false

  const signal = normalized.replace(/[^\p{L}\p{N}]+/gu, "")
  return signal.length >= 10
}

export function formatAutoGroundingSystemPrompt(query: string, evidence: GroundingEvidence[]) {
  const lines = [
    "<retrieved_context>",
    `Project-local context for the current request: ${query}`,
    "Use this as grounding evidence when it is relevant, and prefer citing these files and line ranges over unsupported assumptions.",
  ]

  evidence.forEach((item, index) => {
    const range =
      typeof item.startLine === "number"
        ? `${item.startLine}${typeof item.endLine === "number" && item.endLine !== item.startLine ? `-${item.endLine}` : ""}`
        : undefined
    lines.push("")
    lines.push(`[${index + 1}] ${item.filePath}${range ? `:${range}` : ""} score=${item.score.toFixed(2)}`)
    lines.push(item.content.slice(0, 400))
  })

  lines.push("</retrieved_context>")
  return lines.join("\n")
}