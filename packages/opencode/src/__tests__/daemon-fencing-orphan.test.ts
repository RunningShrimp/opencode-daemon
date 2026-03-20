import { describe, expect, test } from "bun:test"
import { FencingEpochGenerator, compareFencingEpoch, parseFencingEpoch } from "@/daemon/protocol/fencing-epoch"
import {
  createOrphanAdoptionDecisionLog,
  OrphanAdoptionProtocol,
  ORPHAN_ADOPTION_RULESET_VERSION,
} from "@/daemon/protocol/orphan-adoption"

describe("daemon fencing epoch", () => {
  test("generates monotonic epochs", () => {
    const generator = new FencingEpochGenerator(42)
    const first = generator.next(1_710_000_000_000)
    const second = generator.next(1_710_000_000_000)
    const third = generator.next(1_710_000_000_010)

    expect(compareFencingEpoch(first, second)).toBe(-1)
    expect(compareFencingEpoch(second, third)).toBe(-1)
    expect(parseFencingEpoch(first).processID).toBe(42)
  })
})

describe("orphan adoption protocol", () => {
  test("adopts only when epoch matches and state is healthy", () => {
    const generator = new FencingEpochGenerator(1)
    const epoch = generator.next(1_700_000_000_000)

    const decision = OrphanAdoptionProtocol.decide({
      masterEpoch: epoch,
      workerEpoch: epoch,
      health: {
        responsive: true,
        stateComplete: true,
        hasRecoverableState: true,
      },
    })

    expect(decision).toEqual({
      action: "adopt",
      reason: "worker-safe-to-adopt",
    })
  })

  test("reaps stale or unhealthy workers", () => {
    const generator = new FencingEpochGenerator(1)
    const oldEpoch = generator.next(1_700_000_000_000)
    const newEpoch = generator.next(1_700_000_000_010)

    const staleDecision = OrphanAdoptionProtocol.decide({
      masterEpoch: newEpoch,
      workerEpoch: oldEpoch,
      health: {
        responsive: true,
        stateComplete: true,
        hasRecoverableState: true,
      },
    })

    const unhealthyDecision = OrphanAdoptionProtocol.decide({
      masterEpoch: newEpoch,
      workerEpoch: newEpoch,
      health: {
        responsive: false,
        stateComplete: true,
        hasRecoverableState: true,
      },
    })

    expect(staleDecision.action).toBe("reap-and-respawn")
    expect(unhealthyDecision.action).toBe("reap-and-respawn")
  })

  test("emits versioned decision logs with frozen fields", () => {
    const generator = new FencingEpochGenerator(7)
    const epoch = generator.next(1_700_000_000_000)
    const decision = OrphanAdoptionProtocol.decide({
      masterEpoch: epoch,
      workerEpoch: epoch,
      health: {
        responsive: true,
        stateComplete: true,
        hasRecoverableState: true,
      },
    })

    const log = createOrphanAdoptionDecisionLog({
      observedAt: 1_700_000_000_100,
      runtimeKey: "prk_v1:local:project:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      workerID: "worker.test",
      workerPID: 12345,
      masterEpoch: epoch,
      workerEpoch: epoch,
      health: {
        responsive: true,
        stateComplete: true,
        hasRecoverableState: true,
      },
      decision,
    })

    expect(log.rulesetVersion).toBe(ORPHAN_ADOPTION_RULESET_VERSION)
    expect(log.action).toBe("adopt")
    expect(log.reason).toBe("worker-safe-to-adopt")
    expect(log.masterEpoch).toBe(epoch)
    expect(log.workerEpoch).toBe(epoch)
    expect(log.runtimeKey.startsWith("prk_v1:")).toBe(true)
  })
})
