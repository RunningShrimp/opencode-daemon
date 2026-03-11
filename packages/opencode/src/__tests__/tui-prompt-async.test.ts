import { describe, expect, test } from "bun:test"
import os from "os"
import path from "path"
import fs from "fs/promises"
import { createOpencodeClient } from "@opencode-ai/sdk/v2"
import { Server } from "@/server/server"

describe("TUI uses prompt_async", () => {
  test("prompt_async returns immediately and message is persisted", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-tui-"))
    const sdk = createOpencodeClient({
      baseUrl: "http://opencode.internal",
      directory: dir,
      fetch: ((input: RequestInfo | URL, init?: RequestInit) => {
        return Server.App().fetch(new Request(input, init))
      }) as typeof fetch,
    })

    const session = await sdk.session.create({}, { throwOnError: true })
    const id = session.data!.id

    const res = await sdk.session.promptAsync(
      {
        sessionID: id,
        parts: [{ type: "text", text: "hi" }],
      },
      { throwOnError: true },
    )
    expect(res.response.status).toBe(204)

    for (let i = 0; i < 20; i++) {
      const msgs = await sdk.session.messages({ sessionID: id, limit: 100 }, { throwOnError: true })
      if ((msgs.data ?? []).length > 0) return
      await Bun.sleep(50)
    }

    const msgs = await sdk.session.messages({ sessionID: id, limit: 100 }, { throwOnError: true })
    expect((msgs.data ?? []).length).toBeGreaterThan(0)
  })
})

