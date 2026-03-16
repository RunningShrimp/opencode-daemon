/**
 * RAG Indexer - Indexes code files for semantic search
 */

import { Log } from "@/util/log"
import { Global } from "@/global"
import { Bus } from "@/bus"
import { FileWatcher } from "@/file/watcher"
import path from "path"
import { existsSync, readdirSync, readFileSync, statSync } from "fs"
import fs from "node:fs/promises"
import ignore from "ignore"
import { Chunker, chunker, type Chunk } from "./chunker"
import { VectorStore, type VectorEntry } from "./vector-store"
import { embeddingService, type EmbeddingService } from "./embedding"
import { embeddingBackgroundService } from "./embedding-bg-service"

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

interface IndexedFileState {
  signature: string
  chunkIds: string[]
}

interface IndexManifest {
  version: number
  files: Record<string, IndexedFileState>
}

const projectRegistry = new Map<string, { rootDir: string; vectorStore: VectorStore }>()
const indexerRegistry = new Map<string, { rootDir: string; indexer: RAGIndexer }>()
const initialIndexTasks = new Map<string, Promise<IndexStats>>()

export class RAGIndexer {
  private config: RAGIndexerConfig
  private vectorStore: VectorStore
  private embeddingService: EmbeddingService
  private chunker: Chunker
  private ignoreMatcher: ignore.Ignore
  private unsubscribe?: () => void

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

    projectRegistry.set(config.projectId, { rootDir: config.rootDir, vectorStore })
    this.watchProjectFiles()
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
    const manifest = await this.loadManifest()
    const nextManifest: IndexManifest = {
      version: 1,
      files: {},
    }
    const currentSet = new Set(filesToIndex)

    for (const existingPath of Object.keys(manifest.files)) {
      const absolutePath = path.join(this.config.rootDir, existingPath)
      if (!currentSet.has(absolutePath)) {
        await this.removeFile(absolutePath)
      }
    }

    const changedFiles = filesToIndex.filter((filePath) => {
      const relativePath = path.relative(this.config.rootDir, filePath)
      const previous = manifest.files[relativePath]
      const signature = this.computeSignature(filePath)
      if (!previous || previous.signature !== signature) return true
      nextManifest.files[relativePath] = previous
      return false
    })

    log.info("files to index", { count: changedFiles.length, total: filesToIndex.length })

    const batchSize = this.config.batchSize || 10

    for (let i = 0; i < changedFiles.length; i += batchSize) {
      const batch = changedFiles.slice(i, i + batchSize)

      await Promise.all(
        batch.map(async (file) => {
          const result = await this.indexChangedFile(file)
          stats.filesIndexed++
          stats.chunksCreated += result.chunkIds.length
          stats.vectorsStored += result.chunkIds.length
          nextManifest.files[path.relative(this.config.rootDir, file)] = {
            signature: result.signature,
            chunkIds: result.chunkIds,
          }
          return file
        }),
      )

      if (onProgress) {
        onProgress(Math.min(i + batchSize, changedFiles.length), changedFiles.length, batch[0])
      }
    }

    await this.saveManifest(nextManifest)

    stats.duration = Date.now() - startTime
    log.info("indexing complete", stats)

