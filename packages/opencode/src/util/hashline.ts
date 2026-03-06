import { crc32 } from "./crc32"

// Lazy init log to avoid circular deps in tests
let _log: { debug: (msg: string, data?: object) => void } | null = null
function getLog(): { debug: (msg: string, data?: object) => void } {
  if (_log) return _log
  try {
    const { Log } = require("./log")
    _log = Log.create({ service: "hashline" })
  } catch {
    _log = { debug: () => {} }
  }
  return _log!
}

export interface HashLineConfig {
  hashLength: number
  maxCacheSize: number
}

const DEFAULT_CONFIG: HashLineConfig = {
  hashLength: 3,
  maxCacheSize: 1000,
}

export interface HashedLine {
  number: number
  hash: string
  content: string
}

export interface HashedFile {
  path: string
  lines: HashedLine[]
  revision: string
}

export interface VerifyResult {
  valid: boolean
  code?: "HASH_MISMATCH" | "LINE_NOT_FOUND" | "FILE_NOT_FOUND" | "BLOCK_MISMATCH"
  actualHash?: string
  candidates?: Array<{ number: number; hash: string }>
}

export interface HashedBlock {
  startLine: number
  endLine: number
  startHash: string
  endHash: string
  blockHash: string
  content: string
  lineCount: number
  lines: HashedLine[]
}

export interface BlockRange {
  start: { line: number; hash: string }
  end: { line: number; hash: string }
}

class HashlineCache {
  private cache = new Map<string, { content: string; revision: string; lines: HashedLine[] }>()
  private maxSize: number

  constructor(maxSize: number = 1000) {
    this.maxSize = maxSize
  }

  get(path: string, content: string): HashedLine[] | null {
    const entry = this.cache.get(path)
    if (!entry) return null

    const currentRev = this.computeRevision(content)
    if (entry.revision !== currentRev) {
      this.cache.delete(path)
      return null
    }

    this.cache.delete(path)
    this.cache.set(path, entry)
    return entry.lines
  }

  set(path: string, content: string, lines: HashedLine[]): void {
    if (this.cache.size >= this.maxSize) {
      const firstKey = this.cache.keys().next().value
      if (firstKey) this.cache.delete(firstKey)
    }

    this.cache.set(path, {
      content,
      revision: this.computeRevision(content),
      lines,
    })
  }

  invalidate(path: string): void {
    this.cache.delete(path)
  }

  private computeRevision(content: string): string {
    return crc32(content).toString(16).padStart(8, "0")
  }
}

export class Hashline {
  private config: HashLineConfig
  private cache: HashlineCache

  constructor(cfg: Partial<HashLineConfig> = {}) {
    this.config = { ...DEFAULT_CONFIG, ...cfg }
    this.cache = new HashlineCache(this.config.maxCacheSize)
  }

  computeLineHash(lineNumber: number, content: string): string {
    const trimmed = content.trimEnd()
    const input = `${lineNumber}:${trimmed}`
    const hash = crc32(input)
    const modulus = Math.pow(16, this.config.hashLength)
    return (hash % modulus).toString(16).padStart(this.config.hashLength, "0")
  }

  computeFileRevision(content: string): string {
    const normalized = content.replace(/\r\n/g, "\n")
    return crc32(normalized).toString(16).padStart(8, "0")
  }

  hashFile(path: string, content: string): HashedFile {
    const cached = this.cache.get(path, content)
    if (cached) {
      return {
        path,
        lines: cached,
        revision: this.computeFileRevision(content),
      }
    }

    const lines = content.split("\n")
    const hashedLines: HashedLine[] = []
    const seen = new Map<string, number>()

    for (let i = 0; i < lines.length; i++) {
      let hash = this.computeLineHash(i + 1, lines[i])

      if (seen.has(hash)) {
        const longerLen = Math.min(this.config.hashLength + 1, 8)
        const prevIdx = seen.get(hash)!
        hashedLines[prevIdx].hash = this.computeLineHashWithLength(prevIdx + 1, lines[prevIdx], longerLen)
        hash = this.computeLineHashWithLength(i + 1, lines[i], longerLen)
      }

      seen.set(hash, i)
      hashedLines.push({
        number: i + 1,
        hash,
        content: lines[i],
      })
    }

    this.cache.set(path, content, hashedLines)

    return {
      path,
      lines: hashedLines,
      revision: this.computeFileRevision(content),
    }
  }

