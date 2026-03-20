import z from "zod"
import { LaneID, ToolchainCellID, WorkerID } from "@/daemon/identity/ids"
import { parseProjectRuntimeKey, type ProjectRuntimeKey } from "@/daemon/identity/runtime-key"
import type { ToolchainRuntimeProfile } from "@/daemon/worker/toolchain-profile"

export const ToolchainCellStateSchema = z.enum(["active", "suspended", "recycled"])

export type ToolchainCellState = z.infer<typeof ToolchainCellStateSchema>

export interface ToolchainCellDescriptor {
  cellID: string
  workerID: string
  runtimeKey: ProjectRuntimeKey
  profile: ToolchainRuntimeProfile
  state: ToolchainCellState
  createdAt: number
  lastUsedAt: number
  suspendedAt?: number
  recycledAt?: number
  stateReason?: string
  boundLaneIDs: string[]
}

const ToolchainProfileSchema = z.object({
  language: z.string().min(1),
  runtime: z.string().min(1),
  version: z.string().min(1).optional(),
  formatter: z.string().min(1).optional(),
  env: z.record(z.string(), z.string()),
  envFingerprint: z.string().regex(/^[a-f0-9]{40}$/i),
})

const ToolchainCellDescriptorSchema = z.object({
  cellID: ToolchainCellID.zod,
  workerID: WorkerID.zod,
  runtimeKey: z.string().transform((value) => parseProjectRuntimeKey(value)),
  profile: ToolchainProfileSchema,
  state: ToolchainCellStateSchema,
  createdAt: z.number().int().nonnegative(),
  lastUsedAt: z.number().int().nonnegative(),
  suspendedAt: z.number().int().nonnegative().optional(),
  recycledAt: z.number().int().nonnegative().optional(),
  stateReason: z.string().min(1).optional(),
  boundLaneIDs: z.array(LaneID.zod),
})

export function parseToolchainCellDescriptor(input: unknown): ToolchainCellDescriptor {
  return ToolchainCellDescriptorSchema.parse(input)
}
