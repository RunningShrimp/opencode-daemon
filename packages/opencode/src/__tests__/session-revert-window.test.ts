import { describe, expect, test } from "bun:test"
import { getRenderableRevertState } from "../cli/cmd/tui/routes/session/revert-window"

describe("getRenderableRevertState", () => {
  test("ignores stale revert anchors that are outside the loaded message window", () => {
    const result = getRenderableRevertState(
      [
        { id: "message_200", role: "user" },
        { id: "message_201", role: "assistant" },
        { id: "message_202", role: "user" },
      ],
      {
        messageID: "message_100",
        diff: "@@ -1 +1 @@",
      },
    )

    expect(result).toBeUndefined()
  })

  test("returns the visible revert window when the anchor is still loaded", () => {
    const result = getRenderableRevertState(
      [
        { id: "message_100", role: "user" },
        { id: "message_101", role: "assistant" },
        { id: "message_102", role: "user" },
      ],
      {
        messageID: "message_100",
        diff: "@@ -1 +1 @@",
      },
    )

    expect(result).toEqual({
      messageID: "message_100",
      diff: "@@ -1 +1 @@",
      reverted: [
        { id: "message_100", role: "user" },
        { id: "message_102", role: "user" },
      ],
    })
  })
})