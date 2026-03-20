import { describe, expect, test } from "bun:test"
import path from "node:path"
import { projectInfo } from "@/test-helpers/ids"
import { ProjectIdentityResolver } from "@/daemon/identity/project-identity-resolver"

describe("project identity resolver", () => {
  test("selects nearest sandbox root and preserves worktree root", async () => {
    const resolver = new ProjectIdentityResolver()
    const worktree = path.join("/tmp", "repo-worktree")
    const sandbox = path.join(worktree, "apps", "service-a")
    const directory = path.join(sandbox, "src")

    const result = await resolver.resolveFromProject({
      namespaceID: "local",
      directory,
      project: projectInfo("project-alpha", worktree, {
        sandboxes: [worktree, sandbox],
      }),
      runtimeBoundary: {
        projectEnv: { NODE_ENV: "production" },
        toolchain: {
          language: "typescript",
          runtime: "bun",
          env: {},
        },
      },
    })

    expect(result.sandboxRoot).toBe(sandbox)
    expect(result.worktreeRoot).toBe(worktree)
    expect(result.repository.projectID).toBe(result.runtime.repository.projectID)
    expect(String(result.runtime.runtimeKey)).toContain("prk_v1:")
  })

  test("produces different runtime keys for same project across worktrees", async () => {
    const resolver = new ProjectIdentityResolver()
    const projectId = "project-shared"

    const first = await resolver.resolveFromProject({
      namespaceID: "local",
      directory: "/tmp/repo-a/src",
      project: projectInfo(projectId, "/tmp/repo-a", { sandboxes: ["/tmp/repo-a"] }),
      runtimeBoundary: {
        projectEnv: { NODE_ENV: "production" },
        toolchain: {
          language: "typescript",
          runtime: "bun",
          env: {},
        },
      },
    })

    const second = await resolver.resolveFromProject({
      namespaceID: "local",
      directory: "/tmp/repo-b/src",
      project: projectInfo(projectId, "/tmp/repo-b", { sandboxes: ["/tmp/repo-b"] }),
      runtimeBoundary: {
        projectEnv: { NODE_ENV: "production" },
        toolchain: {
          language: "typescript",
          runtime: "bun",
          env: {},
        },
      },
    })

    expect(first.repository.projectID).toBe(second.repository.projectID)
    expect(first.runtime.runtimeKey).not.toBe(second.runtime.runtimeKey)
  })
})
