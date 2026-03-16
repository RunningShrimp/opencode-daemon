export type TaskIntent =
  | { type: "review"; target: string; scope: "code" | "security" | "performance" | "general" }
  | { type: "implementation"; description: string; complexity: "simple" | "moderate" | "complex" }
  | { type: "exploration"; query: string; mode: "lookup" | "question" }
  | { type: "debugging"; error: string }
  | { type: "unknown" }

const REVIEW_KEYWORDS = [
  "review",
  "audit",
  "code review",
  "security review",
  "performance review",
] as const

const REVIEW_HINTS = ["inspect", "assess", "check"] as const
const SECURITY_HINTS = ["security", "vulnerability", "secure", "safe"] as const

const COMPLEXITY_INDICATORS = {
  simple: ["fix", "add", "remove", "update simple"],
  moderate: ["implement", "refactor", "improve", "optimize"],
  complex: ["architect", "redesign", "rebuild", "multi-step"],
} as const

const DEBUGGING_KEYWORDS = ["error", "bug", "fix", "crash", "exception", "failed"] as const

const QUESTION_PREFIXES = [
  "what",
  "why",
  "how",
  "which",
  "where",
  "when",
  "who",
  "can",
  "could",
  "would",
  "should",
  "is",
  "are",
  "do",
  "does",
  "did",
  "will",
  "tell me",
  "explain",
  "summarize",
  "compare",
  "calculate",
  "compute",
  "solve",
] as const

const CHANGE_ACTION_HINTS = [
  "add",
  "build",
  "change",
  "create",
  "edit",
  "implement",
  "improve",
  "make",
  "modify",
  "optimize",
  "patch",
  "refactor",
  "redesign",
  "remove",
  "rewrite",
  "update",
  "upgrade",
] as const

const FILE_OR_CODE_SCOPE_HINT = /[./][a-z0-9_-]+|src\/|packages\/|README|docs\//i
const SIMPLE_MATH_PATTERN = /(^|\b)(\d+(?:\.\d+)?)\s*([+\-*/x×])\s*(\d+(?:\.\d+)?)(\b|$)/i

function extractTarget(prompt: string): string {
  const lower = prompt.toLowerCase()
  for (const keyword of REVIEW_KEYWORDS) {
    const idx = lower.indexOf(keyword)
    if (idx !== -1) {
      return prompt.slice(idx + keyword.length).trim()
    }
  }
  return prompt
}

function extractError(prompt: string): string {
  const lower = prompt.toLowerCase()

  const errorIdx = lower.indexOf("error")
  if (errorIdx !== -1) {
    const beforeError = prompt.slice(0, errorIdx).trim()
    const afterError = prompt.slice(errorIdx + 5).trim()
    if (beforeError) {
      const words = beforeError.split(/\s+/)
      const errorType = words.slice(-3).join(" ")
      return errorType + " error" + (afterError ? " " + afterError : "")
    }
    return afterError || prompt
  }

  const bugIdx = lower.indexOf("bug")
  if (bugIdx !== -1) {
    let remainder = prompt.slice(bugIdx + 3).trim()
    if (remainder.toLowerCase().startsWith("in ")) {
      remainder = remainder.slice(3)
    }
    return remainder || prompt
  }

  const exceptionIdx = lower.indexOf("exception")
  if (exceptionIdx !== -1) {
    const beforeException = prompt.slice(0, exceptionIdx).trim()
    const words = beforeException.split(/\s+/)
    let startIdx = 0
    for (let i = words.length - 1; i >= 0; i--) {
      const w = words[i].toLowerCase()
      if (w === "the" || w === "a" || w === "an") {
        startIdx = i
        break
      }
      startIdx = i
    }
    const errorPhrase = words.slice(startIdx).join(" ") + " exception"
    return errorPhrase
  }

  const patterns = ["crash", "failed"]
  for (const pattern of patterns) {
    const idx = lower.indexOf(pattern)
    if (idx !== -1) {
      return prompt.slice(idx + pattern.length).trim() || prompt
    }
  }

  return prompt
}

function detectScope(prompt: string): "code" | "security" | "performance" | "general" {
  const lower = prompt.toLowerCase()
  if (
    lower.includes("security") ||
    lower.includes("vulnerability") ||
    lower.includes("safe") ||
    lower.includes("secure")
  ) {
    return "security"
  }
  if (lower.includes("performance") || lower.includes("speed") || lower.includes("slow")) {
    return "performance"
  }
  if (
    lower.includes("code quality") ||
    lower.includes("code review") ||
    lower.includes("code implementation") ||
    lower.includes("implementation review") ||
    lower.includes("validate the code")
  ) {
    return "code"
  }
  return "general"
}