    return stats
  }

  async rebuild(onProgress?: (current: number, total: number, file: string) => void): Promise<IndexStats> {
    await this.vectorStore.clear(this.config.projectId)
    await fs.rm(this.manifestPath(), { force: true }).catch(() => undefined)
    return this.index(onProgress)
  }

  async updateFile(filePath: string): Promise<number> {
    if (!this.shouldIndex(filePath) || !existsSync(filePath)) return 0
    const result = await this.indexChangedFile(filePath)
    const manifest = await this.loadManifest()
    manifest.files[path.relative(this.config.rootDir, filePath)] = {
      signature: result.signature,
      chunkIds: result.chunkIds,
    }
    await this.saveManifest(manifest)
    return result.chunkIds.length
  }

  async removeFile(filePath: string): Promise<number> {
    const removed = await this.vectorStore.deleteByPath(this.config.projectId, filePath)
    const manifest = await this.loadManifest()
    delete manifest.files[path.relative(this.config.rootDir, filePath)]
    await this.saveManifest(manifest)
    return removed
  }

  private async indexChangedFile(filePath: string): Promise<{ chunkIds: string[]; signature: string }> {
    await this.vectorStore.deleteByPath(this.config.projectId, filePath)
    const chunks = await this.indexFile(filePath)
    const entries: VectorEntry[] = []

    // Wait for the real embedding provider to be ready (up to 5 s) before the
    // batch embed loop so we don't wastefully index with the hash fallback.
    await embeddingBackgroundService.waitForProvider(5000)

    for (const chunk of chunks) {
      try {
        const retrieval = await this.embeddingService.getRetrievalEmbedding({
          content: chunk.content,
          modality: /\.(md|mdx|txt|rst|adoc)$/i.test(chunk.path) ? "document" : "text",
          path: chunk.path,
          metadata: {
            chunkType: chunk.type,
          },
        })

        entries.push({
          id: chunk.id,
          sessionId: this.config.projectId,
          path: chunk.path,
          content: chunk.content,
          coarseQuantized: retrieval.coarse.map((value) => Math.max(-127, Math.min(127, Math.round(value * 127)))),
          fineQuantized: retrieval.fine.map((value) => Math.max(-127, Math.min(127, Math.round(value * 127)))),
          fineDimensions: retrieval.fineDimensions,
          retrievalProfile: retrieval.profile,
          quantized: true,
          timestamp: Date.now(),
          startLine: chunk.startLine,
          endLine: chunk.endLine,
        })
      } catch (error) {
        log.warn("failed to update chunk", { chunkId: chunk.id, error: String(error) })
      }
    }

    if (entries.length > 0) {
      await this.vectorStore.addVectors(entries)
    }

    return {
      chunkIds: entries.map((entry) => entry.id),
      signature: this.computeSignature(filePath),
    }
  }

  private manifestPath() {
    return path.join(Global.Path.data, "rag-manifest", `${encodeURIComponent(this.config.projectId)}.json`)
  }

  private async loadManifest(): Promise<IndexManifest> {
    const raw = await fs.readFile(this.manifestPath(), "utf-8").catch(() => undefined)
    if (!raw) {
      return { version: 1, files: {} }
    }
    return JSON.parse(raw) as IndexManifest
  }

  private async saveManifest(manifest: IndexManifest) {
    const manifestFile = this.manifestPath()
    await fs.mkdir(path.dirname(manifestFile), { recursive: true })
    const tmp = `${manifestFile}.${process.pid}.${Date.now()}.${Math.random().toString(16).slice(2)}.tmp`
    await fs.writeFile(tmp, JSON.stringify(manifest), "utf-8")
    try {
      await fs.rename(tmp, manifestFile)
    } finally {
      await fs.rm(tmp, { force: true }).catch(() => undefined)
    }
  }

  private computeSignature(filePath: string) {
    const stat = statSync(filePath)
    return `${stat.size}:${Math.floor(stat.mtimeMs)}`
  }

  private watchProjectFiles() {
    if (this.unsubscribe) return
    this.unsubscribe = Bus.subscribe(FileWatcher.Event.Updated, (evt) => {
      const filePath = evt.properties.file
      if (!filePath.startsWith(this.config.rootDir)) return
      const event = evt.properties.event
      void (async () => {
        if (event === "unlink") {
          await this.removeFile(filePath)
          return
        }
        await this.updateFile(filePath)
      })().catch((error) => {
        log.warn("rag incremental update failed", {
          projectId: this.config.projectId,
          filePath,
          event,
          error: String(error),
        })
      })
    })
  }
}

export async function rebuildRegisteredProjects(): Promise<void> {
  await Promise.all(
    Array.from(projectRegistry.entries()).map(async ([projectId, project]) => {
      const indexer = createIndexer(project.rootDir, projectId, project.vectorStore)
      await indexer.rebuild().catch((error) => {
        log.warn("registered project reindex failed", { projectId, error: String(error) })
      })
    }),
  )
}

export function resolveProjectIndexRoot(rootDir: string, fallbackDir?: string): string {
  if (rootDir && rootDir !== "/") return rootDir
  if (fallbackDir && fallbackDir !== "/") return fallbackDir
  return rootDir || fallbackDir || "/"
}

export function createIndexer(rootDir: string, projectId: string, vectorStore: VectorStore): RAGIndexer {
  const resolvedRoot = resolveProjectIndexRoot(rootDir)
  const existing = indexerRegistry.get(projectId)
  if (existing && existing.rootDir === resolvedRoot) {
    return existing.indexer
  }

  const indexer = new RAGIndexer({ rootDir: resolvedRoot, projectId }, vectorStore)
  indexerRegistry.set(projectId, { rootDir: resolvedRoot, indexer })
  return indexer
}

export async function ensureProjectIndexed(input: {
  rootDir: string
  fallbackDir?: string
  projectId: string
  vectorStore: VectorStore
}): Promise<{ indexed: boolean; stats?: IndexStats; indexer: RAGIndexer }> {
  const resolvedRoot = resolveProjectIndexRoot(input.rootDir, input.fallbackDir)
  const indexer = createIndexer(resolvedRoot, input.projectId, input.vectorStore)
  const size = await input.vectorStore.getProjectSize(input.projectId)
  if (size > 0) {
    return { indexed: false, indexer }
  }

  let task = initialIndexTasks.get(input.projectId)
  if (!task) {
    task = indexer.index().finally(() => {
      if (initialIndexTasks.get(input.projectId) === task) {
        initialIndexTasks.delete(input.projectId)
      }
    })
    initialIndexTasks.set(input.projectId, task)
  }

  return {
    indexed: true,
    stats: await task,
    indexer,
  }
}

export function resetIndexerRegistryForTest() {
  indexerRegistry.clear()
  initialIndexTasks.clear()
  projectRegistry.clear()
}
