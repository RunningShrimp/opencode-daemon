/**
 * RAG Query Tool - Allow agents to query project knowledge
 */

import z from "zod"
import { Tool } from "@/tool/tool"
import { Instance } from "@/project/instance"
import { Log } from "@/util/log"
import { vectorStore } from "./vector-store"
import { embeddingService } from "./embedding"
import { createIndexer } from "./indexer"

const log = Log.create({ service: "tool.rag-query" })

export const RagQueryTool = Tool.define("rag_query", async () => ({
  description: `Search the project knowledge base for relevant code context.
Use this tool when you need to understand how the codebase works, find similar implementations,
or verify your assumptions about how code is structured.
This helps reduce hallucinations by grounding your understanding in actual code.`,
  parameters: z.object({
    query: z.string().describe("The search query to find relevant code context"),
    limit: z.number().min(1).max(20).default(5).describe("Number of results to return (default: 5)"),
  }),
  execute: async (args, _ctx) => {
    const project = Instance.project
    if (!project) {
      return {
        title: "RAG Query",
        output: "No project context available",
        metadata: { error: true, query: args.query, count: 0 },
      }
    }

    try {
      const embedding = await embeddingService.getEmbedding(args.query)
      const results = await vectorStore.search(embedding, args.limit || 5)

      const formattedResults = results.map((r) => ({
        filePath: r.path,
        relevance: Math.round(r.score * 100) + "%",
        content: r.content.slice(0, 500),
      }))

      const output = formattedResults
        .map((r, i) => `[${i + 1}] ${r.filePath} (${r.relevance})\n${r.content}`)
        .join("\n\n---\n\n")

      return {
        title: "RAG Query Results",
        output: output || "No results found",
        metadata: {
          error: false,
          query: args.query,
          count: results.length,
        },
      }
    } catch (error) {
      log.error("RAG query failed", { error: String(error) })
      return {
        title: "RAG Query Error",
        output: `Error: ${String(error)}`,
        metadata: { error: true, query: args.query, count: 0 },
      }
    }
  },
}))

export const RagIndexTool = Tool.define("rag_index", async () => ({
  description: `Rebuild the project knowledge index.
Use this after making significant changes to the codebase to ensure
the knowledge base is up-to-date.`,
  parameters: z.object({
    mode: z.enum(["full", "incremental"]).default("incremental").describe("Full rebuild or incremental update"),
  }),
  execute: async (args, _ctx) => {
    const project = Instance.project
    if (!project) {
      return {
        title: "RAG Index",
        output: "No project context available",
        metadata: { error: true, mode: args.mode, filesIndexed: 0, chunksCreated: 0, vectorsStored: 0, duration: 0 },
      }
    }

    try {
      const indexer = createIndexer(project.worktree, project.id, vectorStore)
      const stats = await indexer.index()

      const output = `Indexed ${stats.filesIndexed} files, ${stats.chunksCreated} chunks, ${stats.vectorsStored} vectors in ${stats.duration}ms`

      return {
        title: "RAG Index Complete",
        output,
        metadata: {
          error: false,
          mode: args.mode,
          filesIndexed: stats.filesIndexed,
          chunksCreated: stats.chunksCreated,
          vectorsStored: stats.vectorsStored,
          duration: stats.duration,
        },
      }
    } catch (error) {
      log.error("RAG index failed", { error: String(error) })
      return {
        title: "RAG Index Error",
        output: `Error: ${String(error)}`,
        metadata: { error: true, mode: args.mode, filesIndexed: 0, chunksCreated: 0, vectorsStored: 0, duration: 0 },
      }
    }
  },
}))
