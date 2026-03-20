import { createHmac, randomUUID, timingSafeEqual } from "node:crypto"
import z from "zod"
import { Hash } from "@/util/hash"
import { LaneID, NamespaceID, WorkerID } from "@/daemon/identity/ids"
import type { FencingEpoch } from "./fencing-epoch"
import { parseFencingEpoch } from "./fencing-epoch"

const CONTROL_VERSION = 1 as const

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => stableValue(entry))
  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      result[key] = stableValue((value as Record<string, unknown>)[key])
    }
    return result
  }
  return value
}

function canonicalJson(value: unknown) {
  return JSON.stringify(stableValue(value))
}

function createSignature(secret: string, content: string) {
  return createHmac("sha256", secret).update(content).digest("hex")
}

function signatureInput(input: {
  version: number
  id: string
  namespaceID: string
  workerID: string
  laneID?: string
  epoch: string
  action: string
  issuedAt: number
  ttlMs: number
  nonce: string
  payloadHash: string
}) {
  return canonicalJson(input)
}

export const ControlEnvelopeSchema = z.object({
  version: z.literal(CONTROL_VERSION),
  id: z.string().uuid(),
  namespaceID: NamespaceID.zod,
  workerID: WorkerID.zod,
  laneID: LaneID.zod.optional(),
  epoch: z.string(),
  action: z.string().min(1).max(128),
  issuedAt: z.number().int().nonnegative(),
  ttlMs: z.number().int().positive().max(60_000),
  nonce: z.string().uuid(),
  payloadHash: z.string().regex(/^[a-f0-9]{40}$/i),
  signature: z.string().regex(/^[a-f0-9]{64}$/i),
  payload: z.unknown(),
})

export type ControlEnvelope<TPayload = unknown> = Omit<z.infer<typeof ControlEnvelopeSchema>, "payload"> & {
  payload: TPayload
  epoch: FencingEpoch
}

export interface CreateControlEnvelopeInput<TPayload> {
  secret: string
  namespaceID: string
  workerID: string
  laneID?: string
  epoch: FencingEpoch
  action: string
  payload: TPayload
  now?: number
  ttlMs?: number
}

export interface VerifyControlEnvelopeOptions {
  now?: number
  maxFutureSkewMs?: number
}

export interface VerifyControlEnvelopeResult {
  ok: boolean
  reason?: "invalid-envelope" | "invalid-signature" | "expired" | "issued-in-future"
}

export function createControlEnvelope<TPayload>(input: CreateControlEnvelopeInput<TPayload>): ControlEnvelope<TPayload> {
  if (!input.secret || input.secret.length < 16) {
    throw new Error("Control secret must be at least 16 characters")
  }

  const namespaceID = NamespaceID.make(input.namespaceID)
  const workerID = WorkerID.make(input.workerID)
  const laneID = input.laneID ? LaneID.make(input.laneID) : undefined
  const epoch = parseFencingEpoch(input.epoch).raw
  const issuedAt = input.now ?? Date.now()
  const ttlMs = input.ttlMs ?? 10_000
  const nonce = randomUUID()
  const id = randomUUID()
  const payloadHash = Hash.fast(canonicalJson(input.payload))

  const signature = createSignature(
    input.secret,
    signatureInput({
      version: CONTROL_VERSION,
      id,
      namespaceID,
      workerID,
      laneID,
      epoch,
      action: input.action,
      issuedAt,
      ttlMs,
      nonce,
      payloadHash,
    }),
  )

  return {
    version: CONTROL_VERSION,
    id,
    namespaceID,
    workerID,
    laneID,
    epoch,
    action: input.action,
    issuedAt,
    ttlMs,
    nonce,
    payloadHash,
    signature,
    payload: input.payload,
  }
}

export function verifyControlEnvelope<TPayload>(
  envelope: ControlEnvelope<TPayload>,
  secret: string,
  options: VerifyControlEnvelopeOptions = {},
): VerifyControlEnvelopeResult {
  const parsed = ControlEnvelopeSchema.safeParse(envelope)
  if (!parsed.success) {
    return { ok: false, reason: "invalid-envelope" }
  }

  const maxFutureSkewMs = options.maxFutureSkewMs ?? 5_000
  const now = options.now ?? Date.now()
  if (parsed.data.issuedAt > now + maxFutureSkewMs) {
    return { ok: false, reason: "issued-in-future" }
  }

  if (parsed.data.issuedAt + parsed.data.ttlMs < now) {
    return { ok: false, reason: "expired" }
  }

  const payloadHash = Hash.fast(canonicalJson(parsed.data.payload))
  const signature = createSignature(
    secret,
    signatureInput({
      version: parsed.data.version,
      id: parsed.data.id,
      namespaceID: parsed.data.namespaceID,
      workerID: parsed.data.workerID,
      laneID: parsed.data.laneID,
      epoch: parsed.data.epoch,
      action: parsed.data.action,
      issuedAt: parsed.data.issuedAt,
      ttlMs: parsed.data.ttlMs,
      nonce: parsed.data.nonce,
      payloadHash,
    }),
  )

  const expected = Buffer.from(signature, "utf8")
  const actual = Buffer.from(parsed.data.signature, "utf8")
  if (expected.length !== actual.length) {
    return { ok: false, reason: "invalid-signature" }
  }

  if (!timingSafeEqual(expected, actual)) {
    return { ok: false, reason: "invalid-signature" }
  }

  return {
    ok: payloadHash === parsed.data.payloadHash,
    reason: payloadHash === parsed.data.payloadHash ? undefined : "invalid-signature",
  }
}
