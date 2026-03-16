import { describe, expect, test } from "bun:test"
import {
  EmbeddingService,
  OpenAIEmbeddingProvider,
  CohereEmbeddingProvider,
  VoyageEmbeddingProvider,
  type ExternalEmbeddingConfig,
} from "../ai/rag/embedding"

describe("External embedding providers", () => {
  test("OpenAIEmbeddingProvider implements EmbeddingProvider interface", () => {
    const provider = new OpenAIEmbeddingProvider({ provider: "openai", apiKey: "test-key", model: "text-embedding-3-small" })
    expect(typeof provider.embed).toBe("function")
    expect(typeof provider.embedBatch).toBe("function")
  })

  test("CohereEmbeddingProvider implements EmbeddingProvider interface", () => {
    const provider = new CohereEmbeddingProvider({ provider: "cohere", apiKey: "test-key", model: "embed-english-v3.0" })
    expect(typeof provider.embed).toBe("function")
    expect(typeof provider.embedBatch).toBe("function")
  })

  test("configureFromSettings creates an OpenAIEmbeddingProvider for provider:openai", async () => {
    const service = new EmbeddingService()
    const config: ExternalEmbeddingConfig = {
      provider: "openai",
      apiKey: "sk-test",
      model: "text-embedding-3-small",
    }
    await service.configureFromSettings(config)
    // The active provider should now be an OpenAI instance
    const active = (service as any).activeProvider
    expect(active).toBeInstanceOf(OpenAIEmbeddingProvider)
  })

  test("configureFromSettings creates a CohereEmbeddingProvider for provider:cohere", async () => {
    const service = new EmbeddingService()
    const config: ExternalEmbeddingConfig = {
      provider: "cohere",
      apiKey: "co-test",
      model: "embed-english-v3.0",
    }
    await service.configureFromSettings(config)
    const active = (service as any).activeProvider
    expect(active).toBeInstanceOf(CohereEmbeddingProvider)
  })

  test("configureFromSettings creates a VoyageEmbeddingProvider for provider:voyage", async () => {
    const service = new EmbeddingService()
    const config: ExternalEmbeddingConfig = {
      provider: "voyage",
      apiKey: "voyage-test",
      model: "voyage-3-lite",
    }
    await service.configureFromSettings(config)
    const active = (service as any).activeProvider
    expect(active).toBeInstanceOf(VoyageEmbeddingProvider)
  })

  test("OpenAIEmbeddingProvider uses custom baseUrl when provided", () => {
    const provider = new OpenAIEmbeddingProvider({
      provider: "openai",
      apiKey: "test-key",
      model: "text-embedding-3-small",
      baseUrl: "https://custom.openai-compatible.example.com/v1",
    })
    expect((provider as any).config.baseUrl).toContain("custom.openai-compatible.example.com")
  })

  test("CohereEmbeddingProvider stores model and apiKey", () => {
    const provider = new CohereEmbeddingProvider({ provider: "cohere", apiKey: "co-abc", model: "embed-multilingual-v3.0" })
    expect((provider as any).config.apiKey).toBe("co-abc")
    expect((provider as any).config.model).toBe("embed-multilingual-v3.0")
  })
})
