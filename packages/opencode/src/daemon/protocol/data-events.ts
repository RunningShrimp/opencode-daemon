import z from "zod"
import { LaneID } from "@/daemon/identity/ids"

const Base = z.object({
  laneID: LaneID.zod,
  streamID: z.string().min(1),
  seq: z.number().int().nonnegative(),
  emittedAt: z.number().int().nonnegative(),
})

const PromptChunk = Base.extend({
  type: z.literal("prompt.chunk"),
  payload: z.object({
    text: z.string(),
    done: z.boolean().optional(),
  }),
})

const FileChunk = Base.extend({
  type: z.literal("file.chunk"),
  payload: z.object({
    path: z.string().min(1),
    mime: z.string().min(1),
    data: z.string().min(1),
    encoding: z.enum(["base64", "utf8"]),
    done: z.boolean().optional(),
  }),
})

const EmbeddingRequest = Base.extend({
  type: z.literal("embedding.request"),
  payload: z.object({
    requestID: z.string().min(1),
    content: z.string().min(1),
    model: z.string().min(1),
  }),
})

const EmbeddingResult = Base.extend({
  type: z.literal("embedding.result"),
  payload: z.object({
    requestID: z.string().min(1),
    dimensions: z.number().int().positive(),
    vector: z.array(z.number()),
  }),
})

export const ProjectDataEventSchema = z.discriminatedUnion("type", [
  PromptChunk,
  FileChunk,
  EmbeddingRequest,
  EmbeddingResult,
])

export type ProjectDataEvent = z.infer<typeof ProjectDataEventSchema>

export function parseProjectDataEvent(input: unknown): ProjectDataEvent {
  return ProjectDataEventSchema.parse(input)
}
