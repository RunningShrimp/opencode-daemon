import { describe, expect, test } from "bun:test"
import { fetchWithHuggingFaceFallback, getHuggingFaceFallbackCandidates } from "../util/hf-mirror"

describe("hf-mirror", () => {
  test("builds fallback candidates with modelscope first", () => {
    const candidates = getHuggingFaceFallbackCandidates(
      "https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/tokenizer.json",
    )

    expect(candidates).toEqual([
      "https://www.modelscope.cn/api/v1/models/Xenova/all-MiniLM-L6-v2/repo?Revision=main&FilePath=tokenizer.json",
      "https://hf-mirror.com/Xenova/all-MiniLM-L6-v2/resolve/main/tokenizer.json",
      "https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/tokenizer.json",
    ])
  })

  test("falls back to mirror after modelscope misses", async () => {
    const calls: string[] = []
    const mockFetch: typeof fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      calls.push(url)

      if (url.includes("modelscope.cn")) {
        return new Response("not found", { status: 404 })
      }

      if (url.includes("hf-mirror.com")) {
        return new Response('{"ok":true}', {
          status: 200,
          headers: { "content-type": "application/json" },
        })
      }

      return new Response("timeout", { status: 504 })
    }) as typeof fetch

    const response = await fetchWithHuggingFaceFallback(
      "https://huggingface.co/Xenova/all-MiniLM-L6-v2/resolve/main/tokenizer.json",
      undefined,
      mockFetch,
    )

    expect(response.status).toBe(200)
    expect(await response.json()).toEqual({ ok: true })
    expect(calls).toEqual([
      "https://www.modelscope.cn/api/v1/models/Xenova/all-MiniLM-L6-v2/repo?Revision=main&FilePath=tokenizer.json",
      "https://hf-mirror.com/Xenova/all-MiniLM-L6-v2/resolve/main/tokenizer.json",
    ])
  })

  test("does not rewrite unrelated urls", async () => {
    const calls: string[] = []
    const mockFetch: typeof fetch = (async (input: RequestInfo | URL) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
      calls.push(url)
      return new Response("ok", { status: 200 })
    }) as typeof fetch

    await fetchWithHuggingFaceFallback("https://example.com/health", undefined, mockFetch)
    expect(calls).toEqual(["https://example.com/health"])
  })
})