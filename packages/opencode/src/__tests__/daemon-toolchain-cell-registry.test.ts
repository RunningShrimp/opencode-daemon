import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ProjectID } from "@/project/schema"
import { resolveProjectRepositoryIdentity, resolveProjectRuntimeIdentity } from "@/daemon/identity/project-identity"
import { WorkerID } from "@/daemon/identity/ids"
import { ToolchainCellRegistry } from "@/daemon/worker/toolchain-cell-registry"

const cleanup: string[] = []

async function tempRegistryPath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-toolchain-cell-registry-"))
  cleanup.push(dir)
  return path.join(dir, "daemon", "toolchain-cell-registry.json")
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

function runtimeKey(input: { projectID: string; worktree: string }): string {
  const repository = resolveProjectRepositoryIdentity({
    projectID: ProjectID.make(input.projectID),
    repoRoot: input.worktree,
    vcs: "git",
  })

  return resolveProjectRuntimeIdentity({
    namespaceID: "local",
    repository,
    worktree: input.worktree,
    runtimeBoundary: {
      projectEnv: { NODE_ENV: "development" },
      toolchain: {
        language: "typescript",
        runtime: "bun",
        env: {},
      },
    },
  }).runtimeKey
}

describe("toolchain cell registry", () => {
  test("ensure reuses same cell for same runtime/profile and lane bindings", async () => {
    const filePath = await tempRegistryPath()
    let now = 1_700_001_100_000
    const registry = new ToolchainCellRegistry(filePath, () => now)

    const workerID = WorkerID.make("worker.cell.1")
    const key = runtimeKey({ projectID: "project-cell-1", worktree: "/tmp/cell-1" })

    const first = await registry.ensure({
      workerID,
      runtimeKey: key,
      laneID: "lane.cell.1a",
      profile: {
        language: "typescript",
        runtime: "bun",
        version: "1.3.10",
        env: { OPENCODE_TOOLCHAIN_CACHE: "enabled" },
      },
    })

    now += 500

    const second = await registry.ensure({
      workerID,
      runtimeKey: key,
      laneID: "lane.cell.1b",
      profile: {
        language: "typescript",
        runtime: "bun",
        version: "1.3.10",
        env: { OPENCODE_TOOLCHAIN_CACHE: "enabled" },
      },
    })

    expect(second.cellID).toBe(first.cellID)
    expect(second.state).toBe("active")
    expect(second.boundLaneIDs).toContain("lane.cell.1a")
    expect(second.boundLaneIDs).toContain("lane.cell.1b")
    expect(second.lastUsedAt).toBe(1_700_001_100_500)
  })

  test("ensure creates independent cells for different languages in same runtime", async () => {
    const filePath = await tempRegistryPath()
    const registry = new ToolchainCellRegistry(filePath, () => 1_700_001_101_000)

    const workerID = WorkerID.make("worker.cell.2")
    const key = runtimeKey({ projectID: "project-cell-2", worktree: "/tmp/cell-2" })

    const tsCell = await registry.ensure({
      workerID,
      runtimeKey: key,
      laneID: "lane.cell.2a",
      profile: {
        language: "typescript",
        runtime: "bun",
        env: {},
      },
    })

    const pyCell = await registry.ensure({
      workerID,
      runtimeKey: key,
      laneID: "lane.cell.2b",
      profile: {
        language: "python",
        runtime: "python",
        env: {},
      },
    })

    expect(tsCell.cellID).not.toBe(pyCell.cellID)
  })

  test("same language across different runtime keys does not share cells", async () => {
    const filePath = await tempRegistryPath()
    const registry = new ToolchainCellRegistry(filePath, () => 1_700_001_102_000)

    const workerID = WorkerID.make("worker.cell.3")

    const projectA = await registry.ensure({
      workerID,
      runtimeKey: runtimeKey({ projectID: "project-a", worktree: "/tmp/project-a" }),
      laneID: "lane.cell.3a",
      profile: {
        language: "typescript",
        runtime: "bun",
        env: {},
      },
    })

    const projectB = await registry.ensure({
      workerID,
      runtimeKey: runtimeKey({ projectID: "project-b", worktree: "/tmp/project-b" }),
      laneID: "lane.cell.3b",
      profile: {
        language: "typescript",
        runtime: "bun",
        env: {},
      },
    })

    expect(projectA.cellID).not.toBe(projectB.cellID)
    expect(projectA.runtimeKey).not.toBe(projectB.runtimeKey)
  })

  test("suspend and recycle change lifecycle as expected", async () => {
    const filePath = await tempRegistryPath()
    let now = 1_700_001_103_000
    const registry = new ToolchainCellRegistry(filePath, () => now)

    const cell = await registry.ensure({
      workerID: WorkerID.make("worker.cell.4"),
      runtimeKey: runtimeKey({ projectID: "project-cell-4", worktree: "/tmp/cell-4" }),
      laneID: "lane.cell.4a",
      profile: {
        language: "typescript",
        runtime: "bun",
        env: {},
      },
    })

    now += 500

    const suspended = await registry.suspend({
      cellID: cell.cellID,
      reason: "idle-timeout",
    })
    expect(suspended?.state).toBe("suspended")
    expect(suspended?.stateReason).toBe("idle-timeout")

    now += 500

    const resumed = await registry.ensure({
      workerID: cell.workerID,
      runtimeKey: cell.runtimeKey,
      laneID: "lane.cell.4b",
      profile: {
        language: "typescript",
        runtime: "bun",
        env: {},
      },
    })
    expect(resumed.cellID).toBe(cell.cellID)
    expect(resumed.state).toBe("active")

    now += 500

    const recycled = await registry.recycle({
      cellID: cell.cellID,
      reason: "memory-pressure",
    })
    expect(recycled?.state).toBe("recycled")
    expect(recycled?.boundLaneIDs).toHaveLength(0)

    now += 500

    const recreated = await registry.ensure({
      workerID: cell.workerID,
      runtimeKey: cell.runtimeKey,
      laneID: "lane.cell.4c",
      profile: {
        language: "typescript",
        runtime: "bun",
        env: {},
      },
    })
    expect(recreated.cellID).not.toBe(cell.cellID)
  })
})
