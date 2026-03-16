import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { VectorStore } from "../ai/rag/vector-store"

const cleanup: string[] = []

afterEach(async () => {
  while (cleanup.length > 0) {
    const dir = cleanup.pop()
    if (dir) {
      await fs.rm(dir, { recursive: true, force: true })
    }
  }
})

describe("vector store persistence", () => {
  test("persists project vectors and filters search by project", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-rag-vectors-"))
    cleanup.push(dir)

    const first = new VectorStore(100, 7, dir)
    await first.addVectors([
      {
        id: "p1-a",
        sessionId: "project-a",
        path: "/repo/a.ts",
        content: "alpha implementation",
        embedding: [1, 0],
        timestamp: Date.now(),
        startLine: 3,
        endLine: 7,
      },
      {
        id: "p2-a",
        sessionId: "project-b",
        path: "/repo/b.ts",
        content: "beta implementation",
        embedding: [0, 1],
        timestamp: Date.now(),
        startLine: 10,
        endLine: 12,
      },
    ])

    const second = new VectorStore(100, 7, dir)
    const projectAResults = await second.search([1, 0], { projectId: "project-a", limit: 5 })
    const projectBResults = await second.search([1, 0], { projectId: "project-b", limit: 5 })

    expect(projectAResults).toHaveLength(1)
    expect(projectAResults[0]?.path).toBe("/repo/a.ts")
    expect(projectAResults[0]?.startLine).toBe(3)
    expect(projectBResults).toHaveLength(0)
    expect(await second.getProjectSize("project-a")).toBe(1)
    expect(await second.getProjectSize("project-b")).toBe(1)
  })

  test("reranks coarse candidates with profile-specific fine vectors", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-rag-rerank-"))
    cleanup.push(dir)

    const store = new VectorStore(100, 7, dir, false)
    await store.addVectors([
      {
        id: "doc-a",
        sessionId: "project-a",
        path: "/repo/a.md",
        content: "first doc",
        coarseQuantized: [127, 0],
        fineQuantized: [127, 0],
        fineDimensions: 2,
        retrievalProfile: "text",
        timestamp: Date.now(),
      },
      {
        id: "doc-b",
        sessionId: "project-a",
        path: "/repo/b.md",
        content: "second doc",
        coarseQuantized: [127, 0],
        fineQuantized: [0, 127],
        fineDimensions: 2,
        retrievalProfile: "text",
        timestamp: Date.now(),
      },
    ])

    const results = await store.search(
      {
        coarse: [1, 0],
        fineByProfile: {
          code: [1, 0],
          text: [0, 1],
        },
      },
      { projectId: "project-a", limit: 2 },
    )

    expect(results).toHaveLength(2)
    expect(results[0]?.path).toBe("/repo/b.md")
    expect((results[0]?.fineScore ?? 0)).toBeGreaterThan(results[1]?.fineScore ?? 0)
  })
})