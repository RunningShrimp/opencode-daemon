import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { WriteBuffer, DEFAULT_CONFIG, type BufferConfig } from "../util/write-buffer"

describe("WriteBuffer", () => {
  let buffer: WriteBuffer
  let flushedData: Buffer[] = []

  beforeEach(() => {
    flushedData = []
    buffer = new WriteBuffer(
      {
        maxSize: 256,
        flushInterval: 100,
        maxFlushTime: 500,
        minFlushSize: 50,
      },
      (data) => {
        flushedData.push(data)
        return Promise.resolve()
      },
    )
  })

  afterEach(async () => {
    await buffer.destroy()
  })

  describe("initialization", () => {
    test("initializes with default config", () => {
      const b = new WriteBuffer()
      const stats = b.getStats()
      expect(stats.max).toBe(DEFAULT_CONFIG.maxSize)
      expect(stats.current).toBe(0)
      expect(stats.written).toBe(0)
      expect(stats.flushed).toBe(0)
    })

    test("initializes with custom config", () => {
      const cfg: Partial<BufferConfig> = {
        maxSize: 1024,
        flushInterval: 500,
        maxFlushTime: 2000,
        minFlushSize: 256,
      }
      const b = new WriteBuffer(cfg)
      const stats = b.getStats()
      expect(stats.max).toBe(1024)
    })

    test("accepts callback in constructor", async () => {
      let called = false
      const b = new WriteBuffer({}, (data) => {
        called = true
        return Promise.resolve()
      })

      b.write("x".repeat(100))
      await b.flush()
      expect(called).toBe(true)
    })
  })

  describe("write", () => {
    test("writes string data", () => {
      const written = buffer.write("hello")
      expect(written).toBe(5)
      expect(buffer.size).toBe(5)
    })

    test("writes buffer data", () => {
      const written = buffer.write(Buffer.from("hello"))
      expect(written).toBe(5)
      expect(buffer.size).toBe(5)
    })

    test("accumulates multiple writes", () => {
      buffer.write("hello")
      buffer.write(" ")
      buffer.write("world")
      expect(buffer.size).toBe(11)
    })

    test("handles write larger than minFlushSize", async () => {
      buffer.write("x".repeat(60))
      await sleep(150)

      expect(flushedData.length).toBe(1)
    })

    test("tracks total written bytes", () => {
      buffer.write("hello")
      buffer.write("world")
      const stats = buffer.getStats()
      expect(stats.written).toBe(10)
    })
  })

  describe("flush", () => {
    test("flushes data via callback", async () => {
      buffer.write("test data")
      await buffer.flush()

      expect(flushedData.length).toBe(1)
      expect(flushedData[0].toString()).toBe("test data")
    })

    test("clears buffer after flush", async () => {
      buffer.write("test")
      await buffer.flush()

      expect(buffer.isEmpty).toBe(true)
      expect(buffer.size).toBe(0)
    })

    test("updates flushed count", async () => {
      buffer.write("test")
      await buffer.flush()

      const stats = buffer.getStats()
      expect(stats.flushed).toBe(4)
    })

    test("does not flush empty buffer", async () => {
      await buffer.flush()
      expect(flushedData.length).toBe(0)
    })

    test("handles concurrent flush calls", async () => {
      buffer.write("test")
      await Promise.all([buffer.flush(), buffer.flush(), buffer.flush()])

      expect(flushedData.length).toBe(1)
    })
  })

  describe("scheduled flush", () => {
    test("schedules flush when minFlushSize reached", async () => {
      buffer.write("x".repeat(60))
      await sleep(150)

      expect(flushedData.length).toBe(1)
    })

    test("does not schedule for small writes", async () => {
      buffer.write("small")
      await sleep(150)

      expect(flushedData.length).toBe(0)
    })
  })

  describe("isEmpty", () => {
    test("returns true for empty buffer", () => {
      expect(buffer.isEmpty).toBe(true)
    })

    test("returns false after write", () => {
      buffer.write("test")
      expect(buffer.isEmpty).toBe(false)
    })

    test("returns true after flush", async () => {
      buffer.write("test")
      await buffer.flush()
      expect(buffer.isEmpty).toBe(true)
    })
  })

  describe("getStats", () => {
    test("returns complete statistics", async () => {
      buffer.write("hello")
      buffer.write("world")
      await buffer.flush()

      const stats = buffer.getStats()
      expect(stats.current).toBe(0)
      expect(stats.max).toBe(256)
      expect(stats.written).toBe(10)
      expect(stats.flushed).toBe(10)
      expect(stats.flushing).toBe(false)
    })
  })

  describe("destroy", () => {
    test("flushes remaining data on destroy", async () => {
      buffer.write("remaining")
      await buffer.destroy()

      expect(flushedData.length).toBe(1)
      expect(flushedData[0].toString()).toBe("remaining")
    })

    test("clears timer on destroy", async () => {
      buffer.write("x".repeat(60))
      await buffer.destroy()

      const stats = buffer.getStats()
      expect(stats.flushing).toBe(false)
    })
  })

  describe("onFlush", () => {
    test("allows setting callback after construction", async () => {
      let called = false
      const b = new WriteBuffer({ maxSize: 100, minFlushSize: 10 })
      b.onFlush(() => {
        called = true
        return Promise.resolve()
      })

      b.write("x".repeat(20))
      await b.flush()
      expect(called).toBe(true)
      await b.destroy()
    })
  })

  describe("edge cases", () => {
    test("handles empty string write", () => {
      const written = buffer.write("")
      expect(written).toBe(0)
      expect(buffer.size).toBe(0)
    })

    test("handles large single write", async () => {
      const large = "x".repeat(300)
      buffer.write(large)
      await buffer.flush()

      expect(flushedData.length).toBe(1)
    })
  })
})

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}
