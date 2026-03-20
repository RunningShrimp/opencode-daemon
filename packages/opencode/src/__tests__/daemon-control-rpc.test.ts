import { describe, expect, test } from "bun:test"
import { ControlRPCChannel } from "@/daemon/transport/control-rpc"

describe("control rpc channel", () => {
  test("dispatches valid control event and returns handler result", async () => {
    const channel = new ControlRPCChannel({
      handle(event) {
        return {
          type: event.type,
          workerID: event.workerID,
        }
      },
    })

    const request = new Request("http://opencode.internal/__daemon/control-rpc", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "1f6d89f4-6b73-4cd2-9258-95bef9eafab7",
        type: "health",
        workerID: "worker.rpc.1",
        emittedAt: 1_700_001_300_000,
        payload: {
          detail: "basic",
        },
      }),
    })

    const response = await channel.dispatch(request)
    expect(response.status).toBe(200)
    const payload = (await response.json()) as {
      ok: boolean
      eventType: string
      result: { type: string; workerID: string }
    }

    expect(payload.ok).toBe(true)
    expect(payload.eventType).toBe("health")
    expect(payload.result.workerID).toBe("worker.rpc.1")
  })

  test("rejects malformed events", async () => {
    const channel = new ControlRPCChannel()
    const response = await channel.dispatch(
      new Request("http://opencode.internal/__daemon/control-rpc", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          type: "health",
          workerID: "missing-id",
        }),
      }),
    )

    expect(response.status).toBe(400)
    const payload = (await response.json()) as { ok: boolean; error: string }
    expect(payload.ok).toBe(false)
    expect(typeof payload.error).toBe("string")
    expect(payload.error.length).toBeGreaterThan(0)
  })
})
