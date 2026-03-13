import type { Message, Session } from "@opencode-ai/sdk/v2"

export function getRenderableRevertState(
  messages: Pick<Message, "id" | "role">[],
  revert: Session["revert"] | undefined,
) {
  const messageID = revert?.messageID
  if (!messageID) return
  if (!messages.some((message) => message.id === messageID)) return

  return {
    messageID,
    diff: revert.diff,
    reverted: messages.filter((message) => message.id >= messageID && message.role === "user"),
  }
}