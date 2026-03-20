import { describe, expect, test } from "bun:test"
import { AIRuntimeSupervisor } from "@/daemon/ai-runtime/ai-runtime-supervisor"
import { EmbeddingIPCChannel } from "@/daemon/ai-runtime/embedding-ipc"

describe("ai runtime supervisor", () => {
  test("uses sidecar client when available", async () => {
    const warmCalls: string[] = []
    const embedCalls: string[] = []

    const supervisor = new AIRuntimeSupervisor({
      client: {
        async warm(model) {
          warmCalls.push(model)
        },
        async embed(request) {
          embedCalls.push(request.model)
          return {
            model: request.model,
            vectors: request.input.map(() => [0.5, 0.5]),
          }
        },
        async shrinkPool() {
          return
        },
      },
      fallbackEmbed: async (request) => ({
        model: request.model,
        vectors: request.input.map(() => [1, 0]),
      }),
    })

    await supervisor.warm("onnx-community/Qwen3-Embedding-0.6B-ONNX")
    const response = await supervisor.embed({
      model: "onnx-community/Qwen3-Embedding-0.6B-ONNX",
      input: ["a", "b"],
    })

    expect(warmCalls).toEqual(["onnx-community/Qwen3-Embedding-0.6B-ONNX"])
    expect(embedCalls).toEqual(["onnx-community/Qwen3-Embedding-0.6B-ONNX"])
    expect(response.vectors).toHaveLength(2)

    const stats = await supervisor.stats()
    expect(stats.mode).toBe("sidecar")
    expect(stats.sidecarEmbeds).toBe(1)
    expect(stats.fallbackEmbeds).toBe(0)
  })

  test("falls back to local embedding path when sidecar embed fails", async () => {
    let fallbackCalls = 0

    const supervisor = new AIRuntimeSupervisor({
      client: {
        async warm() {
          return
        },
        async embed() {
          throw new Error("sidecar unavailable")
        },
        async shrinkPool() {
          return
        },
      },
      fallbackEmbed: async (request) => {
        fallbackCalls += 1
        return {
          model: request.model,
          vectors: request.input.map(() => [0.1, 0.2, 0.3]),
        }
      },
    })

    const response = await supervisor.embed({
      model: "fallback-model",
      input: ["payload"],
    })

    expect(fallbackCalls).toBe(1)
    expect(response.model).toBe("fallback-model")
    expect(response.vectors).toEqual([[0.1, 0.2, 0.3]])

    const stats = await supervisor.stats()
    expect(stats.mode).toBe("fallback")
    expect(stats.failures).toBe(1)
    expect(stats.fallbackEmbeds).toBe(1)
  })
})

describe("embedding ipc channel", () => {
  test("accepts POST embed requests and exposes GET stats", async () => {
    const channel = new EmbeddingIPCChannel({
      supervisor: {
        async embed(input) {
          const payload = input as { model: string; input: string[] }
          return {
            model: payload.model,
            vectors: payload.input.map(() => [0.9]),
          }
        },
        async stats() {
          return {
            mode: "sidecar",
            embedRequests: 3,
            sidecarEmbeds: 2,
            fallbackEmbeds: 1,
            warmedModels: ["qwen"],
            failures: 0,
          }
        },
      },
    })

    const post = await channel.dispatch(
      new Request("http://opencode.internal/__daemon/ai-runtime/embed", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          model: "qwen",
          input: ["hello"],
        }),
      }),
    )
    expect(post.status).toBe(200)
    const postBody = (await post.json()) as {
      ok: boolean
      response: { model: string; vectors: number[][] }
    }
    expect(postBody.ok).toBeTrue()
    expect(postBody.response.model).toBe("qwen")

    const get = await channel.dispatch(new Request("http://opencode.internal/__daemon/ai-runtime/embed"))
    expect(get.status).toBe(200)
    const getBody = (await get.json()) as { ok: boolean; stats: { mode: string } }
    expect(getBody.ok).toBeTrue()
    expect(getBody.stats.mode).toBe("sidecar")
  })

  test("rejects malformed payload", async () => {
    const channel = new EmbeddingIPCChannel({
      supervisor: {
        async embed() {
          return {
            model: "unused",
            vectors: [[1]],
          }
        },
        async stats() {
          return {
            mode: "fallback",
            embedRequests: 0,
            sidecarEmbeds: 0,
            fallbackEmbeds: 0,
            warmedModels: [],
            failures: 0,
          }
        },
      },
    })

    const invalid = await channel.dispatch(
      new Request("http://opencode.internal/__daemon/ai-runtime/embed", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ model: "x", input: [] }),
      }),
    )

    expect(invalid.status).toBe(400)
    const payload = (await invalid.json()) as { ok: boolean; error: string }
    expect(payload.ok).toBeFalse()
    expect(payload.error.length).toBeGreaterThan(0)
  })
})