  private computeLineHashWithLength(lineNumber: number, content: string, hashLength: number): string {
    const trimmed = content.trimEnd()
    const input = `${lineNumber}:${trimmed}`
    const hash = crc32(input)
    const modulus = Math.pow(16, hashLength)
    return (hash % modulus).toString(16).padStart(hashLength, "0")
  }

  verify(path: string, lineNumber: number, hash: string, content: string): VerifyResult {
    const lines = content.split("\n")

    if (lineNumber < 1 || lineNumber > lines.length) {
      return { valid: false, code: "LINE_NOT_FOUND" }
    }

    const idx = lineNumber - 1
    const actualHash = this.computeLineHashWithLength(lineNumber, lines[idx], hash.length)

    if (actualHash === hash) {
      return { valid: true }
    }

    const candidates: Array<{ number: number; hash: string }> = []
    for (let i = 0; i < lines.length; i++) {
      const h = this.computeLineHashWithLength(i + 1, lines[i], hash.length)
      if (h === hash) {
        candidates.push({ number: i + 1, hash: h })
      }
    }

    getLog().debug("hash mismatch", {
      path,
      expected: lineNumber,
      expectedHash: hash,
      actualHash,
      candidates: candidates.length,
    })

    return {
      valid: false,
      code: "HASH_MISMATCH",
      actualHash,
      candidates,
    }
  }

  findLineByHash(path: string, hash: string, content: string): Array<{ number: number; content: string }> {
    const lines = content.split("\n")
    const results: Array<{ number: number; content: string }> = []

    for (let i = 0; i < lines.length; i++) {
      const h = this.computeLineHashWithLength(i + 1, lines[i], hash.length)
      if (h === hash) {
        results.push({ number: i + 1, content: lines[i] })
      }
    }

    return results
  }

  formatLine(hashedLine: HashedLine): string {
    return `${hashedLine.number}#${hashedLine.hash}|${hashedLine.content}`
  }

  formatFile(hashedFile: HashedFile): string {
    return hashedFile.lines.map((line) => this.formatLine(line)).join("\n")
  }

