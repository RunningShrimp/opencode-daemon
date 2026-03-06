import { describe, test, expect, beforeEach } from "bun:test"
import { Hashline, getHashline, computeLineHash, hashFile, verifyHash } from "../util/hashline"

describe("hashline", () => {
  let hl: Hashline

  beforeEach(() => {
    hl = new Hashline()
  })

  describe("computeLineHash", () => {
    test("returns consistent hash for same input", () => {
      const h1 = hl.computeLineHash(1, "hello world")
      const h2 = hl.computeLineHash(1, "hello world")
      expect(h1).toBe(h2)
    })

    test("returns different hash for different line numbers", () => {
      const h1 = hl.computeLineHash(1, "hello")
      const h2 = hl.computeLineHash(2, "hello")
      expect(h1).not.toBe(h2)
    })

    test("returns different hash for different content", () => {
      const h1 = hl.computeLineHash(1, "hello")
      const h2 = hl.computeLineHash(1, "world")
      expect(h1).not.toBe(h2)
    })

    test("ignores trailing whitespace", () => {
      const h1 = hl.computeLineHash(1, "hello")
      const h2 = hl.computeLineHash(1, "hello   ")
      expect(h1).toBe(h2)
    })

    test("returns hex string of configured length", () => {
      const h = hl.computeLineHash(1, "test")
      expect(h).toMatch(/^[a-f0-9]+$/)
      expect(h.length).toBe(3)
    })

    test("handles empty content", () => {
      const h = hl.computeLineHash(1, "")
      expect(h).toMatch(/^[a-f0-9]+$/)
    })

    test("handles unicode content", () => {
      const h = hl.computeLineHash(1, "你好世界")
      expect(h).toMatch(/^[a-f0-9]+$/)
    })
  })

  describe("hashFile", () => {
    test("returns hashed file with all lines", () => {
      const content = "line1\nline2\nline3"
      const result = hl.hashFile("test.txt", content)

      expect(result.path).toBe("test.txt")
      expect(result.lines).toHaveLength(3)
      expect(result.revision).toMatch(/^[a-f0-9]{8}$/)
    })

    test("each line has number, hash, and content", () => {
      const content = "line1\nline2"
      const result = hl.hashFile("test.txt", content)

      expect(result.lines[0].number).toBe(1)
      expect(result.lines[0].hash).toMatch(/^[a-f0-9]+$/)
      expect(result.lines[0].content).toBe("line1")

      expect(result.lines[1].number).toBe(2)
      expect(result.lines[1].content).toBe("line2")
    })

    test("handles empty file", () => {
      const result = hl.hashFile("empty.txt", "")
      expect(result.lines).toHaveLength(1)
      expect(result.lines[0].content).toBe("")
    })

    test("handles single line file", () => {
      const result = hl.hashFile("single.txt", "only line")
      expect(result.lines).toHaveLength(1)
    })

    test("uses cache for repeated calls", () => {
      const content = "cached content"
      const r1 = hl.hashFile("cached.txt", content)
      const r2 = hl.hashFile("cached.txt", content)
      expect(r1.lines).toBe(r2.lines)
    })

    test("invalidates cache on content change", () => {
      hl.hashFile("changed.txt", "old content")
      const result = hl.hashFile("changed.txt", "new content")
      expect(result.lines[0].content).toBe("new content")
    })
  })

  describe("verify", () => {
    test("returns valid for matching hash", () => {
      const content = "test line"
      const hash = hl.computeLineHash(1, content)
      const result = hl.verify("test.txt", 1, hash, content)
      expect(result.valid).toBe(true)
    })

    test("returns invalid for mismatched hash", () => {
      const content = "test line"
      const result = hl.verify("test.txt", 1, "abc", content)
      expect(result.valid).toBe(false)
      expect(result.code).toBe("HASH_MISMATCH")
    })

    test("returns invalid for out of range line number", () => {
      const content = "only one line"
      const result = hl.verify("test.txt", 10, "abc", content)
      expect(result.valid).toBe(false)
      expect(result.code).toBe("LINE_NOT_FOUND")
    })

    test("returns candidates on hash mismatch", () => {
      const content = "line1\nline2\nline3"
      const hashed = hl.hashFile("test.txt", content)
      const targetHash = hashed.lines[1].hash

      const result = hl.verify("test.txt", 1, targetHash, content)
      expect(result.valid).toBe(false)
      expect(result.candidates).toBeDefined()
      expect(result.candidates!.some((c) => c.number === 2)).toBe(true)
    })

    test("handles line number zero", () => {
      const content = "content"
      const result = hl.verify("test.txt", 0, "abc", content)
      expect(result.valid).toBe(false)
      expect(result.code).toBe("LINE_NOT_FOUND")
    })
  })

  describe("findLineByHash", () => {
    test("finds line with matching hash", () => {
      const content = "line1\nline2\nline3"
      const hashed = hl.hashFile("test.txt", content)
      const targetHash = hashed.lines[1].hash

      const results = hl.findLineByHash("test.txt", targetHash, content)
      expect(results).toHaveLength(1)
      expect(results[0].number).toBe(2)
      expect(results[0].content).toBe("line2")
    })

    test("returns empty array for non-existent hash", () => {
      const content = "line1\nline2"
      const results = hl.findLineByHash("test.txt", "zzz", content)
      expect(results).toHaveLength(0)
    })
  })

  describe("formatLine", () => {
    test("formats line as number#hash|content", () => {
      const formatted = hl.formatLine({ number: 5, hash: "a1b", content: "hello world" })
      expect(formatted).toBe("5#a1b|hello world")
    })
  })

  describe("parseFormattedLine", () => {
    test("parses formatted line correctly", () => {
      const result = hl.parseFormattedLine("5#a1b|hello world")
      expect(result).not.toBeNull()
      expect(result!.number).toBe(5)
      expect(result!.hash).toBe("a1b")
      expect(result!.content).toBe("hello world")
    })

    test("returns null for invalid format", () => {
      expect(hl.parseFormattedLine("invalid")).toBeNull()
      expect(hl.parseFormattedLine("5a1b|content")).toBeNull()
      expect(hl.parseFormattedLine("5#abc")).toBeNull()
    })
  })

  describe("formatFile", () => {
    test("formats entire file", () => {
      const content = "line1\nline2"
      const hashed = hl.hashFile("test.txt", content)
      const formatted = hl.formatFile(hashed)

      expect(formatted).toContain("1#")
      expect(formatted).toContain("|line1")
      expect(formatted).toContain("2#")
      expect(formatted).toContain("|line2")
    })
  })

  describe("computeFileRevision", () => {
    test("returns consistent revision for same content", () => {
      const r1 = hl.computeFileRevision("content")
      const r2 = hl.computeFileRevision("content")
      expect(r1).toBe(r2)
    })

    test("returns 8-character hex string", () => {
      const rev = hl.computeFileRevision("content")
      expect(rev).toMatch(/^[a-f0-9]{8}$/)
    })

    test("normalizes line endings", () => {
      const r1 = hl.computeFileRevision("line1\nline2")
      const r2 = hl.computeFileRevision("line1\r\nline2")
      expect(r1).toBe(r2)
    })
  })

  describe("global exports", () => {
    test("getHashline returns singleton", () => {
      const h1 = getHashline()
      const h2 = getHashline()
      expect(h1).toBe(h2)
    })

    test("computeLineHash export works", () => {
      const h = computeLineHash(1, "test")
      expect(h).toMatch(/^[a-f0-9]+$/)
    })

    test("hashFile export works", () => {
      const result = hashFile("test.txt", "content")
      expect(result.lines).toHaveLength(1)
    })

    test("verifyHash export works", () => {
      const content = "test"
      const h = computeLineHash(1, content)
      const result = verifyHash("test.txt", 1, h, content)
      expect(result.valid).toBe(true)
    })
  })

  describe("invalidateCache", () => {
    test("removes cached entry", () => {
      const content = "cached"
      hl.hashFile("test.txt", content)
      hl.invalidateCache("test.txt")

      const result = hl.hashFile("test.txt", "different")
      expect(result.lines[0].content).toBe("different")
    })
  })

  describe("computeBlockHash", () => {
    test("computes block hash for single line", () => {
      const content = "line1"
      const block = hl.computeBlockHash(1, 1, content)

      expect(block.startLine).toBe(1)
      expect(block.endLine).toBe(1)
      expect(block.lineCount).toBe(1)
      expect(block.blockHash).toMatch(/^[a-f0-9]{8}$/)
      expect(block.content).toBe("line1")
    })

    test("computes block hash for multiple lines", () => {
      const content = "line1\nline2\nline3"
      const block = hl.computeBlockHash(1, 3, content)

      expect(block.startLine).toBe(1)
      expect(block.endLine).toBe(3)
      expect(block.lineCount).toBe(3)
      expect(block.lines).toHaveLength(3)
      expect(block.content).toBe("line1\nline2\nline3")
    })

    test("computes block hash for partial range", () => {
      const content = "line1\nline2\nline3\nline4"
      const block = hl.computeBlockHash(2, 3, content)

      expect(block.startLine).toBe(2)
      expect(block.endLine).toBe(3)
      expect(block.content).toBe("line2\nline3")
    })

    test("start and end hashes match line hashes", () => {
      const content = "line1\nline2\nline3"
      const block = hl.computeBlockHash(1, 3, content)

      expect(block.startHash).toBe(block.lines[0].hash)
      expect(block.endHash).toBe(block.lines[2].hash)
    })

    test("throws for invalid range", () => {
      const content = "line1\nline2"

      expect(() => hl.computeBlockHash(0, 2, content)).toThrow()
      expect(() => hl.computeBlockHash(1, 5, content)).toThrow()
      expect(() => hl.computeBlockHash(3, 2, content)).toThrow()
    })
  })

  describe("verifyBlock", () => {
    test("returns valid for unchanged block", () => {
      const content = "line1\nline2\nline3"
      const block = hl.computeBlockHash(1, 3, content)
      const result = hl.verifyBlock("test.txt", block, content)
      expect(result.valid).toBe(true)
    })

    test("returns invalid when start line changed", () => {
      const content = "line1\nline2\nline3"
      const block = hl.computeBlockHash(1, 3, content)
      const modified = "CHANGED\nline2\nline3"
      const result = hl.verifyBlock("test.txt", block, modified)
      expect(result.valid).toBe(false)
      expect(result.code).toBe("HASH_MISMATCH")
    })

    test("returns invalid when end line changed", () => {
      const content = "line1\nline2\nline3"
      const block = hl.computeBlockHash(1, 3, content)
      const modified = "line1\nline2\nCHANGED"
      const result = hl.verifyBlock("test.txt", block, modified)
      expect(result.valid).toBe(false)
      expect(result.code).toBe("HASH_MISMATCH")
    })

    test("returns invalid when middle changed (block hash mismatch)", () => {
      const content = "line1\nline2\nline3"
      const block = hl.computeBlockHash(1, 3, content)
      const modified = "line1\nCHANGED\nline3"
      const result = hl.verifyBlock("test.txt", block, modified)
      expect(result.valid).toBe(false)
      expect(result.code).toBe("BLOCK_MISMATCH")
    })
  })

  describe("parseFormattedRange", () => {
    test("parses valid range", () => {
      const result = hl.parseFormattedRange("10#a3f-15#b2c")
      expect(result).not.toBeNull()
      expect(result!.start.line).toBe(10)
      expect(result!.start.hash).toBe("a3f")
      expect(result!.end.line).toBe(15)
      expect(result!.end.hash).toBe("b2c")
    })

    test("returns null for invalid format", () => {
      expect(hl.parseFormattedRange("invalid")).toBeNull()
      expect(hl.parseFormattedRange("10-a3f")).toBeNull()
      expect(hl.parseFormattedRange("10#a3f")).toBeNull()
    })
  })

  describe("formatBlock", () => {
    test("formats block with header", () => {
      const content = "line1\nline2"
      const block = hl.computeBlockHash(1, 2, content)
      const formatted = hl.formatBlock(block)

      expect(formatted).toContain("@@ 1#")
      expect(formatted).toContain("-2#")
      expect(formatted).toContain("@@")
    })
  })

  describe("parseFormattedBlock", () => {
    test("parses formatted block", () => {
      const content = "line1\nline2"
      const block = hl.computeBlockHash(1, 2, content)
      const formatted = hl.formatBlock(block)
      const parsed = hl.parseFormattedBlock(formatted)

      expect(parsed).not.toBeNull()
      expect(parsed!.startLine).toBe(block.startLine)
      expect(parsed!.endLine).toBe(block.endLine)
      expect(parsed!.startHash).toBe(block.startHash)
      expect(parsed!.endHash).toBe(block.endHash)
    })

    test("returns null for invalid format", () => {
      expect(hl.parseFormattedBlock("invalid")).toBeNull()
      expect(hl.parseFormattedBlock("no header here\n1#a3f|content")).toBeNull()
    })
  })

  describe("verifyRange", () => {
    test("returns valid for matching range", () => {
      const content = "line1\nline2\nline3"
      const block = hl.computeBlockHash(1, 3, content)
      const range = {
        start: { line: block.startLine, hash: block.startHash },
        end: { line: block.endLine, hash: block.endHash },
      }
      const result = hl.verifyRange("test.txt", range, content)
      expect(result.valid).toBe(true)
    })

    test("returns invalid for mismatched start", () => {
      const content = "line1\nline2\nline3"
      const range = {
        start: { line: 1, hash: "xxx" },
        end: { line: 3, hash: "yyy" },
      }
      const result = hl.verifyRange("test.txt", range, content)
      expect(result.valid).toBe(false)
    })
  })
})
