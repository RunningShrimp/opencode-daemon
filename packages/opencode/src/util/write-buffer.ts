let _log: { debug: (msg: string, data?: object) => void; error: (msg: string, data?: object) => void } | null = null
function getLog() {
  if (!_log) {
    try {
      const { Log } = require("./log")
      _log = Log.create({ service: "write-buffer" })
    } catch {
      _log = { debug: () => {}, error: () => {} }
    }
  }
  return _log!
}

export interface BufferConfig {
  maxSize: number
  flushInterval: number
  maxFlushTime: number
  minFlushSize: number
}

export const DEFAULT_CONFIG: BufferConfig = {
  maxSize: 256 * 1024,
  flushInterval: 1000,
  maxFlushTime: 5000,
  minFlushSize: 1024,
}

type FlushFn = (data: Buffer) => void | Promise<void>

export class WriteBuffer {
  private buf: Buffer
  private pos = 0
  private cfg: BufferConfig
  private timer: ReturnType<typeof setTimeout> | null = null
  private lastFlush = 0
  private callback: FlushFn | null = null
  private flushing = false
  private written = 0
  private flushed = 0

  constructor(cfg: Partial<BufferConfig> = {}, cb?: FlushFn) {
    this.cfg = { ...DEFAULT_CONFIG, ...cfg }
    this.buf = Buffer.allocUnsafe(this.cfg.maxSize)
    this.callback = cb || null
  }

  onFlush(cb: FlushFn): void {
    this.callback = cb
  }

  write(data: string | Buffer): number {
    const chunk = typeof data === "string" ? Buffer.from(data) : data
    let offset = 0

    if (chunk.length >= this.cfg.maxSize) {
      this.flushSync()
      if (this.callback) {
        const copy = Buffer.from(chunk)
        this.callback(copy)
        this.flushed += chunk.length
      }
      this.written += chunk.length
      return chunk.length
    }

    while (offset < chunk.length) {
      const remaining = chunk.length - offset
      const available = this.cfg.maxSize - this.pos

      if (available === 0) {
        this.flushSync()
        continue
      }

      const toWrite = Math.min(remaining, available)
      chunk.copy(this.buf, this.pos, offset, offset + toWrite)
      this.pos += toWrite
      offset += toWrite
      this.written += toWrite
    }

    if (this.pos >= this.cfg.minFlushSize) {
      this.scheduleFlush()
    }

    return chunk.length
  }

  private flushSync(): void {
    if (this.pos === 0) return

    const data = this.buf.slice(0, this.pos)
    if (this.callback) {
      this.callback(data)
    }
    this.flushed += data.length
    this.pos = 0
    this.lastFlush = Date.now()
  }

  private scheduleFlush(): void {
    if (this.timer || this.flushing) return

    this.timer = setTimeout(() => {
      this.flush()
    }, this.cfg.flushInterval)
  }

  async flush(): Promise<void> {
    if (this.pos === 0 || this.flushing) return

    this.flushing = true

    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }

    try {
      const data = this.buf.slice(0, this.pos)

      if (this.callback) {
        await this.callback(data)
      }

      this.pos = 0
      this.lastFlush = Date.now()
      this.flushed += data.length

      getLog().debug("flushed", { size: data.length })
    } catch (error) {
      getLog().error("flush error", { error })
      throw error
    } finally {
      this.flushing = false
    }
  }

  get size(): number {
    return this.pos
  }

  get isEmpty(): boolean {
    return this.pos === 0
  }

  getStats(): { current: number; max: number; written: number; flushed: number; flushing: boolean } {
    return {
      current: this.pos,
      max: this.cfg.maxSize,
      written: this.written,
      flushed: this.flushed,
      flushing: this.flushing,
    }
  }

  async destroy(): Promise<void> {
    await this.flush()

    if (this.timer) {
      clearTimeout(this.timer)
      this.timer = null
    }

    this.buf = Buffer.allocUnsafe(0)
    this.callback = null
  }
}

export function createFileBuffer(path: string, cfg?: Partial<BufferConfig>): WriteBuffer {
  const { writeFileSync } = require("fs")

  return new WriteBuffer(cfg, (data: Buffer) => {
    writeFileSync(path, data, { flag: "a" })
  })
}
