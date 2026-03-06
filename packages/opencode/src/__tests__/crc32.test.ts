import { describe, test, expect } from "bun:test"
import { crc32 } from "../util/crc32"

describe("crc32", () => {
  test("returns consistent hash for same input", () => {
    const result1 = crc32("hello world")
    const result2 = crc32("hello world")
    expect(result1).toBe(result2)
  })

  test("returns different hash for different input", () => {
    const result1 = crc32("hello")
    const result2 = crc32("world")
    expect(result1).not.toBe(result2)
  })

  test("handles empty string", () => {
    const result = crc32("")
    expect(typeof result).toBe("number")
    expect(result).toBeGreaterThanOrEqual(0)
  })

  test("handles single character", () => {
    const result = crc32("a")
    expect(typeof result).toBe("number")
    expect(result).toBeGreaterThanOrEqual(0)
  })

  test("handles unicode characters", () => {
    const result = crc32("你好世界")
    expect(typeof result).toBe("number")
    expect(result).toBeGreaterThanOrEqual(0)
  })

  test("handles long strings", () => {
    const long = "x".repeat(10000)
    const result = crc32(long)
    expect(typeof result).toBe("number")
    expect(result).toBeGreaterThanOrEqual(0)
  })

  test("returns unsigned 32-bit integer", () => {
    const result = crc32("test")
    expect(result).toBeGreaterThanOrEqual(0)
    expect(result).toBeLessThan(4294967296)
  })

  test("produces expected hash values", () => {
    expect(crc32("123456789")).toBe(0xcbf43926)
    expect(crc32("hello")).toBe(0x3610a686)
  })

  test("handles special characters", () => {
    const result = crc32("!@#$%^&*()")
    expect(typeof result).toBe("number")
    expect(result).toBeGreaterThanOrEqual(0)
  })

  test("handles newlines", () => {
    const result = crc32("line1\nline2\nline3")
    expect(typeof result).toBe("number")
    expect(result).toBeGreaterThanOrEqual(0)
  })
})
