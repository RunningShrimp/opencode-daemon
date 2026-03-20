import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { WorkerResourceArbiter } from "@/daemon/worker/worker-resource-arbiter"
import { LaneSideEffectOwnershipCoordinator } from "@/daemon/worker/lane-side-effect-ownership"

const cleanup: string[] = []

async function tempArbiterPath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-lane-side-effect-ownership-"))
  cleanup.push(dir)
  return path.join(dir, "daemon", "worker-resource-arbiter.json")
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe("lane side-effect ownership coordinator", () => {
  test("arbitrates approval ownership by lane", async () => {
    const filePath = await tempArbiterPath()
    const arbiter = new WorkerResourceArbiter(filePath, () => 1_700_001_000_000)
    const owner = new LaneSideEffectOwnershipCoordinator(arbiter)

    const first = await owner.begin({
      workerID: "worker.sidefx.1",
      laneID: "lane.sidefx.1a",
      kind: "approval",
      idempotencyKey: "approval-1a",
    })
    expect(first.status).toBe("accepted")
    expect(first.leaseToken).toBeTruthy()

    const second = await owner.begin({
      workerID: "worker.sidefx.1",
      laneID: "lane.sidefx.1b",
      kind: "approval",
      idempotencyKey: "approval-1b",
    })
    expect(second.status).toBe("partially-applied")
  })

  test("complete with release frees pty ownership for another lane", async () => {
    const filePath = await tempArbiterPath()
    const arbiter = new WorkerResourceArbiter(filePath, () => 1_700_001_000_500)
    const owner = new LaneSideEffectOwnershipCoordinator(arbiter)

    const first = await owner.begin({
      workerID: "worker.sidefx.2",
      laneID: "lane.sidefx.2a",
      kind: "pty",
      idempotencyKey: "pty-2a",
    })
    expect(first.status).toBe("accepted")

    const completed = await owner.complete({
      idempotencyKey: "pty-2a",
      status: "completed",
      detail: "pty-finished",
      release: {
        workerID: "worker.sidefx.2",
        laneID: "lane.sidefx.2a",
        kind: "pty",
        leaseToken: first.leaseToken,
      },
    })
    expect(completed.status).toBe("completed")

    const next = await owner.begin({
      workerID: "worker.sidefx.2",
      laneID: "lane.sidefx.2b",
      kind: "pty",
      idempotencyKey: "pty-2b",
    })
    expect(next.status).toBe("accepted")
  })

  test("recover returns persisted outcome codes", async () => {
    const filePath = await tempArbiterPath()
    const arbiter = new WorkerResourceArbiter(filePath, () => 1_700_001_001_000)
    const owner = new LaneSideEffectOwnershipCoordinator(arbiter)

    await owner.begin({
      workerID: "worker.sidefx.3",
      laneID: "lane.sidefx.3a",
      kind: "cancel",
      idempotencyKey: "cancel-3",
    })
    await owner.complete({
      idempotencyKey: "cancel-3",
      status: "unknown",
      detail: "lost-after-timeout",
    })

    const recovered = await owner.recover({ idempotencyKey: "cancel-3" })
    expect(recovered.status).toBe("unknown")
    expect(recovered.detail).toBe("lost-after-timeout")
  })
})
