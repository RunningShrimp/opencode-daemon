/**
 * RAG Query Tool - Allow agents to query project knowledge
 */

import z from "zod"
import { Tool } from "@/tool/tool"
import { Instance } from "@/project/instance"
import { Log } from "@/util/log"
import { vectorStore } from "./vector-store"
import { embeddingService } from "./embedding"
import { ensureEmbeddingBackgroundServiceStarted } from "./embedding-bg-service"
import { createIndexer, ensureProjectIndexed } from "./indexer"
import { GroundingBundle, evidenceFromVectorResult } from "./evidence"
import { EvidenceLedger } from "@/ai/evidence/ledger"

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
  execute: async (args, ctx): Promise<{
    title: string
    output: string
    metadata: { error: boolean; query: string; count: number; autoIndexed?: boolean; projectID?: string; grounding?: ReturnType<(typeof GroundingBundle)["parse"]> }
  }> => {
    const project = Instance.project
    if (!project) {
      return {
        title: "RAG Query",
        output: "No project context available",
        metadata: { error: true, query: args.query, count: 0 },
      }
    }

    try {
      let autoIndexed = false
      if ((await vectorStore.getProjectSize(project.id)) === 0) {
        ctx.metadata({
          title: "Building project knowledge index",
          metadata: {
            phase: "indexing",
            projectID: project.id,
          },
        })
        const warm = await ensureProjectIndexed({
          rootDir: project.worktree,
          fallbackDir: Instance.directory,
          projectId: project.id,
          vectorStore,
        })
        autoIndexed = warm.indexed
      }

      await ensureEmbeddingBackgroundServiceStarted().catch((error) => {
        log.warn("failed to start embedding background service for rag query", { error: String(error) })
      })
      const queryEmbeddings = await embeddingService.getQueryEmbeddings(args.query)
      const results = await vectorStore.search(queryEmbeddings, {
        limit: args.limit || 5,
        projectId: project.id,
      })
      const evidence = results.map((result) => evidenceFromVectorResult(result))
      const grounding = GroundingBundle.parse({
        claim: args.query,
        confidence: evidence[0]?.score ?? 0,
        evidence,
        counterEvidence: [],
      })
      void EvidenceLedger.recordGrounding({
        sessionID: ctx.sessionID,
        projectID: project.id,
        bundle: grounding,
        source: "tool",
        metadata: {
          tool: "rag_query",
          autoIndexed,
        },
      }).catch((ledgerError) => {
        log.warn("failed to record rag query evidence", { error: String(ledgerError) })
      })

      const formattedResults = results.map((r) => ({
        filePath: r.path,
        range:
          typeof r.startLine === "number"
            ? `${r.startLine}${typeof r.endLine === "number" && r.endLine !== r.startLine ? `-${r.endLine}` : ""}`
            : undefined,
        relevance: Math.round(r.score * 100) + "%",
        content: r.content.slice(0, 500),
      }))

      const output = formattedResults
        .map((r, i) => `[${i + 1}] ${r.filePath}${r.range ? `:${r.range}` : ""} (${r.relevance})\n${r.content}`)
        .join("\n\n---\n\n")

      return {
        title: "RAG Query Results",
        output: output || "No results found",
        metadata: {
          error: false,
          query: args.query,
          count: results.length,
          autoIndexed,
          projectID: project.id,
          grounding,
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
  execute: async (args, ctx): Promise<{
    title: string
    output: string
    metadata: { error: boolean; mode: string; filesIndexed: number; chunksCreated: number; vectorsStored: number; duration: number; projectID?: string }
  }> => {
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
      ctx.metadata({
        title: args.mode === "full" ? "Rebuilding project knowledge index" : "Refreshing project knowledge index",
        metadata: {
          phase: args.mode,
          projectID: project.id,
        },
      })
      const stats = args.mode === "full" ? await indexer.rebuild() : await indexer.index()

      const output = `Indexed ${stats.filesIndexed} files, ${stats.chunksCreated} chunks, ${stats.vectorsStored} vectors in ${stats.duration}ms`

      return {
        title: "RAG Index Complete",
        output,
        metadata: {
          error: false,
          mode: args.mode,
          projectID: project.id,
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
