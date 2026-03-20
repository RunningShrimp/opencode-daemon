import { defer } from "@/util/defer"
import { rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { basename, extname, join } from "node:path"
import { CliRenderer } from "@opentui/core"
import { Filesystem } from "@/util/filesystem"
import { Process } from "@/util/process"
import { which } from "@/util/which"

export namespace Editor {
  function resolveEditorCommand() {
    const configured = process.env["VISUAL"] || process.env["EDITOR"]
    if (configured) return configured.split(" ").filter(Boolean)

    const fallbacks =
      process.platform === "win32"
        ? ["notepad"]
        : process.platform === "darwin" || process.platform === "linux"
          ? ["vim", "vi"]
          : []

    for (const candidate of fallbacks) {
      if (which(candidate)) return [candidate]
    }

    return undefined
  }

  function resolveDiffEditorCommand() {
    const configured = resolveEditorCommand()
    const configuredName = configured?.[0]?.split("/").at(-1)?.toLowerCase()
    if (configured && configuredName && ["vim", "vi", "nvim", "vimdiff", "nvimdiff"].includes(configuredName)) {
      return configured
    }

    const fallbacks = process.platform === "darwin" || process.platform === "linux" ? ["vim", "nvim", "vi"] : []
    for (const candidate of fallbacks) {
      if (which(candidate)) return [candidate]
    }

    return undefined
  }

  export async function openFile(opts: { filepath: string; renderer: CliRenderer }) {
    const editor = resolveEditorCommand()
    if (!editor) return

    opts.renderer.suspend()
    opts.renderer.currentRenderBuffer.clear()
    const proc = Process.spawn([...editor, opts.filepath], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    })
    await proc.exited
    opts.renderer.currentRenderBuffer.clear()
    opts.renderer.resume()
    opts.renderer.requestRender()
  }

  export async function openDiff(opts: {
    filepath: string
    before: string
    after: string
    renderer: CliRenderer
  }) {
    if (!opts.before && !opts.after) {
      await openFile({ filepath: opts.filepath, renderer: opts.renderer })
      return
    }

    const editor = resolveDiffEditorCommand()
    if (!editor) {
      await openFile({ filepath: opts.filepath, renderer: opts.renderer })
      return
    }

    const base = basename(opts.filepath)
    const extension = extname(base)
    const stem = extension ? base.slice(0, -extension.length) : base
    const dir = join(tmpdir(), `opencode-diff-${Date.now()}`)
    const beforePath = join(dir, `${stem}.before${extension}`)
    const afterPath = join(dir, `${stem}.after${extension}`)

    await Filesystem.write(beforePath, opts.before)
    await Filesystem.write(afterPath, opts.after)
    await using _ = defer(async () => rm(dir, { recursive: true, force: true }))

    opts.renderer.suspend()
    opts.renderer.currentRenderBuffer.clear()
    const proc = Process.spawn([...editor, "-d", "-R", beforePath, afterPath], {
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    })
    await proc.exited
    opts.renderer.currentRenderBuffer.clear()
    opts.renderer.resume()
    opts.renderer.requestRender()
  }

  export async function open(opts: { value: string; renderer: CliRenderer }): Promise<string | undefined> {
    const editor = resolveEditorCommand()
    if (!editor) return

    const filepath = join(tmpdir(), `${Date.now()}.md`)
    await using _ = defer(async () => rm(filepath, { force: true }))

    await Filesystem.write(filepath, opts.value)
    await openFile({ filepath, renderer: opts.renderer })
    const content = await Filesystem.readText(filepath)
    return content || undefined
  }
}
