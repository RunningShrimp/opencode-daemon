import { z } from "zod"
import { EvidenceSource } from "@/ai/thinking/evidence"
import type { VectorSearchResult } from "./vector-store"

export const GroundingEvidence = z.object({
  id: z.string(),
  source: z.nativeEnum(EvidenceSource),
  filePath: z.string(),
  startLine: z.number().int().positive().optional(),
  endLine: z.number().int().positive().optional(),
  quote: z.string(),
  content: z.string(),
  score: z.number().min(0).max(1),
  modality: z.enum(["text", "document", "image"]).default("text"),
  attribution: z.string(),
  metadata: z.record(z.string(), z.unknown()).optional(),
})

export type GroundingEvidence = z.infer<typeof GroundingEvidence>

export const GroundingBundle = z.object({
  claim: z.string(),
  confidence: z.number().min(0).max(1),
  evidence: z.array(GroundingEvidence),
  counterEvidence: z.array(GroundingEvidence).default([]),
})

export type GroundingBundle = z.infer<typeof GroundingBundle>

function lineRange(startLine?: number, endLine?: number) {
  if (!startLine) return ""
  if (!endLine || endLine === startLine) return `:${startLine}`
  return `:${startLine}-${endLine}`
}

export function createGroundingEvidence(input: Omit<GroundingEvidence, "id" | "attribution"> & { attribution?: string }) {
  return GroundingEvidence.parse({
    ...input,
    id: crypto.randomUUID(),
    attribution: input.attribution ?? `${input.filePath}${lineRange(input.startLine, input.endLine)}`,
  })
}

export function evidenceFromVectorResult(result: VectorSearchResult): GroundingEvidence {
  return createGroundingEvidence({
    source: EvidenceSource.CODEBASE,
    filePath: result.path,
    startLine: result.startLine,
    endLine: result.endLine,
    quote: result.content.slice(0, 240),
    content: result.content,
    score: Math.max(0, Math.min(1, result.score)),
    modality: "text",
    metadata: {
      sessionId: result.sessionId,
      resultType: "vector",
      coarseScore: result.coarseScore,
      fineScore: result.fineScore,
      retrievalProfile: result.retrievalProfile,
    },
  })
}

export function evidenceFromRipgrepResult(input: {
  filePath: string
  lineNumber: number
  content: string
  score: number
}): GroundingEvidence {
  return createGroundingEvidence({
    source: EvidenceSource.SEARCH,
    filePath: input.filePath,
    startLine: input.lineNumber,
    endLine: input.lineNumber,
    quote: input.content,
    content: input.content,
    score: Math.max(0, Math.min(1, input.score)),
    modality: "text",
    metadata: {
      resultType: "keyword",
    },
  })
}