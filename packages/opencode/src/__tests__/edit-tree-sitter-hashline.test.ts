import { describe, expect, test } from "bun:test"
import { hashFile } from "../util/hashline"
import { replaceWithContext } from "../tool/edit-core"
import { findTreeSitterScopedRange } from "../util/tree-sitter-scope"

describe("edit tree-sitter + hashline integration", () => {
  test("expands a hashline anchor to the containing syntax node before editing", async () => {
    const filePath = "/repo/test.sh"
    const content = [
      "first() {",
      "  echo one",
      "}",
      "",
      "second() {",
      "  echo two",
      "}",
    ].join("\n")
    const hashed = hashFile(filePath, content)
    const anchor = hashed.lines[1]
    const oldString = ["first() {", "  echo one", "}"].join("\n")
    const newString = ["first() {", "  echo renamed", "}"].join("\n")

    const result = await replaceWithContext(content, oldString, newString, false, {
      filePath,
      oldRange: `${anchor.number}#${anchor.hash}-${anchor.number}#${anchor.hash}`,
    })

    expect(result).toBe(["first() {", "  echo renamed", "}", "", "second() {", "  echo two", "}"].join("\n"))
  })

  test("falls back to plain hashline scoping when no syntax node matches", async () => {
    const filePath = "/repo/test.txt"
    const content = ["alpha", "beta", "alpha"].join("\n")
    const hashed = hashFile(filePath, content)
    const anchor = hashed.lines[1]

    const result = await replaceWithContext(content, "beta", "gamma", false, {
      filePath,
      oldRange: `${anchor.number}#${anchor.hash}-${anchor.number}#${anchor.hash}`,
    })

    expect(result).toBe(["alpha", "gamma", "alpha"].join("\n"))
  })

  test("rejects a stale AST syntaxHint even when the hashline still resolves", async () => {
    const filePath = "/repo/test.sh"
    const content = [
      "first() {",
      "  echo one",
      "}",
      "",
      "second() {",
      "  echo two",
      "}",
    ].join("\n")
    const hashed = hashFile(filePath, content)
    const anchor = hashed.lines[5]
    const wrongScope = await findTreeSitterScopedRange({
      filePath,
      content,
      oldString: ["first() {", "  echo one", "}"].join("\n"),
      startLine: 1,
      endLine: 2,
    })

    await expect(
      replaceWithContext(content, ["second() {", "  echo two", "}"].join("\n"), ["second() {", "  echo renamed", "}"].join("\n"), false, {
        filePath,
        oldRange: `${anchor.number}#${anchor.hash}-${anchor.number}#${anchor.hash}`,
        syntaxHint: wrongScope?.syntaxHint,
      }),
    ).rejects.toThrow(/syntaxHint/)
  })
})