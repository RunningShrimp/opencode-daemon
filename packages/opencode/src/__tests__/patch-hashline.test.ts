import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { hashFile } from "../util/hashline"
import { Patch } from "../patch"
import { findTreeSitterScopedRange } from "../util/tree-sitter-scope"

async function createTempFile(content: string) {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-patch-"))
  const filePath = path.join(dir, "test.sh")
  await fs.writeFile(filePath, content, "utf-8")
  return { dir, filePath }
}

describe("patch hashline and tree-sitter stale-check", () => {
  const cleanup: string[] = []

  afterEach(async () => {
    while (cleanup.length > 0) {
      const dir = cleanup.pop()
      if (dir) {
        await fs.rm(dir, { recursive: true, force: true })
      }
    }
  })

  test("parses update chunk hashline anchors and syntax hints", () => {
    const parsed = Patch.parsePatch(`*** Begin Patch
*** Update File: test.sh
@@ 6#a1b-6#a1b function_definition @@
-  echo same
+  echo changed
*** End Patch`)

    const update = parsed.hunks[0]
    expect(update.type).toBe("update")
    if (update.type !== "update") return
    expect(update.chunks[0].old_range).toBe("6#a1b-6#a1b")
    expect(update.chunks[0].syntax_hint).toBe("function_definition")
  })

  test("applies a duplicated patch inside the syntax-scoped anchored block", async () => {
    const content = [
      "first() {",
      "  echo same",
      "  echo end",
      "}",
      "",
      "second() {",
      "  echo same",
      "  echo end",
      "}",
      "",
    ].join("\n")
    const { dir, filePath } = await createTempFile(content)
    cleanup.push(dir)

    const hashed = hashFile(filePath, content)
    const anchor = hashed.lines[6]
    const scope = await findTreeSitterScopedRange({
      filePath,
      content,
      oldString: ["  echo same", "  echo end"].join("\n"),
      startLine: anchor.number,
      endLine: anchor.number,
    })
    const fileUpdate = await Patch.deriveNewContentsFromChunksAsync(filePath, [
      {
        old_range: `${anchor.number}#${anchor.hash}-${anchor.number}#${anchor.hash}`,
        syntax_hint: scope?.syntaxHint ?? "compound_statement",
        old_lines: ["  echo same", "  echo end"],
        new_lines: ["  echo changed", "  echo end"],
      },
    ])

    expect(fileUpdate.content).toContain("first() {\n  echo same\n  echo end\n}")
    expect(fileUpdate.content).toContain("second() {\n  echo changed\n  echo end\n}")
  })

  test("rejects stale hashline patch anchors", async () => {
    const original = ["first() {", "  echo same", "}", ""].join("\n")
    const { dir, filePath } = await createTempFile(["first() {", "  echo changed", "}", ""].join("\n"))
    cleanup.push(dir)

    const hashed = hashFile(filePath, original)
    const anchor = hashed.lines[1]

    await expect(
      Patch.deriveNewContentsFromChunksAsync(filePath, [
        {
          old_range: `${anchor.number}#${anchor.hash}-${anchor.number}#${anchor.hash}`,
          old_lines: ["  echo same"],
          new_lines: ["  echo newer"],
        },
      ]),
    ).rejects.toThrow(/Re-read the file and refresh the patch/)
  })

  test("rejects a mismatched AST syntax hint", async () => {
    const content = [
      "first() {",
      "  echo same",
      "  echo end",
      "}",
      "",
      "second() {",
      "  echo same",
      "  echo end",
      "}",
      "",
    ].join("\n")
    const { dir, filePath } = await createTempFile(content)
    cleanup.push(dir)

    const hashed = hashFile(filePath, content)
    const anchor = hashed.lines[6]
    const wrongScope = await findTreeSitterScopedRange({
      filePath,
      content,
      oldString: ["  echo same", "  echo end"].join("\n"),
      startLine: 2,
      endLine: 2,
    })

    await expect(
      Patch.deriveNewContentsFromChunksAsync(filePath, [
        {
          old_range: `${anchor.number}#${anchor.hash}-${anchor.number}#${anchor.hash}`,
          syntax_hint: wrongScope?.syntaxHint,
          old_lines: ["  echo same", "  echo end"],
          new_lines: ["  echo changed", "  echo end"],
        },
      ]),
    ).rejects.toThrow(/AST hint/)
  })

  test("uses AST-aware change_context to disambiguate duplicate blocks", async () => {
    const content = [
      "first() {",
      "  echo same",
      "  echo end",
      "}",
      "",
      "second() {",
      "  echo same",
      "  echo end",
      "}",
      "",
    ].join("\n")
    const { dir, filePath } = await createTempFile(content)
    cleanup.push(dir)

    const secondScope = await findTreeSitterScopedRange({
      filePath,
      content,
      oldString: ["second() {", "  echo same", "  echo end", "}"].join("\n"),
      startLine: 6,
      endLine: 8,
    })

    const fileUpdate = await Patch.deriveNewContentsFromChunksAsync(filePath, [
      {
        change_context: secondScope?.syntaxHint,
        old_lines: ["  echo same", "  echo end"],
        new_lines: ["  echo changed", "  echo end"],
      },
    ])

    expect(fileUpdate.content).toContain("first() {\n  echo same\n  echo end\n}")
    expect(fileUpdate.content).toContain("second() {\n  echo changed\n  echo end\n}")
  })

  test("uses AST-aware old_lines matching inside a narrowed patch region", async () => {
    const content = [
      "run() {",
      "  if test \"$A\" = \"1\"; then",
      "    echo same",
      "  fi",
      "  if test \"$B\" = \"1\"; then",
      "    echo same",
      "  fi",
      "}",
      "",
    ].join("\n")
    const { dir, filePath } = await createTempFile(content)
    cleanup.push(dir)

    const fileUpdate = await Patch.deriveNewContentsFromChunksAsync(filePath, [
      {
        change_context: '  if test "$B" = "1"; then',
        old_lines: ["    echo same"],
        new_lines: ["    echo changed"],
      },
    ])

    expect(fileUpdate.content).toContain("if test \"$A\" = \"1\"; then\n    echo same\n  fi")
    expect(fileUpdate.content).toContain("if test \"$B\" = \"1\"; then\n    echo changed\n  fi")
  })
})