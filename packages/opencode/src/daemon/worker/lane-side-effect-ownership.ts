import type {
  CompleteResourceInput,
  ReleaseResourceInput,
  ResourceArbitrationResult,
  SideEffectResultCode,
  WorkerResourceArbiter,
} from "@/daemon/worker/worker-resource-arbiter"

export type LaneSideEffectKind = "approval" | "cancel" | "pty"

export interface BeginLaneSideEffectInput {
  workerID: string
  laneID: string
  kind: LaneSideEffectKind
  idempotencyKey: string
}

export interface CompleteLaneSideEffectInput {
  idempotencyKey: string
  status?: Extract<SideEffectResultCode, "completed" | "partially-applied" | "unknown">
  detail?: string
  release?: {
    workerID: string
    laneID: string
    kind: LaneSideEffectKind
    leaseToken?: string
  }
}

export interface RecoverLaneSideEffectInput {
  idempotencyKey: string
}

export interface BeginLaneSideEffectResult extends ResourceArbitrationResult {
  resourceKey: LaneSideEffectKind
}

function mapKindToResourceKey(kind: LaneSideEffectKind): LaneSideEffectKind {
  return kind
}

export class LaneSideEffectOwnershipCoordinator {
  constructor(private readonly arbiter: Pick<WorkerResourceArbiter, "acquire" | "complete" | "release" | "recover">) {}

  async begin(input: BeginLaneSideEffectInput): Promise<BeginLaneSideEffectResult> {
    const resourceKey = mapKindToResourceKey(input.kind)
    const result = await this.arbiter.acquire({
      workerID: input.workerID,
      laneID: input.laneID,
      resourceKey,
      idempotencyKey: input.idempotencyKey,
    })

    return {
      ...result,
      resourceKey,
    }
  }

  async complete(input: CompleteLaneSideEffectInput): Promise<ResourceArbitrationResult> {
    const completed = await this.arbiter.complete({
      idempotencyKey: input.idempotencyKey,
      status: input.status,
      detail: input.detail,
    } satisfies CompleteResourceInput)

    if (!input.release) {
      return completed
    }

    await this.arbiter.release({
      workerID: input.release.workerID,
      laneID: input.release.laneID,
      resourceKey: mapKindToResourceKey(input.release.kind),
      leaseToken: input.release.leaseToken,
    } satisfies ReleaseResourceInput)

    return completed
  }

  async recover(input: RecoverLaneSideEffectInput): Promise<ResourceArbitrationResult> {
    return this.arbiter.recover({
      idempotencyKey: input.idempotencyKey,
    })
  }
}
