import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { join } from "path"
import { existsSync } from "fs"

describe("Self-Critique Tool", () => {
  let testDir: string

  beforeEach(() => {
    testDir = `/tmp/opencode-test/self-critique-${Date.now()}`
  })

  afterEach(() => {})

  describe("Tool Definition", () => {
    test("tool module exists", async () => {
      const toolPath = join(__dirname, "../self-critique.ts")
      expect(existsSync(toolPath) || existsSync(join(__dirname, "../self-critique.js"))).toBe(true)
    })
  })
})
