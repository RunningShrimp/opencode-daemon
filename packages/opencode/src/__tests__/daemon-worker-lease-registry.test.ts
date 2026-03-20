import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ProjectID } from "@/project/schema"
import { resolveProjectRepositoryIdentity, resolveProjectRuntimeIdentity } from "@/daemon/identity/project-identity"
import { FencingEpochGenerator } from "@/daemon/protocol/fencing-epoch"
import { WorkerID } from "@/daemon/identity/ids"
import { ProjectWorkerLeaseRegistry } from "@/daemon/worker/project-worker-lease-registry"
import type { ProjectWorkerDescriptor } from "@/daemon/worker/worker-descriptor"

const cleanup: string[] = []

async function tempFile() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-worker-registry-"))
  cleanup.push(dir)
  return path.join(dir, "daemon", "project-worker-registry.json")
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

function descriptor(input: {
  workerID: string
  projectID: string
  worktree: string
  epochSeed: number
  lastActiveAt?: number
}): ProjectWorkerDescriptor {
  const repository = resolveProjectRepositoryIdentity({
    projectID: ProjectID.make(input.projectID),
    repoRoot: input.worktree,
    vcs: "git",
  })

  const runtime = resolveProjectRuntimeIdentity({
    namespaceID: "local",
    repository,
    worktree: input.worktree,
    runtimeBoundary: {
      projectEnv: { NODE_ENV: "production" },
      toolchain: {
        language: "typescript",
        runtime: "bun",
        env: {},
      },
    },
  })

  return {
    workerID: WorkerID.make(input.workerID),
    runtime,
    state: "hot",
    pid: 1000 + input.epochSeed,
    startupEpoch: new FencingEpochGenerator(input.epochSeed).next(1_700_000_000_000 + input.epochSeed),
    startedAt: 1_700_000_000_000 + input.epochSeed,
    lastActiveAt: input.lastActiveAt,
    laneCount: 1,
    toolchainCellCount: 1,
  }
}

describe("project worker lease registry", () => {
  test("stores and retrieves descriptors keyed by runtimeKey", async () => {
    const filePath = await tempFile()
    const registry = new ProjectWorkerLeaseRegistry(filePath)

    const first = descriptor({
      workerID: "worker.alpha",
      projectID: "project-shared",
      worktree: "/tmp/worktree-a",
      epochSeed: 1,
      lastActiveAt: 100,
    })

    const second = descriptor({
      workerID: "worker.beta",
      projectID: "project-shared",
      worktree: "/tmp/worktree-b",
      epochSeed: 2,
      lastActiveAt: 200,
    })

    await registry.put(first)
    await registry.put(second)

    const listed = await registry.list()
    expect(listed).toHaveLength(2)
    expect(listed[0]?.runtime.runtimeKey).toBe(second.runtime.runtimeKey)
    expect(listed[1]?.runtime.runtimeKey).toBe(first.runtime.runtimeKey)

    const loaded = await registry.get(first.runtime.runtimeKey)
    expect(loaded?.workerID).toBe(first.workerID)
  })

  test("replaces descriptor for same runtimeKey and supports deletion", async () => {
    const filePath = await tempFile()
    const registry = new ProjectWorkerLeaseRegistry(filePath)

    const original = descriptor({
      workerID: "worker.gamma",
      projectID: "project-x",
      worktree: "/tmp/worktree-x",
      epochSeed: 5,
      lastActiveAt: 50,
    })

    const updated: ProjectWorkerDescriptor = {
      ...original,
      workerID: WorkerID.make("worker.gamma.updated"),
      laneCount: 3,
      lastActiveAt: 500,
    }

    await registry.put(original)
    await registry.put(updated)

    const afterUpdate = await registry.get(original.runtime.runtimeKey)
    expect(afterUpdate?.workerID).toBe(updated.workerID)
    expect(afterUpdate?.laneCount).toBe(3)

    await registry.delete(original.runtime.runtimeKey)
    const afterDelete = await registry.get(original.runtime.runtimeKey)
    expect(afterDelete).toBeUndefined()
  })
})
