import { describe, expect, test } from "bun:test"
import {
  consumePreloadedSessionHistoryPage,
  countRenderableMessages,
  getSessionSwitchBottomAlignAction,
  getPrependedHistoryRestoreScrollY,
  getSessionHistoryHasMore,
  hasRenderableMessageContent,
  mergeSessionHistoryPage,
  shouldAutoLoadMoreHistoryAtTop,
} from "../cli/cmd/tui/context/sync-history"
import { messageID, partID, sessionID } from "../test-helpers/ids"

describe("mergeSessionHistoryPage", () => {
  test("prepends older messages and collects their parts", () => {
    const existing = [
      {
        id: messageID("msg_current"),
        sessionID: sessionID("ses_1"),
        role: "assistant",
        time: { created: 20, completed: 21 },
      },
    ] as any

    const merged = mergeSessionHistoryPage({
      existingMessages: existing,
      incomingMessages: [
        {
          info: {
            id: messageID("msg_old"),
            sessionID: sessionID("ses_1"),
            role: "user",
            time: { created: 10 },
          } as any,
          parts: [
            {
              id: partID("part_old"),
              sessionID: sessionID("ses_1"),
              messageID: messageID("msg_old"),
              type: "text",
              text: "older",
            } as any,
          ],
        },
      ],
    })

    expect(merged.messages.map((message) => String(message.id))).toEqual(["msg_old", "msg_current"])
    expect(merged.parts[String(messageID("msg_old"))]?.[0]?.type).toBe("text")
  })

  test("does not duplicate messages already loaded", () => {
    const existing = [
      {
        id: messageID("msg_old"),
        sessionID: sessionID("ses_1"),
        role: "user",
        time: { created: 10 },
      },
      {
        id: messageID("msg_current"),
        sessionID: sessionID("ses_1"),
        role: "assistant",
        time: { created: 20, completed: 21 },
      },
    ] as any

    const merged = mergeSessionHistoryPage({
      existingMessages: existing,
      incomingMessages: [
        {
          info: existing[0],
          parts: [
            {
              id: partID("part_old_reloaded"),
              sessionID: sessionID("ses_1"),
              messageID: messageID("msg_old"),
              type: "text",
              text: "older reloaded",
            } as any,
          ],
        },
      ],
    })

    expect(merged.messages.map((message) => String(message.id))).toEqual(["msg_old", "msg_current"])
    expect((merged.parts[String(messageID("msg_old"))]?.[0] as any)?.text).toBe("older reloaded")
  })

  test("treats synthetic reminder windows as non-renderable", () => {
    const syntheticUser = {
      id: messageID("msg_user"),
      sessionID: sessionID("ses_1"),
      role: "user",
      time: { created: 10 },
    } as any
    const internalAssistant = {
      id: messageID("msg_assistant"),
      sessionID: sessionID("ses_1"),
      role: "assistant",
      finish: "unknown",
      time: { created: 11 },
    } as any

    const partsByMessage = {
      [String(syntheticUser.id)]: [
        {
          id: partID("part_synthetic"),
          sessionID: sessionID("ses_1"),
          messageID: syntheticUser.id,
          type: "text",
          text: "Continue autonomously",
          synthetic: true,
        } as any,
      ],
      [String(internalAssistant.id)]: [
        {
          id: partID("part_internal"),
          sessionID: sessionID("ses_1"),
          messageID: internalAssistant.id,
          type: "tool",
          tool: "self_driven",
          state: {
            status: "completed",
            metadata: {
              internal: true,
            },
          },
        } as any,
      ],
    }

    expect(hasRenderableMessageContent(syntheticUser, partsByMessage[String(syntheticUser.id)])).toBeFalse()
    expect(hasRenderableMessageContent(internalAssistant, partsByMessage[String(internalAssistant.id)])).toBeFalse()
    expect(countRenderableMessages([syntheticUser, internalAssistant], partsByMessage)).toBe(0)
  })

  test("counts visible user and assistant content as renderable", () => {
    const user = {
      id: messageID("msg_user_visible"),
      sessionID: sessionID("ses_1"),
      role: "user",
      time: { created: 10 },
    } as any
    const assistant = {
      id: messageID("msg_assistant_visible"),
      sessionID: sessionID("ses_1"),
      role: "assistant",
      finish: "stop",
      time: { created: 11, completed: 12 },
    } as any

    const partsByMessage = {
      [String(user.id)]: [
        {
          id: partID("part_user_visible"),
          sessionID: sessionID("ses_1"),
          messageID: user.id,
          type: "text",
          text: "real prompt",
          synthetic: false,
        } as any,
      ],
      [String(assistant.id)]: [
        {
          id: partID("part_assistant_visible"),
          sessionID: sessionID("ses_1"),
          messageID: assistant.id,
          type: "text",
          text: "real answer",
        } as any,
      ],
    }

    expect(countRenderableMessages([user, assistant], partsByMessage)).toBe(2)
  })

  test("does not restore prepended-history scroll position after switching to another session", () => {
    expect(
      getPrependedHistoryRestoreScrollY({
        requestedSessionID: "ses_previous",
        activeSessionID: "ses_current",
        previousY: 2,
        previousScrollHeight: 50,
        nextScrollHeight: 90,
      }),
    ).toBeUndefined()
  })

  test("restores prepended-history scroll position when the session is unchanged", () => {
    expect(
      getPrependedHistoryRestoreScrollY({
        requestedSessionID: "ses_current",
        activeSessionID: "ses_current",
        previousY: 2,
        previousScrollHeight: 50,
        nextScrollHeight: 90,
      }),
    ).toBe(42)
  })

  test("consumes the oldest preloaded page before requesting older network history", () => {
    const current = [
      {
        id: messageID("msg_current"),
        sessionID: sessionID("ses_1"),
        role: "assistant",
        time: { created: 30 },
      },
    ] as any

    const consumed = consumePreloadedSessionHistoryPage({
      existingMessages: current,
      preloadedPages: [
        [
          {
            info: {
              id: messageID("msg_page_2"),
              sessionID: sessionID("ses_1"),
              role: "user",
              time: { created: 20 },
            } as any,
            parts: [
              {
                id: partID("part_page_2"),
                sessionID: sessionID("ses_1"),
                messageID: messageID("msg_page_2"),
                type: "text",
                text: "page two",
              } as any,
            ],
          },
        ],
        [
          {
            info: {
              id: messageID("msg_page_3"),
              sessionID: sessionID("ses_1"),
              role: "user",
              time: { created: 10 },
            } as any,
            parts: [
              {
                id: partID("part_page_3"),
                sessionID: sessionID("ses_1"),
                messageID: messageID("msg_page_3"),
                type: "text",
                text: "page three",
              } as any,
            ],
          },
        ],
      ],
      nextCursor: "cursor:older",
    })

    expect(consumed?.messages.map((message) => String(message.id))).toEqual(["msg_page_2", "msg_current"])
    expect(consumed?.preloadedPages).toHaveLength(1)
    expect(consumed?.hasMore).toBeTrue()
  })

  test("reports more history while hidden preloaded pages still exist", () => {
    expect(
      getSessionHistoryHasMore({
        preloadedPages: [[] as any],
        nextCursor: undefined,
      }),
    ).toBeTrue()
  })

  test("does not auto-load older history when the viewport already contains all visible content", () => {
    expect(
      shouldAutoLoadMoreHistoryAtTop({
        hasMore: true,
        historyLoading: false,
        historyPreloading: false,
        localLoading: false,
        pendingSessionSwitchAlign: false,
        scrollY: 0,
        scrollHeight: 12,
        viewportHeight: 20,
      }),
    ).toBeFalse()
  })

  test("auto-loads older history only when the user is actually at the top of an overflowing viewport", () => {
    expect(
      shouldAutoLoadMoreHistoryAtTop({
        hasMore: true,
        historyLoading: false,
        historyPreloading: false,
        localLoading: false,
        pendingSessionSwitchAlign: false,
        scrollY: 0,
        scrollHeight: 40,
        viewportHeight: 20,
      }),
    ).toBeTrue()
  })

  test("does not auto-load older history while hidden pages are still preloading", () => {
    expect(
      shouldAutoLoadMoreHistoryAtTop({
        hasMore: true,
        historyLoading: false,
        historyPreloading: true,
        localLoading: false,
        pendingSessionSwitchAlign: false,
        scrollY: 0,
        scrollHeight: 40,
        viewportHeight: 20,
      }),
    ).toBeFalse()
  })

  test("aligns session switch to bottom as soon as the visible latest page is ready", () => {
    expect(
      getSessionSwitchBottomAlignAction({
        historyLoading: false,
        messageCount: 5,
        renderableCount: 3,
        hasMore: true,
      }),
    ).toBe("align")
  })

  test("waits for more history when nothing visible is rendered yet", () => {
    expect(
      getSessionSwitchBottomAlignAction({
        historyLoading: false,
        messageCount: 2,
        renderableCount: 0,
        hasMore: true,
      }),
    ).toBe("wait")
  })

  test("settles session switch when there is no visible content and no more history", () => {
    expect(
      getSessionSwitchBottomAlignAction({
        historyLoading: false,
        messageCount: 0,
        renderableCount: 0,
        hasMore: false,
      }),
    ).toBe("settle")
  })
})