/**
 * AI Enhancement Modules
 *
 * This module exports all AI enhancement features including:
 * - Thinking modules: Self-driving agent loop, metacognition, evidence-based reasoning
 * - RAG modules: Embedding, vector store, hybrid retrieval, code chunking
 * - AI Tools: Self-critique, review-verify, evidence-gather, plan tools
 */

export * from "./thinking"
export * from "./rag"
export * from "./tools"

export { VectorStore, vectorStore } from "./rag/vector-store"
export { HybridRetriever } from "./rag/hybrid-retriever"
export { EmbeddingService } from "./rag/embedding"
export { MemoryGuard } from "../util/memory-guard"
export { ACEContext, globalACE } from "./rag/ace-context"
export { FVARRAG, globalFVARRAG, verifyWithFVA } from "./rag/contra-retriever"
export { RAGIndexer, createIndexer } from "./rag/indexer"
export { RagQueryTool, RagIndexTool } from "./rag/rag-query"
export { embeddingBackgroundService, initEmbeddingBackgroundService } from "./rag/embedding-bg-service"
export {
  VectorStoreBackgroundService,
  vectorStoreBackgroundService,
  initVectorStoreBackgroundService,
} from "./rag/vector-store-bg-service"
export {
  TreeSitterBackgroundService,
  treeSitterBackgroundService,
  initTreeSitterBackgroundService,
} from "./rag/tree-sitter-bg-service"
export { SelfCritiqueTool } from "./tools/self-critique"
export { ReviewVerifyTool } from "./tools/review-verify"
export { EvidenceGatherTool } from "./tools/evidence-gather"
export { PlanExitTool } from "@/tool/plan"
export {
  CompactionPredictor,
  getPredictor,
  globalManager as compactionPredictorManager,
} from "../util/compaction-predictor"
export { DynamicTurnController, getController, globalTurnControlManager } from "../util/dynamic-turn-control"
