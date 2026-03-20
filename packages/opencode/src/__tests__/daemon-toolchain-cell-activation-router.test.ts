import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { ProjectID } from "@/project/schema"
import { resolveProjectRepositoryIdentity, resolveProjectRuntimeIdentity } from "@/daemon/identity/project-identity"
import { WorkerID } from "@/daemon/identity/ids"
import { ToolchainCellRegistry } from "@/daemon/worker/toolchain-cell-registry"
import { ToolchainCellActivationRouter } from "@/daemon/worker/toolchain-cell-activation-router"

const cleanup: string[] = []

async function tempRegistryPath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-toolchain-activation-router-"))
  cleanup.push(dir)
  return path.join(dir, "daemon", "toolchain-cell-registry.json")
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

function runtimeKey(worktree: string): string {
  const repository = resolveProjectRepositoryIdentity({
    projectID: ProjectID.make("project-router"),
    repoRoot: worktree,
    vcs: "git",
  })

  return resolveProjectRuntimeIdentity({
    namespaceID: "local",
    repository,
    worktree,
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

describe("toolchain cell activation router", () => {
  test("routes lsp/formatter/env activation through the same ensured cell", async () => {
    const filePath = await tempRegistryPath()
    const registry = new ToolchainCellRegistry(filePath, () => 1_700_001_200_000)
    const router = new ToolchainCellActivationRouter(registry)

    const workerID = WorkerID.make("worker.router.1")
    const key = runtimeKey("/tmp/router-a")

    const lsp = await router.activateLSP({
      workerID,
      runtimeKey: key,
      laneID: "lane.router.1",
      directory: "/tmp/router-a",
      profile: {
        language: "typescript",
        runtime: "bun",
        env: { OPENCODE_TOOLCHAIN_CACHE: "on" },
      },
    })

    const formatter = await router.activateFormatter({
      workerID,
      runtimeKey: key,
      laneID: "lane.router.1",
      directory: "/tmp/router-a",
      profile: {
        language: "typescript",
        runtime: "bun",
        env: { OPENCODE_TOOLCHAIN_CACHE: "on" },
      },
    })

    const env = await router.activateEnv({
      workerID,
      runtimeKey: key,
      laneID: "lane.router.1",
      directory: "/tmp/router-a",
      profile: {
        language: "typescript",
        runtime: "bun",
        env: { OPENCODE_TOOLCHAIN_CACHE: "on" },
      },
    })

    expect(lsp.cell.cellID).toBe(formatter.cell.cellID)
    expect(formatter.cell.cellID).toBe(env.cell.cellID)
    expect(lsp.kind).toBe("lsp")
    expect(formatter.kind).toBe("formatter")
    expect(env.kind).toBe("env")
  })

  test("different profile maps to independent cells", async () => {
    const filePath = await tempRegistryPath()
    const registry = new ToolchainCellRegistry(filePath, () => 1_700_001_200_500)
    const router = new ToolchainCellActivationRouter(registry)

    const workerID = WorkerID.make("worker.router.2")
    const key = runtimeKey("/tmp/router-b")

    const ts = await router.activateLSP({
      workerID,
      runtimeKey: key,
      laneID: "lane.router.2a",
      directory: "/tmp/router-b",
      profile: {
        language: "typescript",
        runtime: "bun",
        env: {},
      },
    })

    const py = await router.activateLSP({
      workerID,
      runtimeKey: key,
      laneID: "lane.router.2b",
      directory: "/tmp/router-b",
      profile: {
        language: "python",
        runtime: "python",
        env: {},
      },
    })

    expect(ts.cell.cellID).not.toBe(py.cell.cellID)
  })
})
