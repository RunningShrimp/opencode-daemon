import { afterEach, beforeEach, describe, expect, test } from "bun:test"

const envKeys = [
  "OPENCODE_EMBEDDING_PROVIDER",
  "OPENCODE_EMBEDDING_API_KEY",
  "OPENCODE_OPENAI_API_KEY",
  "OPENAI_API_KEY",
  "OPENCODE_COHERE_API_KEY",
  "COHERE_API_KEY",
  "OPENCODE_VOYAGE_API_KEY",
  "VOYAGE_API_KEY",
  "OPENCODE_EMBEDDING_MODEL",
  "OPENCODE_EMBEDDING_TEXT_MODEL",
  "OPENCODE_EMBEDDING_BOOT_TIMEOUT_MS",
  "OPENCODE_EMBEDDING_BASE_URL",
  "OPENCODE_EMBEDDING_DIMENSIONS",
] as const

const originalEnv = new Map<string, string | undefined>()

beforeEach(() => {
  for (const key of envKeys) {
    originalEnv.set(key, process.env[key])
    delete process.env[key]
  }
})

afterEach(() => {
  for (const key of envKeys) {
    const value = originalEnv.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  originalEnv.clear()
})

describe("embedding background service bootstrap config", () => {
  test("prefers transformers by default and boots it in the background", async () => {
    const embeddingModule = await import("../ai/rag/embedding")
    const originalConfigureProvider = embeddingModule.embeddingService.configureProvider
    const originalRuntimeState = embeddingModule.embeddingService.getRuntimeState

    ;(embeddingModule.embeddingService as any).configureProvider = async () => undefined
    ;(embeddingModule.embeddingService as any).getRuntimeState = () => ({
      mode: "provider",
      activeProvider: "transformers-multimodal",
      configuredProvider: "transformers-multimodal",
      activeProviderKind: "transformers",
      updatedAt: Date.now(),
    })

    try {
      const { EmbeddingBackgroundService } = await import("../ai/rag/embedding-bg-service")
      const service = new EmbeddingBackgroundService()

      await service.start()
      await new Promise((resolve) => setTimeout(resolve, 20))

      expect(service.getStatus()).toBe("ready")
      const runtime = service.getRuntimeContext()
      expect(runtime.targetProvider).toBe("transformers")
      expect(runtime.source).toBe("default")
      expect(runtime.mode).toBe("provider")

      await service.stop()
    } finally {
      ;(embeddingModule.embeddingService as any).configureProvider = originalConfigureProvider
      ;(embeddingModule.embeddingService as any).getRuntimeState = originalRuntimeState
    }
  })

  test("falls back immediately when default transformers boot fails", async () => {
    const embeddingModule = await import("../ai/rag/embedding")
    const originalConfigureProvider = embeddingModule.embeddingService.configureProvider

    ;(embeddingModule.embeddingService as any).configureProvider = async () => {
      throw new Error("ConnectionRefused")
    }

    try {
      const { EmbeddingBackgroundService } = await import("../ai/rag/embedding-bg-service")
      const service = new EmbeddingBackgroundService()

      await service.start()
      await new Promise((resolve) => setTimeout(resolve, 20))

      const startedAt = Date.now()
      const ready = await service.waitForProvider(1000)
      const elapsedMs = Date.now() - startedAt

      expect(ready).toBeFalse()
      expect(elapsedMs).toBeLessThan(250)
      expect(service.getStatus()).toBe("fallback")
      const runtime = service.getRuntimeContext()
      expect(runtime.targetProvider).toBe("transformers")
      expect(runtime.source).toBe("default")
      expect(runtime.mode).toBe("fallback")
      expect(runtime.lastError).toContain("ConnectionRefused")

      await service.stop()
    } finally {
      ;(embeddingModule.embeddingService as any).configureProvider = originalConfigureProvider
    }
  })

  test("times out default transformers boot quickly when provider init hangs", async () => {
    process.env.OPENCODE_EMBEDDING_BOOT_TIMEOUT_MS = "50"

    const embeddingModule = await import("../ai/rag/embedding")
    const originalConfigureProvider = embeddingModule.embeddingService.configureProvider

    ;(embeddingModule.embeddingService as any).configureProvider = () => new Promise(() => undefined)

    try {
      const { EmbeddingBackgroundService } = await import("../ai/rag/embedding-bg-service")
      const service = new EmbeddingBackgroundService()

      const startedAt = Date.now()
      await service.start()
      await new Promise((resolve) => setTimeout(resolve, 90))
      const elapsedMs = Date.now() - startedAt

      expect(service.getStatus()).toBe("fallback")
      expect(elapsedMs).toBeLessThan(300)
      expect(service.getRuntimeContext().lastError).toContain("timed out")
      await expect(service.waitForProvider(50)).resolves.toBeFalse()

      await service.stop()
    } finally {
      ;(embeddingModule.embeddingService as any).configureProvider = originalConfigureProvider
    }
  })

  test("respects fallback mode from env without booting real provider", async () => {
    process.env.OPENCODE_EMBEDDING_PROVIDER = "fallback"

    const { EmbeddingBackgroundService } = await import("../ai/rag/embedding-bg-service")
    const service = new EmbeddingBackgroundService()

    await service.start()

    expect(service.getStatus()).toBe("fallback")
    await expect(service.waitForProvider(50)).resolves.toBeFalse()
    const runtime = service.getRuntimeContext()
    expect(runtime.targetProvider).toBe("fallback")
    expect(runtime.source).toBe("env")
    expect(runtime.mode).toBe("fallback")

    await service.stop()
  })

  test("transformers init failures stay on fallback without waiting out the timeout", async () => {
    process.env.OPENCODE_EMBEDDING_PROVIDER = "transformers"

    const embeddingModule = await import("../ai/rag/embedding")
    const originalConfigureProvider = embeddingModule.embeddingService.configureProvider

    ;(embeddingModule.embeddingService as any).configureProvider = async () => {
      throw new Error("ConnectionRefused")
    }

    try {
      const { EmbeddingBackgroundService } = await import("../ai/rag/embedding-bg-service")
      const service = new EmbeddingBackgroundService()

      await service.start()
      await new Promise((resolve) => setTimeout(resolve, 20))

      const startedAt = Date.now()
      const ready = await service.waitForProvider(1000)
      const elapsedMs = Date.now() - startedAt

      expect(ready).toBeFalse()
      expect(elapsedMs).toBeLessThan(250)
      expect(service.getStatus()).toBe("fallback")
      expect(service.getRuntimeContext().lastError).toContain("ConnectionRefused")

      await service.stop()
    } finally {
      ;(embeddingModule.embeddingService as any).configureProvider = originalConfigureProvider
    }
  })

  test("reports unsupported provider names as runtime errors and falls back", async () => {
    process.env.OPENCODE_EMBEDDING_PROVIDER = "unknown-provider"

    const { EmbeddingBackgroundService } = await import("../ai/rag/embedding-bg-service")
    const service = new EmbeddingBackgroundService()

    await service.start()
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(service.getStatus()).toBe("fallback")
    const runtime = service.getRuntimeContext()
    expect(runtime.lastError).toContain("Unsupported OPENCODE_EMBEDDING_PROVIDER=unknown-provider")

    await service.stop()
  })

  test("requires API key when external provider is selected", async () => {
    process.env.OPENCODE_EMBEDDING_PROVIDER = "openai"

    const { EmbeddingBackgroundService } = await import("../ai/rag/embedding-bg-service")
    const service = new EmbeddingBackgroundService()

    await service.start()
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(service.getStatus()).toBe("fallback")
    const runtime = service.getRuntimeContext()
    expect(runtime.lastError).toContain("requires OPENCODE_OPENAI_API_KEY or OPENAI_API_KEY")

    await service.stop()
  })

  test("rejects invalid embedding dimension values from env", async () => {
    process.env.OPENCODE_EMBEDDING_PROVIDER = "openai"
    process.env.OPENCODE_OPENAI_API_KEY = "sk-test"
    process.env.OPENCODE_EMBEDDING_DIMENSIONS = "NaN"

    const { EmbeddingBackgroundService } = await import("../ai/rag/embedding-bg-service")
    const service = new EmbeddingBackgroundService()

    await service.start()
    await new Promise((resolve) => setTimeout(resolve, 20))

    expect(service.getStatus()).toBe("fallback")
    const runtime = service.getRuntimeContext()
    expect(runtime.lastError).toContain("Invalid OPENCODE_EMBEDDING_DIMENSIONS")

    await service.stop()
  })

  test("activates external provider in ready mode when configuration succeeds", async () => {
    process.env.OPENCODE_EMBEDDING_PROVIDER = "openai"
    process.env.OPENCODE_OPENAI_API_KEY = "sk-test"

    const embeddingModule = await import("../ai/rag/embedding")
    const originalConfigure = embeddingModule.embeddingService.configureFromSettings
    const originalRuntimeState = embeddingModule.embeddingService.getRuntimeState

    ;(embeddingModule.embeddingService as any).configureFromSettings = async () => undefined
    ;(embeddingModule.embeddingService as any).getRuntimeState = () => ({
      mode: "provider",
      activeProvider: "openai-mock",
      configuredProvider: "openai",
      activeProviderKind: "transformers",
      updatedAt: Date.now(),
    })

    try {
      const { EmbeddingBackgroundService } = await import("../ai/rag/embedding-bg-service")
      const service = new EmbeddingBackgroundService()

      await service.start()
      await new Promise((resolve) => setTimeout(resolve, 20))

      expect(service.getStatus()).toBe("ready")
      const runtime = service.getRuntimeContext()
      expect(runtime.targetProvider).toBe("openai")
      expect(runtime.source).toBe("env")
      expect(runtime.mode).toBe("provider")
      expect(runtime.activeProvider).toBe("openai-mock")

      await service.stop()
    } finally {
      ;(embeddingModule.embeddingService as any).configureFromSettings = originalConfigure
      ;(embeddingModule.embeddingService as any).getRuntimeState = originalRuntimeState
    }
  })

  test("triggers reindex callbacks after external provider becomes ready", async () => {
    process.env.OPENCODE_EMBEDDING_PROVIDER = "openai"
    process.env.OPENCODE_OPENAI_API_KEY = "sk-test"

    const embeddingModule = await import("../ai/rag/embedding")
    const originalConfigure = embeddingModule.embeddingService.configureFromSettings
    const originalRuntimeState = embeddingModule.embeddingService.getRuntimeState

    ;(embeddingModule.embeddingService as any).configureFromSettings = async () => undefined
    ;(embeddingModule.embeddingService as any).getRuntimeState = () => ({
      mode: "provider",
      activeProvider: "openai-mock",
      configuredProvider: "openai",
      activeProviderKind: "transformers",
      updatedAt: Date.now(),
    })

    try {
      const { EmbeddingBackgroundService } = await import("../ai/rag/embedding-bg-service")
      const service = new EmbeddingBackgroundService()
      let callbackCount = 0

      service.onReindex(async () => {
        callbackCount += 1
      })

      await service.start()
      await new Promise((resolve) => setTimeout(resolve, 40))

      expect(service.getStatus()).toBe("ready")
      expect(callbackCount).toBeGreaterThan(0)

      const runtime = service.getRuntimeContext()
      expect(runtime.targetProvider).toBe("openai")
      expect(runtime.mode).toBe("provider")

      await service.stop()
    } finally {
      ;(embeddingModule.embeddingService as any).configureFromSettings = originalConfigure
      ;(embeddingModule.embeddingService as any).getRuntimeState = originalRuntimeState
    }
  })

  test("handles high-frequency embed calls in fallback mode without unstable output shape", async () => {
    process.env.OPENCODE_EMBEDDING_PROVIDER = "fallback"

    const { EmbeddingBackgroundService } = await import("../ai/rag/embedding-bg-service")
    const { EMBEDDING_OUTPUT_DIMENSIONS } = await import("../ai/rag/embedding")
    const service = new EmbeddingBackgroundService()

    await service.start()

    const payloads = Array.from({ length: 40 }, (_, i) => `fallback-load-input-${i % 7}`)
    const vectors = await Promise.all(payloads.map((item) => service.embed(item)))

    expect(vectors).toHaveLength(40)
    expect(vectors.every((vector) => vector.length === EMBEDDING_OUTPUT_DIMENSIONS)).toBeTrue()

    const firstA = await service.embed("fallback-load-input-0")
    const secondA = await service.embed("fallback-load-input-0")
    expect(firstA.length).toBe(EMBEDDING_OUTPUT_DIMENSIONS)
    expect(secondA.length).toBe(EMBEDDING_OUTPUT_DIMENSIONS)
    expect(firstA.join(",")).toBe(secondA.join(","))

    await service.stop()
  })

  test("serializes reindex callbacks under repeated ready-state triggers", async () => {
    process.env.OPENCODE_EMBEDDING_PROVIDER = "openai"
    process.env.OPENCODE_OPENAI_API_KEY = "sk-test"

    const embeddingModule = await import("../ai/rag/embedding")
    const originalConfigure = embeddingModule.embeddingService.configureFromSettings
    const originalRuntimeState = embeddingModule.embeddingService.getRuntimeState

    ;(embeddingModule.embeddingService as any).configureFromSettings = async () => undefined
    ;(embeddingModule.embeddingService as any).getRuntimeState = () => ({
      mode: "provider",
      activeProvider: "openai-mock",
      configuredProvider: "openai",
      activeProviderKind: "transformers",
      updatedAt: Date.now(),
    })

    try {
      const { EmbeddingBackgroundService } = await import("../ai/rag/embedding-bg-service")
      const service = new EmbeddingBackgroundService()

      let running = 0
      let maxConcurrent = 0
      let invocations = 0

      const callback = async () => {
        running += 1
        maxConcurrent = Math.max(maxConcurrent, running)
        invocations += 1
        await new Promise((resolve) => setTimeout(resolve, 12))
        running -= 1
      }

      service.onReindex(callback)
      await service.start()
      await new Promise((resolve) => setTimeout(resolve, 80))

      service.onReindex(callback)
      await new Promise((resolve) => setTimeout(resolve, 40))
      service.onReindex(callback)
      await new Promise((resolve) => setTimeout(resolve, 120))

      expect(service.getStatus()).toBe("ready")
      expect(maxConcurrent).toBe(1)
      expect(invocations).toBeGreaterThan(2)

      await service.stop()
    } finally {
      ;(embeddingModule.embeddingService as any).configureFromSettings = originalConfigure
      ;(embeddingModule.embeddingService as any).getRuntimeState = originalRuntimeState
    }
  })
})
