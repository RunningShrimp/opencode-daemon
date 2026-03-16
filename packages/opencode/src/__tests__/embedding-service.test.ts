import { describe, expect, test } from "bun:test"
import {
  EMBEDDING_OUTPUT_DIMENSIONS,
  EmbeddingService,
  RETRIEVAL_DIMENSIONS,
  type EmbeddingInput,
  type EmbeddingProvider,
} from "../ai/rag/embedding"

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
})