import { describe, expect, test } from "bun:test"
import { createLocalTransportAdapter } from "@/daemon/transport/local-transport-adapter"

describe("local transport adapter shadow comparison", () => {
  test("emits match=true when primary and shadow responses are identical", async () => {
    const compared: Array<{ match: boolean; statusMatch: boolean; bodyMatch: boolean }> = []

    const adapter = createLocalTransportAdapter({
      internalOrigin: "http://opencode.internal",
      dispatch: async () => Response.json({ ok: true, value: 1 }),
      shadow: {
        dispatch: async () => Response.json({ ok: true, value: 1 }),
        onCompared(result) {
          compared.push(result)
        },
      },
    })

    const response = await adapter("/global/health")
    expect(response.status).toBe(200)

    expect(compared).toHaveLength(1)
    expect(compared[0]).toEqual({
      match: true,
      statusMatch: true,
      bodyMatch: true,
    })
  })

  test("emits mismatch details when primary and shadow differ", async () => {
    const compared: Array<{ match: boolean; statusMatch: boolean; bodyMatch: boolean }> = []

    const adapter = createLocalTransportAdapter({
      internalOrigin: "http://opencode.internal",
      dispatch: async () => new Response("primary", { status: 200 }),
      shadow: {
        dispatch: async () => new Response("shadow", { status: 201 }),
        onCompared(result) {
          compared.push(result)
        },
      },
    })

    const response = await adapter("/global/health")
    expect(response.status).toBe(200)

    expect(compared).toHaveLength(1)
    expect(compared[0]?.match).toBe(false)
    expect(compared[0]?.statusMatch).toBe(false)
    expect(compared[0]?.bodyMatch).toBe(false)
  })
})
