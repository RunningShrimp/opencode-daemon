import { describe, expect, test } from "bun:test"
import { ProjectID } from "@/project/schema"
import { createProjectRuntimeKey, deriveRuntimeFingerprints } from "@/daemon/identity/runtime-key"
import { resolveProjectRepositoryIdentity, resolveProjectRuntimeIdentity } from "@/daemon/identity/project-identity"

describe("daemon runtime identity", () => {
  test("creates stable ProjectRuntimeKey for same input", () => {
    const projectID = ProjectID.make("project-a")
    const fingerprints = deriveRuntimeFingerprints({
      projectEnv: {
        NODE_ENV: "production",
        OPENCODE_MODE: "fast",
      },
      toolchain: {
        language: "typescript",
        runtime: "bun",
        version: "1.2.0",
        env: {
          TS_NODE_PROJECT: "tsconfig.json",
        },
      },
    })

    const first = createProjectRuntimeKey({
      namespaceID: "local",
      projectID,
      worktree: "/tmp/workspaces/a",
      workerEnvScope: fingerprints.workerEnvScope,
    })

    const second = createProjectRuntimeKey({
      namespaceID: "local",
      projectID,
      worktree: "/tmp/workspaces/a",
      workerEnvScope: fingerprints.workerEnvScope,
    })

    expect(first.value).toBe(second.value)
    expect(first.worktreeHash).toBe(second.worktreeHash)
    expect(first.workerEnvScopeHash).toBe(second.workerEnvScopeHash)
  })

  test("isolates worktree and project-level environment boundaries", () => {
    const projectID = ProjectID.make("project-a")
    const base = deriveRuntimeFingerprints({
      projectEnv: {
        NODE_ENV: "production",
      },
      toolchain: {
        language: "typescript",
        runtime: "bun",
        env: {},
      },
    })

    const changedProjectEnv = deriveRuntimeFingerprints({
      projectEnv: {
        NODE_ENV: "development",
      },
      toolchain: {
        language: "typescript",
        runtime: "bun",
        env: {},
      },
    })

    const keyA = createProjectRuntimeKey({
      namespaceID: "local",
      projectID,
      worktree: "/tmp/workspaces/a",
      workerEnvScope: base.workerEnvScope,
    }).value

    const keyB = createProjectRuntimeKey({
      namespaceID: "local",
      projectID,
      worktree: "/tmp/workspaces/b",
      workerEnvScope: base.workerEnvScope,
    }).value

    const keyC = createProjectRuntimeKey({
      namespaceID: "local",
      projectID,
      worktree: "/tmp/workspaces/a",
      workerEnvScope: changedProjectEnv.workerEnvScope,
    }).value

    expect(keyA).not.toBe(keyB)
    expect(keyA).not.toBe(keyC)
  })

  test("keeps workerEnvScope independent from toolchain env changes", () => {
    const first = deriveRuntimeFingerprints({
      projectEnv: { NODE_ENV: "production" },
      toolchain: {
        language: "python",
        runtime: "uv",
        env: { PYTHONPATH: "/app" },
      },
    })

    const second = deriveRuntimeFingerprints({
      projectEnv: { NODE_ENV: "production" },
      toolchain: {
        language: "python",
        runtime: "uv",
        env: { PYTHONPATH: "/different" },
      },
    })

    expect(first.workerEnvScope).toBe(second.workerEnvScope)
    expect(first.envFingerprint).not.toBe(second.envFingerprint)
  })

  test("resolves repository identity and runtime identity together", () => {
    const repo = resolveProjectRepositoryIdentity({
      projectID: ProjectID.make("repo-root-1"),
      repoRoot: ".",
      vcs: "git",
    })

    const runtime = resolveProjectRuntimeIdentity({
      namespaceID: "local",
      repository: repo,
      worktree: ".",
      runtimeBoundary: {
        projectEnv: {
          NODE_ENV: "production",
        },
        toolchain: {
          language: "typescript",
          runtime: "bun",
          env: {},
        },
      },
    })

    expect(runtime.repository.projectID).toBe(repo.projectID)
    expect(runtime.runtimeKey).toContain("prk_v1:")
    expect(runtime.workerEnvScope.length).toBe(40)
    expect(runtime.envFingerprint.length).toBe(40)
  })
})
