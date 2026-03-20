import { afterEach, describe, expect, mock, test } from "bun:test"
import {
  EMBEDDING_OUTPUT_DIMENSIONS,
  EmbeddingService,
  RETRIEVAL_DIMENSIONS,
  TransformersEmbeddingProvider,
  type EmbeddingInput,
  type EmbeddingProvider,
} from "../ai/rag/embedding"
import { clearNetworkProbeCache } from "../util/network-probe"

afterEach(() => {
  mock.restore()
  clearNetworkProbeCache()
})

describe("embedding service", () => {
  test("normalizes provider output dimensions to a stable shape", async () => {
    const service = new EmbeddingService()
    const provider: EmbeddingProvider = {
      name: "custom",
      kind: "transformers",
      dimensions: 3,
      supports: () => true,
      async embed(_input: EmbeddingInput) {
        return [1, 2, 3]
      },
    }

    await service.configureProvider(provider)
    const embedding = await service.getEmbedding("alpha")

    expect(embedding).toHaveLength(EMBEDDING_OUTPUT_DIMENSIONS)
    expect(embedding.some((value) => value !== 0)).toBeTrue()
  })

  test("falls back to semantic embeddings when the configured provider fails", async () => {
    const service = new EmbeddingService()
    const provider: EmbeddingProvider = {
      name: "broken",
      kind: "transformers",
      dimensions: 768,
      supports: () => true,
      async embed() {
        throw new Error("boom")
      },
    }

    await service.configureProvider(provider)
    const embedding = await service.getEmbedding("recoverable query")

    expect(embedding).toHaveLength(EMBEDDING_OUTPUT_DIMENSIONS)
    expect(service.getProvider().kind).toBe("fallback")
    const runtime = service.getRuntimeState()
    expect(runtime.mode).toBe("fallback")
    expect(runtime.lastError).toContain("boom")
  })

  test("runtime state reflects configured provider activation", async () => {
    const service = new EmbeddingService()
    const provider: EmbeddingProvider = {
      name: "provider-under-test",
      kind: "transformers",
      dimensions: 16,
      supports: () => true,
      async embed(_input: EmbeddingInput) {
        return [1, 2, 3]
      },
    }

    await service.configureProvider(provider)
    const runtime = service.getRuntimeState()

    expect(runtime.mode).toBe("provider")
    expect(runtime.activeProvider).toBe("provider-under-test")
    expect(runtime.configuredProvider).toBe("provider-under-test")
  })

  test("derives differentiated retrieval dimensions for code and documentation", async () => {
    const service = new EmbeddingService()

    const code = await service.getRetrievalEmbedding({
      content: 'export function auth() { return loadSession() }',
      path: 'src/auth.ts',
      metadata: { chunkType: 'code' },
    })
    const doc = await service.getRetrievalEmbedding({
      content: '# Runtime Notes\n\nExplain the auth flow.',
      modality: 'document',
      path: 'docs/runtime-notes.md',
      metadata: { chunkType: 'text' },
    })
    const query = await service.getQueryEmbeddings('trace auth flow and session loader')

    expect(code.profile).toBe('code')
    expect(code.coarse).toHaveLength(RETRIEVAL_DIMENSIONS.coarse)
    expect(code.fine).toHaveLength(RETRIEVAL_DIMENSIONS.code)
    expect(doc.profile).toBe('text')
    expect(doc.fine).toHaveLength(RETRIEVAL_DIMENSIONS.text)
    expect(query.coarse).toHaveLength(RETRIEVAL_DIMENSIONS.coarse)
    expect(query.fineByProfile.code).toHaveLength(RETRIEVAL_DIMENSIONS.code)
    expect(query.fineByProfile.text).toHaveLength(RETRIEVAL_DIMENSIONS.text)
  })

  test("ignores blank embedding model overrides for transformers", () => {
    const originalModel = process.env.OPENCODE_EMBEDDING_MODEL
    const originalTextModel = process.env.OPENCODE_EMBEDDING_TEXT_MODEL

    process.env.OPENCODE_EMBEDDING_MODEL = ""
    process.env.OPENCODE_EMBEDDING_TEXT_MODEL = "   "

    try {
      const provider = new TransformersEmbeddingProvider()
      expect((provider as any).textModel).toBe("onnx-community/Qwen3-Embedding-0.6B-ONNX")
    } finally {
      if (originalModel === undefined) delete process.env.OPENCODE_EMBEDDING_MODEL
      else process.env.OPENCODE_EMBEDDING_MODEL = originalModel

      if (originalTextModel === undefined) delete process.env.OPENCODE_EMBEDDING_TEXT_MODEL
      else process.env.OPENCODE_EMBEDDING_TEXT_MODEL = originalTextModel
    }
  })

  test("ignores legacy MiniLM embedding model overrides", () => {
    const originalModel = process.env.OPENCODE_EMBEDDING_MODEL
    const originalTextModel = process.env.OPENCODE_EMBEDDING_TEXT_MODEL

    process.env.OPENCODE_EMBEDDING_MODEL = "legacy/all-MiniLM-L6-v2"
    process.env.OPENCODE_EMBEDDING_TEXT_MODEL = "legacy/all-miniLM-l6-v2"

    try {
      const provider = new TransformersEmbeddingProvider()
      expect((provider as any).textModel).toBe("onnx-community/Qwen3-Embedding-0.6B-ONNX")
    } finally {
      if (originalModel === undefined) delete process.env.OPENCODE_EMBEDDING_MODEL
      else process.env.OPENCODE_EMBEDDING_MODEL = originalModel

      if (originalTextModel === undefined) delete process.env.OPENCODE_EMBEDDING_TEXT_MODEL
      else process.env.OPENCODE_EMBEDDING_TEXT_MODEL = originalTextModel
    }
  })

  test("configures transformers remote host from hf mirror settings", async () => {
    const originalFetch = global.fetch
    const originalHFEndpoint = process.env.HF_ENDPOINT
    const originalHFHubURL = process.env.HF_HUB_URL

    process.env.HF_ENDPOINT = "https://hf-mirror.com"
    delete process.env.HF_HUB_URL

    const pipelineCalls: Array<{ task: string; model: string }> = []
    const transformersEnv = {
      allowRemoteModels: false,
      allowLocalModels: false,
      remoteHost: "https://huggingface.co/",
      remotePathTemplate: "",
    }

    ;(globalThis as any).fetch = async () => new Response(null, { status: 200 })
    mock.module("@huggingface/transformers", () => ({
      env: transformersEnv,
      pipeline: async (task: string, model: string) => {
        pipelineCalls.push({ task, model })
        return async () => ({ data: [1, 2, 3] })
      },
    }))

    try {
      clearNetworkProbeCache()
      const provider = new TransformersEmbeddingProvider()
      await provider.initialize()

      expect(transformersEnv.remoteHost).toBe("https://hf-mirror.com/")
      expect(transformersEnv.remotePathTemplate).toBe("{model}/resolve/{revision}/")
      expect(pipelineCalls[0]).toEqual({
        task: "feature-extraction",
        model: "onnx-community/Qwen3-Embedding-0.6B-ONNX",
      })
    } finally {
      ;(globalThis as any).fetch = originalFetch

      if (originalHFEndpoint === undefined) delete process.env.HF_ENDPOINT
      else process.env.HF_ENDPOINT = originalHFEndpoint

      if (originalHFHubURL === undefined) delete process.env.HF_HUB_URL
      else process.env.HF_HUB_URL = originalHFHubURL
    }
  })

  test("retries text model initialization with fallback host when mirror misses tokenizer", async () => {
    const originalFetch = global.fetch
    const originalHFEndpoint = process.env.HF_ENDPOINT
    const originalHFHubURL = process.env.HF_HUB_URL

    process.env.HF_ENDPOINT = "https://hf-mirror.com"
    delete process.env.HF_HUB_URL

    const transformersEnv = {
      allowRemoteModels: false,
      allowLocalModels: false,
      remoteHost: "https://huggingface.co/",
      remotePathTemplate: "",
    }

    const textHosts: string[] = []
    const imageHosts: string[] = []
    let textAttempts = 0

    ;(globalThis as any).fetch = async () => new Response(null, { status: 200 })
    mock.module("@huggingface/transformers", () => ({
      env: transformersEnv,
      pipeline: async (task: string) => {
        if (task === "feature-extraction") {
          textHosts.push(transformersEnv.remoteHost)
          textAttempts += 1
          if (textAttempts === 1) {
            throw new Error('Could not locate file: "https://hf-mirror.com/onnx-community/Qwen3-Embedding-0.6B-ONNX/resolve/main/tokenizer.json"')
          }
        }
        if (task === "image-feature-extraction") {
          imageHosts.push(transformersEnv.remoteHost)
        }
        return async () => ({ data: [1, 2, 3] })
      },
    }))

    try {
      clearNetworkProbeCache()
      const provider = new TransformersEmbeddingProvider()
      await provider.initialize()

      expect(textHosts).toEqual(["https://hf-mirror.com/", "https://huggingface.co/"])
      expect(imageHosts).toEqual(["https://huggingface.co/"])
      expect(transformersEnv.remoteHost).toBe("https://huggingface.co/")
    } finally {
      ;(globalThis as any).fetch = originalFetch

      if (originalHFEndpoint === undefined) delete process.env.HF_ENDPOINT
      else process.env.HF_ENDPOINT = originalHFEndpoint

      if (originalHFHubURL === undefined) delete process.env.HF_HUB_URL
      else process.env.HF_HUB_URL = originalHFHubURL
    }
  })

  test("aborts retries when initialization error reveals legacy MiniLM dependency path", async () => {
    const originalFetch = global.fetch
    const originalHFEndpoint = process.env.HF_ENDPOINT
    const originalHFHubURL = process.env.HF_HUB_URL

    process.env.HF_ENDPOINT = "https://hf-mirror.com"
    delete process.env.HF_HUB_URL

    const transformersEnv = {
      allowRemoteModels: false,
      allowLocalModels: false,
      remoteHost: "https://huggingface.co/",
      remotePathTemplate: "",
    }

    const textHosts: string[] = []

    ;(globalThis as any).fetch = async () => new Response(null, { status: 200 })
    mock.module("@huggingface/transformers", () => ({
      env: transformersEnv,
      pipeline: async (task: string) => {
        if (task === "feature-extraction") {
          textHosts.push(transformersEnv.remoteHost)
          throw new Error('Could not locate file: "https://hf-mirror.com/Xenova/all-MiniLM-L6-v2/resolve/main/tokenizer.json"')
        }
        return async () => ({ data: [1, 2, 3] })
      },
    }))

    try {
      clearNetworkProbeCache()
      const provider = new TransformersEmbeddingProvider()

      await expect(provider.initialize()).rejects.toThrow("legacy MiniLM dependency path")
      expect(textHosts).toEqual(["https://hf-mirror.com/"])
    } finally {
      ;(globalThis as any).fetch = originalFetch

      if (originalHFEndpoint === undefined) delete process.env.HF_ENDPOINT
      else process.env.HF_ENDPOINT = originalHFEndpoint

      if (originalHFHubURL === undefined) delete process.env.HF_HUB_URL
      else process.env.HF_HUB_URL = originalHFHubURL
    }
  })

  test("continues with text embeddings when image model init fails", async () => {
    const originalFetch = global.fetch

    const transformersEnv = {
      allowRemoteModels: false,
      allowLocalModels: false,
      remoteHost: "https://huggingface.co/",
      remotePathTemplate: "",
    }

    ;(globalThis as any).fetch = async () => new Response(null, { status: 200 })
    mock.module("@huggingface/transformers", () => ({
      env: transformersEnv,
      pipeline: async (task: string) => {
        if (task === "image-feature-extraction") {
          throw new Error('Could not locate file: "https://hf-mirror.com/onnx-community/clip-vit-base-patch32/resolve/main/preprocessor_config.json"')
        }
        return async () => ({ data: [1, 2, 3] })
      },
    }))

    try {
      clearNetworkProbeCache()
      const provider = new TransformersEmbeddingProvider()
      await provider.initialize()

      const imageEmbedding = await provider.embed({
        modality: "image",
        content: new Uint8Array([1, 2, 3]),
        path: "assets/logo.png",
        metadata: { source: "test" },
      })

      expect(imageEmbedding).toEqual([1, 2, 3])
    } finally {
      ;(globalThis as any).fetch = originalFetch
    }
  })
})