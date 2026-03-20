import { describe, expect, test } from "bun:test"
import { isMasterWorkspaceControlRoute } from "@/control-plane/workspace-router-middleware"

describe("workspace router middleware route ownership", () => {
  test("keeps experimental workspace control routes on master", () => {
    expect(isMasterWorkspaceControlRoute("/experimental/workspace")).toBe(true)
    expect(isMasterWorkspaceControlRoute("/experimental/workspace/")).toBe(true)
    expect(isMasterWorkspaceControlRoute("/experimental/workspace/abc")).toBe(true)
  })

  test("does not treat non-workspace routes as master-only workspace control", () => {
    expect(isMasterWorkspaceControlRoute("/session")).toBe(false)
    expect(isMasterWorkspaceControlRoute("/experimental/worktree")).toBe(false)
    expect(isMasterWorkspaceControlRoute("/global/health")).toBe(false)
  })
})
