import { describe, expect, test } from "bun:test"
import { Chunker } from "../ai/rag/chunker"

describe("rag chunker line ranges", () => {
  test("uses 1-based line ranges with overlap", () => {
    const chunker = new Chunker({ minChunkSize: 2, maxChunkSize: 3, overlap: 1 })
    const content = ["one", "two", "three", "four", "five"].join("\n")

    const chunks = chunker.chunk(content, "/repo/demo.ts")

    expect(chunks[0]?.startLine).toBe(1)
    expect(chunks[0]?.endLine).toBe(3)
    expect(chunks[1]?.startLine).toBe(3)
    expect(chunks[1]?.endLine).toBe(5)
  })
})