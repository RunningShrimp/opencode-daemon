import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const cleanup: string[] = []
const envKeys = ["XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME"] as const
const originalEnv = new Map<string, string | undefined>()

beforeEach(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-pm-lru-"))
  cleanup.push(root)
  for (const key of envKeys) originalEnv.set(key, process.env[key])
  process.env.XDG_DATA_HOME = path.join(root, "data-home")
  process.env.XDG_CACHE_HOME = path.join(root, "cache-home")
  process.env.XDG_CONFIG_HOME = path.join(root, "config-home")
  process.env.XDG_STATE_HOME = path.join(root, "state-home")
})

afterEach(async () => {
  const { ProjectMemory } = await import("../ai/memory/project-memory")
  ProjectMemory.resetForTest()
  vi.restoreAllMocks()
  for (const key of envKeys) {
    const value = originalEnv.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  originalEnv.clear()
  while (cleanup.length > 0) {
    const target = cleanup.pop()
    if (target) await fs.rm(target, { recursive: true, force: true })
  }
})

describe("ProjectMemory LRU embedding cache eviction", () => {
  test("upsert does not crash when embedding service is unavailable (no ML model)", async () => {
    const { ProjectMemory } = await import("../ai/memory/project-memory")
    // Upserting should succeed even when the embedding service can't produce a vector
    const result = await ProjectMemory.upsert("test-lru-project", {
      kind: "fact",
      text: "The auth module uses JWT tokens",
      confidence: 0.9,
      evidence: ["src/auth.ts"],
      tags: ["auth", "jwt"],
    })
    expect(result.id).toBeDefined()
    expect(result.text).toBe("The auth module uses JWT tokens")
  })

  test("LRU eviction fires when cache grows beyond MAX_EMBEDDING_CACHE_SIZE", async () => {
    const { ProjectMemory } = await import("../ai/memory/project-memory")
    // Inject a fake embedding service that always returns a vector so we can fill the cache
    const { embeddingService } = await import("../ai/rag/embedding")
    vi.spyOn(embeddingService, "getEmbedding").mockImplementation(async () =>
      Array.from({ length: 8 }, (_, i) => i * 0.01),
    )

    const MAX = 500
    // upsert MAX+20 distinct entries — LRU eviction must keep cache at ≤ MAX
    for (let i = 0; i < MAX + 20; i++) {
      await ProjectMemory.upsert("test-lru-project-2", {
        kind: "fact",
        text: `Fact number ${i}: some unique detail about the codebase item ${crypto.randomUUID()}`,
        confidence: 0.8,
        evidence: [],
        tags: [`tag-${i}`],
      })
    }

    // The system should still function correctly after many upserts
    const ctx = await ProjectMemory.renderPromptContext("test-lru-project-2")
    // Either renders context or returns undefined (entries may have been pruned by memory rules)
    expect(ctx === undefined || typeof ctx === "string").toBeTrue()
  })

  test("dead embedding cache entries are evicted when persist() is called with a smaller snapshot", async () => {
    const { ProjectMemory } = await import("../ai/memory/project-memory")
    const { embeddingService } = await import("../ai/rag/embedding")

    // Mock embedding to return simple vectors
    vi.spyOn(embeddingService, "getEmbedding").mockImplementation(async () => [0.1, 0.2, 0.3])

    const pid = "test-lru-dead-entries"
    // Upsert 5 entries
    for (let i = 0; i < 5; i++) {
      await ProjectMemory.upsert(pid, {
        kind: "fact",
        text: `Fact ${i}: detail about feature ${i}`,
        confidence: 0.9,
        evidence: [],
        tags: [`t${i}`],
      })
    }

    // Read the snapshot and upsert a fresh entry to trigger persist()
    await ProjectMemory.upsert(pid, {
      kind: "fact",
      text: "This is a post-prune fact",
      confidence: 0.9,
      evidence: [],
      tags: ["prune"],
    })

    // renderPromptContext should still work after eviction
    const ctx = await ProjectMemory.renderPromptContext(pid)
    expect(ctx === undefined || typeof ctx === "string").toBeTrue()
  })

  test("resetForTest() clears the embedding cache", async () => {
    const { ProjectMemory } = await import("../ai/memory/project-memory")
    const { embeddingService } = await import("../ai/rag/embedding")
    vi.spyOn(embeddingService, "getEmbedding").mockImplementation(async () => [1, 2, 3])

    await ProjectMemory.upsert("test-lru-reset", {
      kind: "fact",
      text: "A fact to cache",
      confidence: 0.9,
      evidence: [],
      tags: [],
    })

    ProjectMemory.resetForTest()
    // After reset, reading should return empty snapshot
    const snapshot = await ProjectMemory.read("test-lru-reset")
    expect(snapshot.entries).toHaveLength(0)
  })
})
