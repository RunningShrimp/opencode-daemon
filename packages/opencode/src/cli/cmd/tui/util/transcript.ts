import type { AssistantMessage, Part, UserMessage } from "@opencode-ai/sdk/v2"
import { Locale } from "@/util/locale"

export type TranscriptOptions = {
  thinking: boolean
  toolDetails: boolean
  assistantMetadata: boolean
}

export type SessionInfo = {
  id: string
  title: string
  time: {
    created: number
    updated: number
  }
}

export type MessageWithParts = {
  info: UserMessage | AssistantMessage
  parts: Part[]
}

/**
 * Validate session info
 * @throws Error if session is invalid
 */
function validateSession(session: SessionInfo | undefined | null): asserts session is SessionInfo {
  if (!session) {
    throw new Error("Session is required")
  }
  if (!session.id || typeof session.id !== "string") {
    throw new Error("Session ID is required and must be a string")
  }
  if (!session.title || typeof session.title !== "string") {
    throw new Error("Session title is required and must be a string")
  }
  if (!session.time || typeof session.time !== "object") {
    throw new Error("Session time is required and must be an object")
  }
}

/**
 * Validate messages array
 * @throws Error if messages are invalid
 */
function validateMessages(messages: MessageWithParts[] | undefined | null): asserts messages is MessageWithParts[] {
  if (!messages) {
    throw new Error("Messages array is required")
  }
  if (!Array.isArray(messages)) {
    throw new Error("Messages must be an array")
  }
}

/**
 * Validate transcript options
 * @throws Error if options are invalid
 */
function validateOptions(options: TranscriptOptions | undefined | null): asserts options is TranscriptOptions {
  if (!options) {
    throw new Error("Transcript options are required")
  }
  if (typeof options.thinking !== "boolean") {
    throw new Error("Option 'thinking' must be a boolean")
  }
  if (typeof options.toolDetails !== "boolean") {
    throw new Error("Option 'toolDetails' must be a boolean")
  }
  if (typeof options.assistantMetadata !== "boolean") {
    throw new Error("Option 'assistantMetadata' must be a boolean")
  }
}

/**
 * Escape special characters for safe inclusion in markdown
 * Handles characters that could break markdown formatting
 */
function escapeMarkdown(text: string): string {
  if (!text) return ""
  return text
    .replace(/\\/g, "\\\\")       // Escape backslashes first
    .replace(/`/g, "\\`")         // Escape backticks
    .replace(/\$/g, "\\$")         // Escape dollar signs (for math mode)
    .replace(/\*/g, "\\*")        // Escape asterisks
    .replace(/_/g, "\\_")          // Escape underscores
    .replace(/\[/g, "\\[")        // Escape brackets
    .replace(/\]/g, "\\]")
    .replace(/\(/g, "\\(")
    .replace(/\)/g, "\\)")
    .replace(/\|/g, "\\|")        // Escape pipes
    .replace(/#/g, "\\#")          // Escape headings
}

export function formatTranscript(
  session: SessionInfo,
  messages: MessageWithParts[],
  options: TranscriptOptions,
): string {
  // Validate inputs
  validateSession(session)
  validateMessages(messages)
  validateOptions(options)

  let transcript = `# ${session.title}\n\n`
  transcript += `**Session ID:** ${escapeMarkdown(session.id)}\n`
  transcript += `**Created:** ${new Date(session.time.created).toLocaleString()}\n`
  transcript += `**Updated:** ${new Date(session.time.updated).toLocaleString()}\n\n`
  transcript += `---\n\n`

  for (const msg of messages) {
    transcript += formatMessage(msg.info, msg.parts, options)
    transcript += `---\n\n`
  }

  return transcript
}

export function formatMessage(msg: UserMessage | AssistantMessage, parts: Part[], options: TranscriptOptions): string {
  let result = ""

  if (msg.role === "user") {
    result += `## User\n\n`
  } else {
    result += formatAssistantHeader(msg, options.assistantMetadata)
  }

  for (const part of parts) {
    result += formatPart(part, options)
  }

  return result
}

export function formatAssistantHeader(msg: AssistantMessage, includeMetadata: boolean): string {
  if (!includeMetadata) {
    return `## Assistant\n\n`
  }

  const duration =
    msg.time.completed && msg.time.created ? ((msg.time.completed - msg.time.created) / 1000).toFixed(1) + "s" : ""

  return `## Assistant (${Locale.titlecase(msg.agent)} · ${msg.modelID}${duration ? ` · ${duration}` : ""})\n\n`
}

export function formatPart(part: Part, options: TranscriptOptions): string {
  if (part.type === "text" && !part.synthetic) {
    return `${part.text}\n\n`
  }

  if (part.type === "reasoning") {
    if (options.thinking) {
      return `_Thinking:_\n\n${part.text}\n\n`
    }
    return ""
  }

  if (part.type === "tool") {
    let result = `**Tool: ${escapeMarkdown(part.tool)}**\n`
    if (options.toolDetails && part.state.input) {
      // JSON.stringify handles the escaping for JSON content
      const escapedInput = JSON.stringify(part.state.input, null, 2)
      result += `\n**Input:**\n\`\`\`json\n${escapedInput}\n\`\`\`\n`
    }
    if (options.toolDetails && part.state.status === "completed" && part.state.output) {
      // Escape markdown special characters in tool output
      const escapedOutput = escapeMarkdown(String(part.state.output))
      result += `\n**Output:**\n\`\`\`\n${escapedOutput}\n\`\`\`\n`
    }
    if (options.toolDetails && part.state.status === "error" && part.state.error) {
      // Escape markdown special characters in error messages
      const escapedError = escapeMarkdown(String(part.state.error))
      result += `\n**Error:**\n\`\`\`\n${escapedError}\n\`\`\`\n`
    }
    result += `\n`
    return result
  }

  return ""
}
