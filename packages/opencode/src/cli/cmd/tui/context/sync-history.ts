import type { Message, Part } from "@opencode-ai/sdk/v2"

export type SessionHistoryPageItem = {
  info: Message
  parts: Part[]
}

export type PreloadedSessionHistoryPage = SessionHistoryPageItem[]

export function mergeSessionHistoryPage(input: {
  existingMessages: Message[]
  incomingMessages: SessionHistoryPageItem[]
}) {
  const existing = new Set(input.existingMessages.map((message) => message.id))
  const prepend: Message[] = []
  const parts: Record<string, Part[]> = {}

  for (const item of input.incomingMessages) {
    parts[item.info.id] = item.parts
    if (!existing.has(item.info.id)) {
      prepend.push(item.info)
    }
  }

  return {
    messages: [...prepend, ...input.existingMessages],
    parts,
  }
}

export function getSessionHistoryHasMore(input: {
  preloadedPages: PreloadedSessionHistoryPage[]
  nextCursor?: string
}) {
  return input.preloadedPages.length > 0 || !!input.nextCursor
}

export function consumePreloadedSessionHistoryPage(input: {
  existingMessages: Message[]
  preloadedPages: PreloadedSessionHistoryPage[]
  nextCursor?: string
}) {
  const [page, ...remainingPages] = input.preloadedPages
  if (!page) return undefined

  const merged = mergeSessionHistoryPage({
    existingMessages: input.existingMessages,
    incomingMessages: page,
  })

  return {
    messages: merged.messages,
    parts: merged.parts,
    preloadedPages: remainingPages,
    hasMore: getSessionHistoryHasMore({
      preloadedPages: remainingPages,
      nextCursor: input.nextCursor,
    }),
  }
}

function hasRenderableUserContent(parts: Part[]) {
  return parts.some((part) => {
    if (part.type === "compaction") return true
    if (part.type !== "text") return false
    if (part.synthetic) return false
    return part.text.trim().length > 0
  })
}

function hasRenderableAssistantContent(parts: Part[]) {
  return parts.some((part) => {
    if (part.type === "text") return part.text.trim().length > 0
    if (part.type === "reasoning") return part.text.replace("[REDACTED]", "").trim().length > 0
    if (part.type !== "tool") return false
    if (part.state.status !== "pending" && part.state.metadata?.internal === true) return false
    return true
  })
}

export function hasRenderableMessageContent(message: Message, parts: Part[] = []) {
  if (message.role === "user") return hasRenderableUserContent(parts)
  if (message.role === "assistant") return hasRenderableAssistantContent(parts)
  return false
}

export function countRenderableMessages(
  messages: Message[],
  partsByMessage: Record<string, Part[] | undefined>,
) {
  return messages.reduce((count, message) => {
    return count + (hasRenderableMessageContent(message, partsByMessage[message.id] ?? []) ? 1 : 0)
  }, 0)
}

export function getPrependedHistoryRestoreScrollY(input: {
  requestedSessionID: string
  activeSessionID: string
  previousY: number
  previousScrollHeight: number
  nextScrollHeight: number
}) {
  if (input.requestedSessionID !== input.activeSessionID) return undefined
  const delta = Math.max(0, input.nextScrollHeight - input.previousScrollHeight)
  return input.previousY + delta
}

export function shouldAutoLoadMoreHistoryAtTop(input: {
  hasMore: boolean
  historyLoading: boolean
  historyPreloading: boolean
  localLoading: boolean
  pendingSessionSwitchAlign: boolean
  scrollY: number
  scrollHeight: number
  viewportHeight: number
}) {
  if (!input.hasMore) return false
  if (input.historyLoading || input.historyPreloading || input.localLoading) return false
  if (input.pendingSessionSwitchAlign) return false
  if (input.scrollHeight <= input.viewportHeight) return false
  return input.scrollY <= 2
}

export function getSessionSwitchBottomAlignAction(input: {
  historyLoading: boolean
  messageCount: number
  renderableCount: number
  hasMore: boolean
}) {
  if (input.historyLoading) return "wait" as const
  if (input.messageCount === 0) {
    return input.hasMore ? ("wait" as const) : ("settle" as const)
  }
  if (input.renderableCount === 0 && input.hasMore) return "wait" as const
  return "align" as const
}