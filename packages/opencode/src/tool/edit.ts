// the approaches in this edit tool are sourced from
// https://github.com/cline/cline/blob/main/evals/diff-edits/diff-apply/diff-06-23-25.ts
// https://github.com/google-gemini/gemini-cli/blob/main/packages/core/src/utils/editCorrector.ts
// https://github.com/cline/cline/blob/main/evals/diff-edits/diff-apply/diff-06-26-25.ts

import z from "zod"
import * as path from "path"
import { Tool } from "./tool"
import { LSP } from "../lsp"
import { createTwoFilesPatch, diffLines } from "diff"
import DESCRIPTION from "./edit.txt"
import { File } from "../file"
import { FileWatcher } from "../file/watcher"
import { Bus } from "../bus"
import { FileTime } from "../file/time"
import { Filesystem } from "../util/filesystem"
import { Instance } from "../project/instance"
import { Snapshot } from "@/snapshot"
import { assertExternalDirectory } from "./external-directory"
import { replaceWithContext, trimDiff } from "./edit-core"
import { preloadMainstreamTreeSitterLanguagesInBackground } from "../util/tree-sitter-scope"

const MAX_DIAGNOSTICS_PER_FILE = 20

function normalizeLineEndings(text: string): string {
  return text.replaceAll("\r\n", "\n")
}

function detectLineEnding(text: string): "\n" | "\r\n" {
  return text.includes("\r\n") ? "\r\n" : "\n"
}

function convertToLineEnding(text: string, ending: "\n" | "\r\n"): string {
  if (ending === "\n") return text
  return text.replaceAll("\n", "\r\n")
}

export const EditTool = Tool.define("edit", {
  description: DESCRIPTION,
  parameters: z.object({
    filePath: z.string().describe("The absolute path to the file to modify"),
    oldString: z.string().describe("The text to replace"),
    newString: z.string().describe("The text to replace it with (must be different from oldString)"),
    replaceAll: z.boolean().optional().describe("Replace all occurrences of oldString (default false)"),
    oldRange: z
      .string()
      .optional()
      .describe("Optional hashline range like 10#a3f-15#b2c to scope the edit to a verified block"),
    syntaxHint: z
      .string()
      .optional()
      .describe("Optional tree-sitter AST hint copied from read output to revalidate the scoped syntax node"),
  }),
  async execute(params, ctx) {
    if (!params.filePath) {
      throw new Error("filePath is required")
    }

    if (params.oldString === params.newString) {
      throw new Error("No changes to apply: oldString and newString are identical.")
    }

    const filePath = path.isAbsolute(params.filePath) ? params.filePath : path.join(Instance.directory, params.filePath)
    await assertExternalDirectory(ctx, filePath)

    let diff = ""
    let contentOld = ""
    let contentNew = ""
    await FileTime.withLock(filePath, async () => {
      if (params.oldString === "") {
        const existed = await Filesystem.exists(filePath)
        contentNew = params.newString
        diff = trimDiff(createTwoFilesPatch(filePath, filePath, contentOld, contentNew))
        await ctx.ask({
          permission: "edit",
          patterns: [path.relative(Instance.worktree, filePath)],
          always: ["*"],
          metadata: {
            filepath: filePath,
            diff,
          },
        })
        await Filesystem.write(filePath, params.newString)
        await Bus.publish(File.Event.Edited, {
          file: filePath,
        })
        await Bus.publish(FileWatcher.Event.Updated, {
          file: filePath,
          event: existed ? "change" : "add",
        })
        FileTime.read(ctx.sessionID, filePath)
        return
      }

      const stats = Filesystem.stat(filePath)
      if (!stats) throw new Error(`File ${filePath} not found`)
      if (stats.isDirectory()) throw new Error(`Path is a directory, not a file: ${filePath}`)
      await FileTime.assert(ctx.sessionID, filePath)
      contentOld = await Filesystem.readText(filePath)

      const ending = detectLineEnding(contentOld)
      const old = convertToLineEnding(normalizeLineEndings(params.oldString), ending)
      const next = convertToLineEnding(normalizeLineEndings(params.newString), ending)

      void preloadMainstreamTreeSitterLanguagesInBackground()

      contentNew = await replaceWithContext(contentOld, old, next, params.replaceAll, {
        filePath,
        oldRange: params.oldRange,
        syntaxHint: params.syntaxHint,
      })

      diff = trimDiff(
        createTwoFilesPatch(filePath, filePath, normalizeLineEndings(contentOld), normalizeLineEndings(contentNew)),
      )
      await ctx.ask({
        permission: "edit",
        patterns: [path.relative(Instance.worktree, filePath)],
        always: ["*"],
        metadata: {
          filepath: filePath,
          diff,
        },
      })

      await Filesystem.write(filePath, contentNew)
      await Bus.publish(File.Event.Edited, {
        file: filePath,
      })
      await Bus.publish(FileWatcher.Event.Updated, {
        file: filePath,
        event: "change",
      })
      contentNew = await Filesystem.readText(filePath)
      diff = trimDiff(
        createTwoFilesPatch(filePath, filePath, normalizeLineEndings(contentOld), normalizeLineEndings(contentNew)),
      )
      FileTime.read(ctx.sessionID, filePath)
    })

    const filediff: Snapshot.FileDiff = {
      file: filePath,
      before: contentOld,
      after: contentNew,
      additions: 0,
      deletions: 0,
    }
    for (const change of diffLines(contentOld, contentNew)) {
      if (change.added) filediff.additions += change.count || 0
      if (change.removed) filediff.deletions += change.count || 0
    }

    ctx.metadata({
      metadata: {
        diff,
        filediff,
        diagnostics: {},
      },
    })

    let output = "Edit applied successfully."
    await LSP.touchFile(filePath, true)
    const diagnostics = await LSP.diagnostics()
    const normalizedFilePath = Filesystem.normalizePath(filePath)
    const issues = diagnostics[normalizedFilePath] ?? []
    const errors = issues.filter((item) => item.severity === 1)
    if (errors.length > 0) {
      const limited = errors.slice(0, MAX_DIAGNOSTICS_PER_FILE)
      const suffix =
        errors.length > MAX_DIAGNOSTICS_PER_FILE ? `\n... and ${errors.length - MAX_DIAGNOSTICS_PER_FILE} more` : ""
      output += `\n\nLSP errors detected in this file, please fix:\n<diagnostics file="${filePath}">\n${limited.map(LSP.Diagnostic.pretty).join("\n")}${suffix}\n</diagnostics>`
    }

    return {
      metadata: {
        diagnostics,
        diff,
        filediff,
      },
      title: `${path.relative(Instance.worktree, filePath)}`,
      output,
    }
  },
})

export {
  BlockAnchorReplacer,
  ContextAwareReplacer,
  EscapeNormalizedReplacer,
  IndentationFlexibleReplacer,
  LineTrimmedReplacer,
  MultiOccurrenceReplacer,
  replace,
  replaceWithContext,
  SimpleReplacer,
  trimDiff,
  TrimmedBoundaryReplacer,
  WhitespaceNormalizedReplacer,
  type ReplaceOptions,
  type Replacer,
} from "./edit-core"
