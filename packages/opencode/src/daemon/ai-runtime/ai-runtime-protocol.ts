import z from "zod"

export const ArtifactKindSchema = z.enum(["module", "model", "parser", "binary"])
export type ArtifactKind = z.infer<typeof ArtifactKindSchema>

export const ArtifactEnsureRequestSchema = z.object({
  kind: ArtifactKindSchema,
  name: z.string().trim().min(1),
  version: z.string().trim().min(1).optional(),
  platform: z.string().trim().min(1).optional(),
})

export type ArtifactEnsureRequest = z.infer<typeof ArtifactEnsureRequestSchema>

export interface ArtifactEnsureResult {
  path: string
  cacheHit: boolean
}

export const EmbedRequestSchema = z.object({
  model: z.string().trim().min(1),
  input: z.array(z.string()).min(1),
  dimensions: z.number().int().positive().optional(),
})

export type EmbedRequest = z.infer<typeof EmbedRequestSchema>

export const EmbedResponseSchema = z.object({
  vectors: z.array(z.array(z.number())),
  model: z.string().trim().min(1),
})

export type EmbedResponse = z.infer<typeof EmbedResponseSchema>

export interface AIRuntimeStats {
  mode: "sidecar" | "fallback"
  embedRequests: number
  sidecarEmbeds: number
  fallbackEmbeds: number
  warmedModels: string[]
  failures: number
  lastFailure?: string
  lastFailureAt?: number
}

export function parseArtifactEnsureRequest(input: unknown): ArtifactEnsureRequest {
  return ArtifactEnsureRequestSchema.parse(input)
}

export function parseEmbedRequest(input: unknown): EmbedRequest {
  return EmbedRequestSchema.parse(input)
}

export function parseEmbedResponse(input: unknown): EmbedResponse {
  return EmbedResponseSchema.parse(input)
}
