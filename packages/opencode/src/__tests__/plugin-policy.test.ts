import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "fs/promises"
import os from "os"
import path from "path"
import { pathToFileURL } from "url"
import { Plugin } from "../plugin"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("plugin compatibility policy", () => {
  test("detects legacy MiniLM embedding initializers in plugin sources", () => {
    const source = `
      const MODEL_NAME = "Xenova/all-MiniLM-L6-v2"
      await pipeline("feature-extraction", MODEL_NAME)
    `

    expect(Plugin.sourceUsesBlockedLegacyMiniLMEmbedding(source)).toBeTrue()
  })

  test("ignores passive mentions of legacy MiniLM strings", () => {
    const source = `
      // migration note: Xenova/all-MiniLM-L6-v2 was removed in a previous release
      export const README_NOTE = "legacy model mentioned for documentation only"
    `

    expect(Plugin.sourceUsesBlockedLegacyMiniLMEmbedding(source)).toBeFalse()
  })

  test("blocks file-based plugins whose package tree hardcodes legacy MiniLM embeddings", async () => {
    const pluginRoot = await mkdtemp(path.join(os.tmpdir(), "opencode-plugin-policy-"))
    tempDirs.push(pluginRoot)

    await mkdir(path.join(pluginRoot, "src"), { recursive: true })
    await writeFile(
      path.join(pluginRoot, "package.json"),
      JSON.stringify({ name: "plugin-under-test", version: "0.0.0", type: "module" }, null, 2),
    )
    await writeFile(path.join(pluginRoot, "index.ts"), "export default async function plugin() { return {} }\n")
    await writeFile(
      path.join(pluginRoot, "src", "embeddings.ts"),
      [
        'const MODEL_NAME = "Xenova/all-MiniLM-L6-v2"',
        'await pipeline("feature-extraction", MODEL_NAME)',
        "",
      ].join("\n"),
    )

    const reason = await Plugin.findBlockedExternalPluginReason(pathToFileURL(path.join(pluginRoot, "index.ts")).href)

    expect(reason).toContain("Xenova/all-MiniLM-L6-v2")
    expect(reason).toContain("src/embeddings.ts")
  })
})