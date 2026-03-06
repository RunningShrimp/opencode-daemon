export interface ChunkConfig {
  minChunkSize: number
  maxChunkSize: number
  overlap: number
  respectCodeStructure: boolean
}

const DEFAULT_CHUNK_CONFIG: ChunkConfig = {
  minChunkSize: 200,
  maxChunkSize: 1000,
  overlap: 50,
  respectCodeStructure: true,
}

export interface Chunk {
  id: string
  content: string
  path: string
  startLine: number
  endLine: number
  type: "code" | "text" | "mixed"
  metadata: Record<string, unknown>
}

export class Chunker {
  private config: ChunkConfig

  constructor(config: Partial<ChunkConfig> = {}) {
    this.config = { ...DEFAULT_CHUNK_CONFIG, ...config }
  }

  chunk(content: string, path: string): Chunk[] {
    const chunks: Chunk[] = []
    const lines = content.split("\n")

    if (lines.length <= this.config.minChunkSize) {
      return [
        {
          id: this.generateId(),
          content,
          path,
          startLine: 0,
          endLine: lines.length,
          type: this.detectType(content),
          metadata: {},
        },
      ]
    }

    let currentChunk: string[] = []
    let startLine = 0

    for (let i = 0; i < lines.length; i++) {
      currentChunk.push(lines[i])

      if (currentChunk.length >= this.config.maxChunkSize) {
        chunks.push(this.createChunk(currentChunk, path, startLine, i))
        startLine = i - this.config.overlap + 1
        currentChunk = lines.slice(Math.max(0, i - this.config.overlap))
      }
    }

    if (currentChunk.length >= this.config.minChunkSize) {
      chunks.push(this.createChunk(currentChunk, path, startLine, lines.length))
    }

    return chunks
  }

  private createChunk(lines: string[], path: string, startLine: number, endLine: number): Chunk {
    const content = lines.join("\n")
    return {
      id: this.generateId(),
      content,
      path,
      startLine,
      endLine,
      type: this.detectType(content),
      metadata: {},
    }
  }

  private detectType(content: string): "code" | "text" | "mixed" {
    const codeIndicators = /(function|class|const|let|if|for|while|import|export)/
    const textIndicators = /[a-zA-Z]{10,}/

    const hasCode = codeIndicators.test(content)
    const hasText = textIndicators.test(content) && !hasCode

    if (hasCode && hasText) return "mixed"
    if (hasCode) return "code"
    return "text"
  }

  private generateId(): string {
    return `chunk_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`
  }
}

export const chunker = new Chunker()