  parseFormattedLine(line: string): HashedLine | null {
    const match = line.match(/^(\d+)#([a-f0-9]+)\|(.*)$/)
    if (!match) return null

    return {
      number: parseInt(match[1], 10),
      hash: match[2],
      content: match[3],
    }
  }

  parseFormattedRange(range: string): BlockRange | null {
    const match = range.match(/^(\d+)#([a-f0-9]+)-(\d+)#([a-f0-9]+)$/)
    if (!match) return null

    return {
      start: { line: parseInt(match[1], 10), hash: match[2] },
      end: { line: parseInt(match[3], 10), hash: match[4] },
    }
  }

  computeBlockHash(startLine: number, endLine: number, fileContent: string): HashedBlock {
    const lines = fileContent.split("\n")

    if (startLine < 1 || endLine > lines.length || startLine > endLine) {
      throw new Error(`Invalid block range: ${startLine}-${endLine} (file has ${lines.length} lines)`)
    }

    const blockLines = lines.slice(startLine - 1, endLine)
    const content = blockLines.join("\n")
    const blockHash = crc32(content).toString(16).padStart(8, "0")

    const hashedLines: HashedLine[] = blockLines.map((line, i) => ({
      number: startLine + i,
      hash: this.computeLineHash(startLine + i, line),
      content: line,
    }))

    return {
      startLine,
      endLine,
      startHash: hashedLines[0].hash,
      endHash: hashedLines[hashedLines.length - 1].hash,
      blockHash,
      content,
      lineCount: blockLines.length,
      lines: hashedLines,
    }
  }

  verifyBlock(path: string, block: HashedBlock, fileContent: string): VerifyResult {
    const lines = fileContent.split("\n")

    if (block.startLine < 1 || block.endLine > lines.length) {
      return { valid: false, code: "LINE_NOT_FOUND" }
    }

    const startResult = this.verify(path, block.startLine, block.startHash, fileContent)
    if (!startResult.valid) {
      return { ...startResult, code: "HASH_MISMATCH" }
    }

    const endResult = this.verify(path, block.endLine, block.endHash, fileContent)
    if (!endResult.valid) {
      return { ...endResult, code: "HASH_MISMATCH" }
    }

    const currentBlock = this.computeBlockHash(block.startLine, block.endLine, fileContent)
    if (currentBlock.blockHash !== block.blockHash) {
      return {
        valid: false,
        code: "BLOCK_MISMATCH",
        actualHash: currentBlock.blockHash,
      }
    }

    return { valid: true }
  }

  verifyRange(path: string, range: BlockRange, fileContent: string): VerifyResult {
    const lines = fileContent.split("\n")

    const startResult = this.verify(path, range.start.line, range.start.hash, fileContent)
    if (!startResult.valid) return startResult

    const endResult = this.verify(path, range.end.line, range.end.hash, fileContent)
    if (!endResult.valid) return endResult

    return { valid: true }
  }

  formatBlock(block: HashedBlock): string {
    const header = `@@ ${block.startLine}#${block.startHash}-${block.endLine}#${block.endHash} @@`
    const lines = block.lines.map((l) => this.formatLine(l)).join("\n")
    return `${header}\n${lines}`
  }

  parseFormattedBlock(text: string): HashedBlock | null {
    const lines = text.split("\n")
    if (lines.length === 0) return null

    const headerMatch = lines[0].match(/^@@ (\d+)#([a-f0-9]+)-(\d+)#([a-f0-9]+) @@$/)
    if (!headerMatch) return null

    const startLine = parseInt(headerMatch[1], 10)
    const endLine = parseInt(headerMatch[3], 10)
    const startHash = headerMatch[2]
    const endHash = headerMatch[4]

    const parsedLines: HashedLine[] = []
    for (let i = 1; i < lines.length; i++) {
      const parsed = this.parseFormattedLine(lines[i])
      if (parsed) parsedLines.push(parsed)
    }

    if (parsedLines.length === 0) return null

    const content = parsedLines.map((l) => l.content).join("\n")
    const blockHash = crc32(content).toString(16).padStart(8, "0")

    return {
      startLine,
      endLine,
      startHash,
      endHash,
      blockHash,
      content,
      lineCount: parsedLines.length,
      lines: parsedLines,
    }
  }

  invalidateCache(path: string): void {
    this.cache.invalidate(path)
  }
}

const globalHashline = new Hashline()

export function getHashline(): Hashline {
  return globalHashline
}

export function computeLineHash(lineNumber: number, content: string): string {
  return globalHashline.computeLineHash(lineNumber, content)
}

export function hashFile(path: string, content: string): HashedFile {
  return globalHashline.hashFile(path, content)
}

export function verifyHash(path: string, lineNumber: number, hash: string, content: string): VerifyResult {
  return globalHashline.verify(path, lineNumber, hash, content)
}

export function computeBlockHash(startLine: number, endLine: number, content: string): HashedBlock {
  return globalHashline.computeBlockHash(startLine, endLine, content)
}

export function verifyBlock(path: string, block: HashedBlock, content: string): VerifyResult {
  return globalHashline.verifyBlock(path, block, content)
}

export function parseFormattedRange(range: string): BlockRange | null {
  return globalHashline.parseFormattedRange(range)
}
