import { Log } from "@/util/log"
import { withTimeout } from "@/util/timeout"
import { embeddingService } from "./embedding"
import { ensureEmbeddingBackgroundServiceStarted } from "./embedding-bg-service"
import { GroundingBundle, type GroundingEvidence, evidenceFromVectorResult } from "./evidence"
import { ensureProjectIndexed } from "./indexer"
import { vectorStore } from "./vector-store"
import {
  extractAutoGroundingQueryFromParts,
  formatAutoGroundingSystemPrompt,
  shouldAutoGroundQuery,
} from "./auto-context-format"

const log = Log.create({ service: "rag.auto-context" })

const AUTO_GROUNDING_LIMIT = 3
const AUTO_GROUNDING_TIMEOUT_MS = 1500

export interface AutoGroundingContext {
  query: string
  system: string
  evidence: GroundingEvidence[]
  grounding: GroundingBundle
  autoIndexed: boolean
}

export { extractAutoGroundingQueryFromParts, formatAutoGroundingSystemPrompt, shouldAutoGroundQuery }

export async function buildAutoGroundingContext(input: {
  query: string
  projectId: string
  rootDir: string
  fallbackDir?: string
  limit?: number
  timeoutMs?: number
}): Promise<AutoGroundingContext | undefined> {
  const query = input.query.trim()
  if (!shouldAutoGroundQuery(query)) return undefined

  let autoIndexed = false
  if ((await vectorStore.getProjectSize(input.projectId)) === 0) {
    const warm = ensureProjectIndexed({
      rootDir: input.rootDir,
      fallbackDir: input.fallbackDir,
      projectId: input.projectId,
      vectorStore,
    })
    const warmResult = await withTimeout(warm, input.timeoutMs ?? AUTO_GROUNDING_TIMEOUT_MS).catch((error) => {
      log.info("project index warm-up still running; skipping inline grounding for now", {
        projectId: input.projectId,
        error: String(error),
      })
      return undefined
    })
    autoIndexed = warmResult?.indexed ?? false
  }

  await ensureEmbeddingBackgroundServiceStarted().catch((error) => {
    log.warn("failed to start embedding background service for auto grounding", {
      projectId: input.projectId,
      error: String(error),
    })
  })
  const queryEmbeddings = await embeddingService.getQueryEmbeddings(query)
  const results = await vectorStore.search(queryEmbeddings, {
    projectId: input.projectId,
    limit: input.limit ?? AUTO_GROUNDING_LIMIT,
  })
  if (!results.length) return undefined

  const evidence = results.map((result) => evidenceFromVectorResult(result))
  const grounding = GroundingBundle.parse({
    claim: query,
    confidence: evidence[0]?.score ?? 0,
    evidence,
    counterEvidence: [],
  })
  return {
    query,
    evidence,
    grounding,
    autoIndexed,
    system: formatAutoGroundingSystemPrompt(query, evidence),
  }
}