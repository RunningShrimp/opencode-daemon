import z from "zod"
import { WorkerID } from "@/daemon/identity/ids"
import type { ProjectRuntimeIdentity } from "@/daemon/identity/project-identity"
import { NamespaceID } from "@/daemon/identity/ids"
import { ProjectID } from "@/project/schema"
import { parseProjectRuntimeKey } from "@/daemon/identity/runtime-key"
import type { FencingEpoch } from "@/daemon/protocol/fencing-epoch"
import { parseFencingEpoch } from "@/daemon/protocol/fencing-epoch"

export const WorkerStateSchema = z.enum(["cold", "starting", "hot", "warm-idle", "draining", "terminated"])

export type WorkerState = z.infer<typeof WorkerStateSchema>
export type StartupEpoch = FencingEpoch

export interface ProjectWorkerDescriptor {
  workerID: WorkerID
  runtime: ProjectRuntimeIdentity
  state: WorkerState
  pid?: number
  startupEpoch: StartupEpoch
  startedAt?: number
  lastActiveAt?: number
  laneCount: number
  toolchainCellCount: number
}

const RuntimeIdentitySchema = z.object({
  namespaceID: NamespaceID.zod,
  repository: z.object({
    projectID: ProjectID.zod,
    canonicalRepoRoot: z.string().min(1),
    vcs: z.enum(["git", "none"]),
  }),
  worktree: z.string().min(1),
  runtimeKey: z.string().transform((value) => parseProjectRuntimeKey(value)),
  workerEnvScope: z.string().regex(/^[a-f0-9]{40}$/i),
  envFingerprint: z.string().regex(/^[a-f0-9]{40}$/i),
})

const WorkerDescriptorSchema = z.object({
  workerID: WorkerID.zod,
  runtime: RuntimeIdentitySchema,
  state: WorkerStateSchema,
  pid: z.number().int().positive().optional(),
  startupEpoch: z.string().transform((value) => parseFencingEpoch(value).raw),
  startedAt: z.number().int().nonnegative().optional(),
  lastActiveAt: z.number().int().nonnegative().optional(),
  laneCount: z.number().int().nonnegative(),
  toolchainCellCount: z.number().int().nonnegative(),
})

export function parseProjectWorkerDescriptor(input: unknown): ProjectWorkerDescriptor {
  return WorkerDescriptorSchema.parse(input)
}
