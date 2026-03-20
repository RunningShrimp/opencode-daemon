import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { WorkerResourceArbiter } from "@/daemon/worker/worker-resource-arbiter"

const cleanup: string[] = []

async function tempArbiterPath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-worker-arbiter-"))
  cleanup.push(dir)
  return path.join(dir, "daemon", "worker-resource-arbiter.json")
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe("worker resource arbiter", () => {
  test("acquire accepts first request and idempotent replay returns same state", async () => {
    const filePath = await tempArbiterPath()
    const arbiter = new WorkerResourceArbiter(filePath, () => 1_700_000_900_000)

    const first = await arbiter.acquire({
      workerID: "worker.arbiter.1",
      laneID: "lane.arbiter.1",
      resourceKey: "pty",
      idempotencyKey: "idem-1",
    })

    expect(first.status).toBe("accepted")
    expect(first.leaseToken).toBeTruthy()

    const replay = await arbiter.acquire({
      workerID: "worker.arbiter.1",
      laneID: "lane.arbiter.1",
      resourceKey: "pty",
      idempotencyKey: "idem-1",
    })

    expect(replay.status).toBe("accepted")
    expect(replay.leaseToken).toBe(first.leaseToken)
  })

  test("conflicting lane gets partially-applied and can recover same status", async () => {
    const filePath = await tempArbiterPath()
    const arbiter = new WorkerResourceArbiter(filePath, () => 1_700_000_900_500)

    await arbiter.acquire({
      workerID: "worker.arbiter.2",
      laneID: "lane.arbiter.2a",
      resourceKey: "approval",
      idempotencyKey: "idem-2a",
    })

    const conflict = await arbiter.acquire({
      workerID: "worker.arbiter.2",
      laneID: "lane.arbiter.2b",
      resourceKey: "approval",
      idempotencyKey: "idem-2b",
    })

    expect(conflict.status).toBe("partially-applied")
    expect(conflict.detail).toContain("resource-busy:approval")

    const recovered = await arbiter.recover({ idempotencyKey: "idem-2b" })
    expect(recovered.status).toBe("partially-applied")
    expect(recovered.detail).toContain("resource-busy:approval")
  })

  test("complete updates request outcome to completed", async () => {
    const filePath = await tempArbiterPath()
    const arbiter = new WorkerResourceArbiter(filePath, () => 1_700_000_901_000)

    await arbiter.acquire({
      workerID: "worker.arbiter.3",
      laneID: "lane.arbiter.3",
      resourceKey: "cancel",
      idempotencyKey: "idem-3",
    })

    const completed = await arbiter.complete({
      idempotencyKey: "idem-3",
      status: "completed",
      detail: "cancelled",
    })

    expect(completed.status).toBe("completed")
    expect(completed.detail).toBe("cancelled")

    const recovered = await arbiter.recover({ idempotencyKey: "idem-3" })
    expect(recovered.status).toBe("completed")
    expect(recovered.detail).toBe("cancelled")
  })

  test("release frees slot so another lane can acquire same resource", async () => {
    const filePath = await tempArbiterPath()
    const arbiter = new WorkerResourceArbiter(filePath, () => 1_700_000_901_500)

    const first = await arbiter.acquire({
      workerID: "worker.arbiter.4",
      laneID: "lane.arbiter.4a",
      resourceKey: "pty",
      idempotencyKey: "idem-4a",
    })

    const released = await arbiter.release({
      workerID: "worker.arbiter.4",
      laneID: "lane.arbiter.4a",
      resourceKey: "pty",
      leaseToken: first.leaseToken,
    })
    expect(released).toBe(true)

    const second = await arbiter.acquire({
      workerID: "worker.arbiter.4",
      laneID: "lane.arbiter.4b",
      resourceKey: "pty",
      idempotencyKey: "idem-4b",
    })

    expect(second.status).toBe("accepted")
    expect(second.leaseToken).toBeTruthy()
    expect(second.leaseToken).not.toBe(first.leaseToken)
  })

  test("recover returns unknown when no idempotency record exists", async () => {
    const filePath = await tempArbiterPath()
    const arbiter = new WorkerResourceArbiter(filePath, () => 1_700_000_902_000)

    const result = await arbiter.recover({ idempotencyKey: "missing" })
    expect(result.status).toBe("unknown")
  })
})
