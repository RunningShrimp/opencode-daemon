import { describe, expect, test } from "bun:test"
import { createLocalTransportAdapter } from "@/daemon/transport/local-transport-adapter"
import { VirtualTransportInterceptor } from "@/daemon/transport/virtual-transport-interceptor"

describe("virtual transport interceptor", () => {
  test("recognizes internal virtual URLs", () => {
    expect(VirtualTransportInterceptor.isInternal("http://opencode.internal/v1/session")).toBe(true)
    expect(VirtualTransportInterceptor.isInternal("http://example.com/v1/session")).toBe(false)
  })

  test("builds request using internal origin for relative paths", () => {
    const request = VirtualTransportInterceptor.toRequest("/v1/session", { method: "POST", body: "x" })
    expect(request.url).toBe("http://opencode.internal/v1/session")
    expect(request.method).toBe("POST")
  })
})

describe("local transport adapter", () => {
  test("dispatches internal requests to local handler", async () => {
    const adapter = createLocalTransportAdapter({
      dispatch: async (request) => {
        const payload = request.method + " " + request.url
        return new Response(payload, { status: 200 })
      },
    })

    const response = await adapter("http://opencode.internal/health", {
      method: "HEAD",
    })

    expect(response.status).toBe(200)
    expect(await response.text()).toContain("http://opencode.internal/health")
  })

  test("rejects external URLs by default", async () => {
    const adapter = createLocalTransportAdapter({
      dispatch: async () => new Response("ok"),
    })

    await expect(adapter("http://example.com/health")).rejects.toThrow("rejected external URL")
  })
})
