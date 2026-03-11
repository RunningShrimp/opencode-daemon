/**
 * RAG Indexer - Indexes code files for semantic search
 */

import { Log } from "@/util/log"
import path from "path"
import { existsSync, readdirSync, readFileSync } from "fs"
import ignore from "ignore"
import { Chunker, chunker, type Chunk } from "./chunker"
import { VectorStore, type VectorEntry } from "./vector-store"
import { embeddingService, type EmbeddingService } from "./embedding"

const log = Log.create({ service: "rag-indexer" })

const CODE_EXTENSIONS = new Set([
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rb",
  ".go",
  ".rs",
  ".java",
  ".cpp",
  ".c",
  ".h",
  ".hpp",
  ".cs",
  ".php",
  ".swift",
  ".kt",
  ".scala",
  ".vue",
  ".svelte",
])

const DEFAULT_IGNORES = [
  "node_modules",
  ".git",
  "dist",
  "build",
  "out",
  ".next",
  ".nuxt",
  ".output",
  ".cache",
  ".turbo",
  "coverage",
  ".nyc_output",
  "__pycache__",
  ".pytest_cache",
  "venv",
  ".venv",
  "env",
  ".env",
  ".DS_Store",
  ".idea",
  ".vscode",
  "*.log",
  "*.lock",
  "package-lock.json",
  "bun.lock",
  "yarn.lock",
  "pnpm-lock.yaml",
]

export interface RAGIndexerConfig {
  rootDir: string
  projectId: string
  extensions?: Set<string>
  ignore?: string[]
  maxFiles?: number
  batchSize?: number
}

export interface IndexStats {
  filesScanned: number
  filesIndexed: number
  chunksCreated: number
  vectorsStored: number
  errors: number
  duration: number
}

export class RAGIndexer {
  private config: RAGIndexerConfig
  private vectorStore: VectorStore
  private embeddingService: EmbeddingService
  private chunker: Chunker
  private ignoreMatcher: ignore.Ignore

  constructor(config: RAGIndexerConfig, vectorStore: VectorStore, embeddingSvc?: EmbeddingService) {
    this.config = config
    this.vectorStore = vectorStore
    this.embeddingService = embeddingSvc || embeddingService
    this.chunker = chunker

    this.ignoreMatcher = ignore()
    this.ignoreMatcher.add(DEFAULT_IGNORES)
    if (config.ignore) {
      this.ignoreMatcher.add(config.ignore)
    }
  }

  private shouldIndex(filePath: string): boolean {
    const relativePath = path.relative(this.config.rootDir, filePath)
    if (this.ignoreMatcher.ignores(relativePath)) {
      return false
    }

    const ext = path.extname(filePath).toLowerCase()
    return (this.config.extensions || CODE_EXTENSIONS).has(ext)
  }

  private async scanDirectory(dir: string): Promise<string[]> {
    const files: string[] = []

    if (!existsSync(dir)) {
      return files
    }

    const entries = readdirSync(dir, { withFileTypes: true })

    for (const entry of entries) {
      const fullPath = path.join(dir, entry.name)
      const relativePath = path.relative(this.config.rootDir, fullPath)

      if (entry.isDirectory()) {
        if (!this.ignoreMatcher.ignores(relativePath)) {
          const subFiles = await this.scanDirectory(fullPath)
          files.push(...subFiles)
        }
      } else if (entry.isFile()) {
        if (this.shouldIndex(fullPath)) {
          files.push(fullPath)
        }
      }
    }

    return files
  }

  private async indexFile(filePath: string): Promise<Chunk[]> {
    try {
      const content = readFileSync(filePath, "utf-8")
      const chunks = this.chunker.chunk(content, filePath)
      return chunks
    } catch (error) {
      log.warn("failed to index file", { filePath, error: String(error) })
      return []
    }
  }

  async index(onProgress?: (current: number, total: number, file: string) => void): Promise<IndexStats> {
    const startTime = Date.now()
    const stats: IndexStats = {
      filesScanned: 0,
      filesIndexed: 0,
      chunksCreated: 0,
      vectorsStored: 0,
      errors: 0,
      duration: 0,
    }

    log.info("starting indexing", { projectId: this.config.projectId, rootDir: this.config.rootDir })

    const files = await this.scanDirectory(this.config.rootDir)
    stats.filesScanned = files.length

    const maxFiles = this.config.maxFiles || files.length
    const filesToIndex = files.slice(0, maxFiles)

    log.info("files to index", { count: filesToIndex.length })

    const batchSize = this.config.batchSize || 10

    for (let i = 0; i < filesToIndex.length; i += batchSize) {
      const batch = filesToIndex.slice(i, i + batchSize)

      await Promise.all(
        batch.map(async (file) => {
          const chunks = await this.indexFile(file)
          stats.filesIndexed++
          stats.chunksCreated += chunks.length

          for (const chunk of chunks) {
            try {
              const embedding = await this.embeddingService.getEmbedding(chunk.content)

              const entry: VectorEntry = {
                id: chunk.id,
                sessionId: this.config.projectId,
                path: chunk.path,
                content: chunk.content,
                embedding: embedding,
                timestamp: Date.now(),
              }

              await this.vectorStore.addVector(entry)
              stats.vectorsStored++
            } catch (error) {
              log.warn("failed to store chunk", { chunkId: chunk.id, error: String(error) })
              stats.errors++
            }
          }

          return file
        }),
      )

      if (onProgress) {
        onProgress(Math.min(i + batchSize, filesToIndex.length), filesToIndex.length, batch[0])
      }
    }

    stats.duration = Date.now() - startTime
    log.info("indexing complete", stats)

    return stats
  }

  async rebuild(onProgress?: (current: number, total: number, file: string) => void): Promise<IndexStats> {
    await this.vectorStore.clear()
    return this.index(onProgress)
  }

  async updateFile(filePath: string): Promise<number> {
    const chunks = await this.indexFile(filePath)
    let stored = 0

    for (const chunk of chunks) {
      try {
        const embedding = await this.embeddingService.getEmbedding(chunk.content)

        const entry: VectorEntry = {
          id: chunk.id,
          sessionId: this.config.projectId,
          path: chunk.path,
          content: chunk.content,
          embedding: embedding,
          timestamp: Date.now(),
        }

        await this.vectorStore.addVector(entry)
        stored++
      } catch (error) {
        log.warn("failed to update chunk", { chunkId: chunk.id, error: String(error) })
      }
    }

    return stored
  }

  async removeFile(_filePath: string): Promise<number> {
    return 0
  }
}

export function createIndexer(rootDir: string, projectId: string, vectorStore: VectorStore): RAGIndexer {
  return new RAGIndexer({ rootDir, projectId }, vectorStore)
}
