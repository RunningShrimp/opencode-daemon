import { describe, expect, test } from "bun:test"
import { createControlEnvelope, verifyControlEnvelope } from "@/daemon/protocol/control-envelope"
import { FencingEpochGenerator } from "@/daemon/protocol/fencing-epoch"

describe("daemon control envelope", () => {
  const secret = "super-secret-signing-key"

  test("creates and verifies a valid signed envelope", () => {
    const epoch = new FencingEpochGenerator(7).next(1_700_000_000_000)

    const envelope = createControlEnvelope({
      secret,
      namespaceID: "local",
      workerID: "worker.alpha",
      laneID: "lane.alpha",
      epoch,
      action: "lane.acquire",
      payload: {
        laneID: "lane.alpha",
        reason: "initial-attach",
      },
      now: 1_700_000_000_000,
      ttlMs: 5_000,
    })

    const result = verifyControlEnvelope(envelope, secret, { now: 1_700_000_000_200 })
    expect(result).toEqual({ ok: true, reason: undefined })
  })

  test("rejects tampered payload", () => {
    const epoch = new FencingEpochGenerator(7).next(1_700_000_000_000)
    const envelope = createControlEnvelope({
      secret,
      namespaceID: "local",
      workerID: "worker.alpha",
      epoch,
      action: "lane.acquire",
      payload: {
        laneID: "lane.alpha",
      },
      now: 1_700_000_000_000,
      ttlMs: 5_000,
    })

    const tampered = {
      ...envelope,
      payload: {
        laneID: "lane.beta",
      },
    }

    const result = verifyControlEnvelope(tampered, secret, { now: 1_700_000_000_200 })
    expect(result).toEqual({ ok: false, reason: "invalid-signature" })
  })

  test("rejects expired envelopes", () => {
    const epoch = new FencingEpochGenerator(7).next(1_700_000_000_000)
    const envelope = createControlEnvelope({
      secret,
      namespaceID: "local",
      workerID: "worker.alpha",
      epoch,
      action: "health",
      payload: {},
      now: 1_700_000_000_000,
      ttlMs: 100,
    })

    const result = verifyControlEnvelope(envelope, secret, { now: 1_700_000_000_200 })
    expect(result).toEqual({ ok: false, reason: "expired" })
  })

  test("rejects envelopes issued too far in the future", () => {
    const epoch = new FencingEpochGenerator(7).next(1_700_000_000_000)
    const envelope = createControlEnvelope({
      secret,
      namespaceID: "local",
      workerID: "worker.alpha",
      epoch,
      action: "health",
      payload: {},
      now: 1_700_000_010_000,
      ttlMs: 1_000,
    })

    const result = verifyControlEnvelope(envelope, secret, {
      now: 1_700_000_000_000,
      maxFutureSkewMs: 5_000,
    })
    expect(result).toEqual({ ok: false, reason: "issued-in-future" })
  })
})
