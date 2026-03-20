import { describe, expect, test } from "bun:test"
import { createLocalTransportAdapter } from "@/daemon/transport/local-transport-adapter"

describe("local transport adapter channel routing", () => {
  test("routes control-rpc and project-data-stream requests to dedicated channels", async () => {
    let defaultDispatchCount = 0
    let controlCount = 0
    let dataCount = 0

    const adapter = createLocalTransportAdapter({
      internalOrigin: "http://opencode.internal",
      rejectExternal: true,
      dispatch: async () => {
        defaultDispatchCount += 1
        return Response.json({ channel: "default" })
      },
      controlRPC: {
        pathPrefix: "/__daemon/control-rpc",
        dispatch: async () => {
          controlCount += 1
          return Response.json({ channel: "control" })
        },
      },
      projectDataStream: {
        pathPrefix: "/__daemon/project-data-stream",
        dispatch: async () => {
          dataCount += 1
          return Response.json({ channel: "data" })
        },
      },
    })

    const control = await adapter("/__daemon/control-rpc", {
      method: "POST",
      body: JSON.stringify({ ok: true }),
    })
    const data = await adapter("/__daemon/project-data-stream?laneID=lane.routing", {
      method: "GET",
    })
    const fallback = await adapter("/global/health", {
      method: "GET",
    })

    expect((await control.json()) as { channel: string }).toEqual({ channel: "control" })
    expect((await data.json()) as { channel: string }).toEqual({ channel: "data" })
    expect((await fallback.json()) as { channel: string }).toEqual({ channel: "default" })

    expect(controlCount).toBe(1)
    expect(dataCount).toBe(1)
    expect(defaultDispatchCount).toBe(1)
  })
})
