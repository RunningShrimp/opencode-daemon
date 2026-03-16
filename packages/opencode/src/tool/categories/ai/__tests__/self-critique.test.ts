import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import { join } from "path"
import { existsSync } from "fs"

describe("Self-Critique Tool", () => {
  beforeEach(() => {})

  afterEach(() => {})

  describe("Tool Definition", () => {
    test("tool module exists", async () => {
      const toolPath = join(__dirname, "../../../../ai/tools/self-critique.ts")
      expect(existsSync(toolPath) || existsSync(join(__dirname, "../../../../ai/tools/self-critique.js"))).toBe(true)
    })
  })
})
