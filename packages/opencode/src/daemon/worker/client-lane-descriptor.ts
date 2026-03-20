import z from "zod"
import { LaneID, ResumeToken, WorkerID } from "@/daemon/identity/ids"
import { parseProjectRuntimeKey } from "@/daemon/identity/runtime-key"

export const LaneStateSchema = z.enum(["active", "released", "cancelled", "rebuilding"])

export type LaneState = z.infer<typeof LaneStateSchema>

export interface ClientLaneDescriptor {
  laneID: LaneID
  workerID: WorkerID
  runtimeKey: string
  sessionID: string
  directory: string
  state: LaneState
  acquiredAt: number
  lastHeartbeatAt: number
  releasedAt?: number
  releaseReason?: string
  cancelledAt?: number
  cancelReason?: string
  cancelRequestID?: string
  resumeToken?: ResumeToken
  rebuiltFromLaneID?: LaneID
}

const ClientLaneDescriptorSchema = z.object({
  laneID: LaneID.zod,
  workerID: WorkerID.zod,
  runtimeKey: z.string().transform((value) => parseProjectRuntimeKey(value)),
  sessionID: z.string().min(1),
  directory: z.string().min(1),
  state: LaneStateSchema,
  acquiredAt: z.number().int().nonnegative(),
  lastHeartbeatAt: z.number().int().nonnegative(),
  releasedAt: z.number().int().nonnegative().optional(),
  releaseReason: z.string().min(1).optional(),
  cancelledAt: z.number().int().nonnegative().optional(),
  cancelReason: z.string().min(1).optional(),
  cancelRequestID: z.string().min(1).optional(),
  resumeToken: ResumeToken.zod.optional(),
  rebuiltFromLaneID: LaneID.zod.optional(),
})

export function parseClientLaneDescriptor(input: unknown): ClientLaneDescriptor {
  return ClientLaneDescriptorSchema.parse(input)
}