function detectComplexity(prompt: string): "simple" | "moderate" | "complex" {
  const lower = prompt.toLowerCase()
  for (const indicator of COMPLEXITY_INDICATORS.complex) {
    if (lower.includes(indicator)) return "complex"
  }
  for (const indicator of COMPLEXITY_INDICATORS.moderate) {
    if (lower.includes(indicator)) return "moderate"
  }
  for (const indicator of COMPLEXITY_INDICATORS.simple) {
    if (lower.includes(indicator)) return "simple"
  }
  return "moderate"
}

function detectReviewIntent(prompt: string): TaskIntent | null {
  const lower = prompt.toLowerCase()
  for (const keyword of REVIEW_KEYWORDS) {
    if (lower.includes(keyword)) {
      return {
        type: "review",
        target: extractTarget(prompt),
        scope: detectScope(prompt),
      }
    }
  }

  if (SECURITY_HINTS.some((keyword) => lower.includes(keyword)) && REVIEW_HINTS.some((keyword) => lower.includes(keyword))) {
    return {
      type: "review",
      target: extractTarget(prompt),
      scope: "security",
    }
  }

  if (lower.includes("performance") && REVIEW_HINTS.some((keyword) => lower.includes(keyword))) {
    return {
      type: "review",
      target: extractTarget(prompt),
      scope: "performance",
    }
  }

  return null
}

function detectDebuggingIntent(prompt: string): TaskIntent | null {
  const lower = prompt.toLowerCase()
  if (DEBUGGING_KEYWORDS.some((k) => lower.includes(k))) {
    return {
      type: "debugging",
      error: extractError(prompt),
    }
  }
  return null
}

function detectExplorationIntent(prompt: string): TaskIntent | null {
  const lower = prompt.toLowerCase()
  const explorationPatterns = [
    { pattern: "explore", len: 7 },
    { pattern: "find where", len: 10 },
    { pattern: "search for", len: 10 },
    { pattern: "show me", len: 7 },
    { pattern: "show ", len: 5 },
  ]
  for (const { pattern, len } of explorationPatterns) {
    if (lower.startsWith(pattern) || lower.includes(" " + pattern)) {
      const idx = lower.indexOf(pattern)
      const query = prompt.slice(idx + len).trim()
      return {
        type: "exploration",
        query: query || prompt,
        mode: "lookup",
      }
    }
  }
  return null
}

function detectQuestionIntent(prompt: string): TaskIntent | null {
  const trimmed = prompt.trim()
  if (!trimmed) return null

  const lower = trimmed.toLowerCase()
  const startsLikeQuestion = QUESTION_PREFIXES.some((prefix) => lower.startsWith(prefix + " "))
  const endsLikeQuestion = trimmed.endsWith("?") || /[？]$/.test(trimmed)
  const looksLikeSimpleMath = SIMPLE_MATH_PATTERN.test(trimmed)
  if (!startsLikeQuestion && !endsLikeQuestion && !looksLikeSimpleMath) return null

  if (CHANGE_ACTION_HINTS.some((hint) => lower.includes(hint))) return null
  if (FILE_OR_CODE_SCOPE_HINT.test(trimmed) && !endsLikeQuestion) return null

  return {
    type: "exploration",
    query: trimmed,
    mode: "question",
  }
}

function detectImplementationIntent(prompt: string): TaskIntent {
  let description = prompt
  const lower = prompt.toLowerCase()
  if (lower.startsWith("create ")) {
    description = prompt.slice(7)
  }
  return {
    type: "implementation",
    description,
    complexity: detectComplexity(prompt),
  }
}

function detect(prompt: string): TaskIntent {
  const debug = detectDebuggingIntent(prompt)
  if (debug) return debug

  const review = detectReviewIntent(prompt)
  if (review) return review

  const exploration = detectExplorationIntent(prompt)
  if (exploration) return exploration

  const question = detectQuestionIntent(prompt)
  if (question) return question

  return detectImplementationIntent(prompt)
}

export const IntentDetection = {
  REVIEW_KEYWORDS,
  COMPLEXITY_INDICATORS,
  detect,
}
