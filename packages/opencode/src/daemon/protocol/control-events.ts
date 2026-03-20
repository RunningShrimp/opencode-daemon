import z from "zod"
import { LaneID, WorkerID } from "@/daemon/identity/ids"

const Base = z.object({
  id: z.string().uuid(),
  workerID: WorkerID.zod,
  laneID: LaneID.zod.optional(),
  emittedAt: z.number().int().nonnegative(),
})

const LaneAcquire = Base.extend({
  type: z.literal("lane.acquire"),
  laneID: LaneID.zod,
  payload: z.object({
    directory: z.string().min(1),
    sessionID: z.string().min(1),
  }),
})

const LaneRelease = Base.extend({
  type: z.literal("lane.release"),
  laneID: LaneID.zod,
  payload: z.object({
    reason: z.string().min(1),
  }),
})

const LaneCancel = Base.extend({
  type: z.literal("lane.cancel"),
  laneID: LaneID.zod,
  payload: z.object({
    reason: z.string().min(1),
    requestID: z.string().min(1),
  }),
})

const WorkerEnsure = Base.extend({
  type: z.literal("worker.ensure"),
  payload: z.object({
    runtimeKey: z.string().min(1),
  }),
})

const Health = Base.extend({
  type: z.literal("health"),
  payload: z.object({
    detail: z.enum(["basic", "verbose"]),
  }),
})

const PublicListenerConfigure = Base.extend({
  type: z.literal("public-listener.configure"),
  payload: z.object({
    hostname: z.string().min(1),
    port: z.number().int().min(0).max(65535),
    mdns: z.boolean().optional(),
  }),
})

export const ControlEventSchema = z.discriminatedUnion("type", [
  LaneAcquire,
  LaneRelease,
  LaneCancel,
  WorkerEnsure,
  Health,
  PublicListenerConfigure,
])

export type ControlEvent = z.infer<typeof ControlEventSchema>

export function parseControlEvent(input: unknown): ControlEvent {
  return ControlEventSchema.parse(input)
}
