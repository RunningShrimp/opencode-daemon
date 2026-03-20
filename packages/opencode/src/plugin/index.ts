import type { Hooks, PluginInput, Plugin as PluginInstance } from "@opencode-ai/plugin"
import path from "path"
import { fileURLToPath } from "url"
import { Config } from "../config/config"
import { Bus } from "../bus"
import { Log } from "../util/log"
import { createOpencodeClient } from "@opencode-ai/sdk"
import { Server } from "../server/server"
import { BunProc } from "../bun"
import { Instance } from "../project/instance"
import { Flag } from "../flag/flag"
import { CodexAuthPlugin } from "./codex"
import { Session } from "../session"
import { NamedError } from "@opencode-ai/util/error"
import { CopilotAuthPlugin } from "./copilot"
import { gitlabAuthPlugin as GitlabAuthPlugin } from "@gitlab/opencode-gitlab-auth"
import { Filesystem } from "../util/filesystem"
import { Glob } from "../util/glob"

export namespace Plugin {
  const log = Log.create({ service: "plugin" })
  const BLOCKED_LEGACY_EMBEDDING_MODEL = "Xenova/all-MiniLM-L6-v2"
  const MAX_PLUGIN_SCAN_FILES = 256
  const MAX_PLUGIN_SCAN_BYTES = 512 * 1024

  const BUILTIN = ["opencode-anthropic-auth@0.0.13"]

  // Built-in plugins that are directly imported (not installed from npm)
  const INTERNAL_PLUGINS: PluginInstance[] = [CodexAuthPlugin, CopilotAuthPlugin, GitlabAuthPlugin]

  export function sourceUsesBlockedLegacyMiniLMEmbedding(source: string) {
    const normalized = source.toLowerCase()
    const referencesLegacyModel =
      normalized.includes("xenova/all-minilm-l6-v2") || normalized.includes("all-minilm-l6-v2")

    if (!referencesLegacyModel) return false

    return (
      normalized.includes("feature-extraction") ||
      normalized.includes("pipeline(") ||
      normalized.includes("transformersembeddingfunction")
    )
  }

  async function resolvePluginScanRoot(plugin: string) {
    const filesystemPath = plugin.startsWith("file://") ? fileURLToPath(plugin) : plugin
    const resolved = Filesystem.resolve(filesystemPath)
    const stats = Filesystem.stat(resolved)
    if (!stats) return
    if (stats.isDirectory()) return resolved

    const packageJson = (await Filesystem.findUp("package.json", path.dirname(resolved)))[0]
    return packageJson ? path.dirname(packageJson) : resolved
  }

  export async function findBlockedExternalPluginReason(plugin: string) {
    const scanRoot = await resolvePluginScanRoot(plugin)
    if (!scanRoot) return

    const stats = Filesystem.stat(scanRoot)
    const candidates = stats?.isDirectory()
      ? await Glob.scan("**/*.{js,mjs,cjs,ts,mts,cts,json}", {
          cwd: scanRoot,
          absolute: true,
          dot: true,
        })
      : [scanRoot]

    for (const file of candidates.slice(0, MAX_PLUGIN_SCAN_FILES)) {
      const relativePath = path.relative(scanRoot, file)
      if (relativePath.split(path.sep).includes("node_modules")) continue

      const fileStats = Filesystem.stat(file)
      if (!fileStats?.isFile()) continue

      const size = typeof fileStats.size === "bigint" ? Number(fileStats.size) : fileStats.size
      if (size > MAX_PLUGIN_SCAN_BYTES) continue

      const source = await Filesystem.readText(file).catch(() => "")
      if (!sourceUsesBlockedLegacyMiniLMEmbedding(source)) continue

      const location = relativePath || path.basename(file)
      return `references blocked legacy embedding model ${BLOCKED_LEGACY_EMBEDDING_MODEL} in ${location}`
    }
  }

  const state = Instance.state(async () => {
    const client = createOpencodeClient({
      baseUrl: "http://localhost:4096",
      directory: Instance.directory,
      headers: Flag.OPENCODE_SERVER_PASSWORD
        ? {
            Authorization: `Basic ${Buffer.from(`${Flag.OPENCODE_SERVER_USERNAME ?? "opencode"}:${Flag.OPENCODE_SERVER_PASSWORD}`).toString("base64")}`,
          }
        : undefined,
      fetch: async (...args) => Server.Default().fetch(...args),
    })
    const config = await Config.get()
    const hooks: Hooks[] = []
    const input: PluginInput = {
      client,
      project: Instance.project,
      worktree: Instance.worktree,
      directory: Instance.directory,
      get serverUrl(): URL {
        return Server.url ?? new URL("http://localhost:4096")
      },
      $: Bun.$,
    }

    for (const plugin of INTERNAL_PLUGINS) {
      log.info("loading internal plugin", { name: plugin.name })
      const init = await plugin(input).catch((err) => {
        log.error("failed to load internal plugin", { name: plugin.name, error: err })
      })
      if (init) hooks.push(init)
    }

    let plugins = config.plugin ?? []
    if (plugins.length) await Config.waitForDependencies()
    if (!Flag.OPENCODE_DISABLE_DEFAULT_PLUGINS) {
      plugins = [...BUILTIN, ...plugins]
    }

    for (let plugin of plugins) {
      // ignore old codex plugin since it is supported first party now
      if (plugin.includes("opencode-openai-codex-auth") || plugin.includes("opencode-copilot-auth")) continue
      log.info("loading plugin", { path: plugin })
      if (!plugin.startsWith("file://")) {
        const lastAtIndex = plugin.lastIndexOf("@")
        const pkg = lastAtIndex > 0 ? plugin.substring(0, lastAtIndex) : plugin
        const version = lastAtIndex > 0 ? plugin.substring(lastAtIndex + 1) : "latest"
        plugin = await BunProc.install(pkg, version).catch((err) => {
          const cause = err instanceof Error ? err.cause : err
          const detail = cause instanceof Error ? cause.message : String(cause ?? err)
          log.error("failed to install plugin", { pkg, version, error: detail })
          Bus.publish(Session.Event.Error, {
            error: new NamedError.Unknown({
              message: `Failed to install plugin ${pkg}@${version}: ${detail}`,
            }).toObject(),
          })
          return ""
        })
        if (!plugin) continue
      }

      const blockedReason = await findBlockedExternalPluginReason(plugin)
      if (blockedReason) {
        log.warn("blocked external plugin with legacy embedding dependency", {
          path: plugin,
          reason: blockedReason,
        })
        Bus.publish(Session.Event.Error, {
          error: new NamedError.Unknown({
            message: `Blocked plugin ${plugin}: ${blockedReason}. Remove or update the plugin to stop legacy MiniLM tokenizer fetch failures.`,
          }).toObject(),
        })
        continue
      }

      // Prevent duplicate initialization when plugins export the same function
      // as both a named export and default export (e.g., `export const X` and `export default X`).
      // Object.entries(mod) would return both entries pointing to the same function reference.
      await import(plugin)
        .then(async (mod) => {
          const seen = new Set<PluginInstance>()
          for (const [_name, fn] of Object.entries<PluginInstance>(mod)) {
            if (seen.has(fn)) continue
            seen.add(fn)
            hooks.push(await fn(input))
          }
        })
        .catch((err) => {
          const message = err instanceof Error ? err.message : String(err)
          log.error("failed to load plugin", { path: plugin, error: message })
          Bus.publish(Session.Event.Error, {
            error: new NamedError.Unknown({
              message: `Failed to load plugin ${plugin}: ${message}`,
            }).toObject(),
          })
        })
    }

    return {
      hooks,
      input,
    }
  })

  export async function trigger<
    Name extends Exclude<keyof Required<Hooks>, "auth" | "event" | "tool">,
    Input = Parameters<Required<Hooks>[Name]>[0],
    Output = Parameters<Required<Hooks>[Name]>[1],
  >(name: Name, input: Input, output: Output): Promise<Output> {
    if (!name) return output
    for (const hook of await state().then((x) => x.hooks)) {
      const fn = hook[name]
      if (!fn) continue
      // @ts-expect-error if you feel adventurous, please fix the typing, make sure to bump the try-counter if you
      // give up.
      // try-counter: 2
      await fn(input, output)
    }
    return output
  }

  export async function list() {
    return state().then((x) => x.hooks)
  }

  export async function init() {
    const hooks = await state().then((x) => x.hooks)
    const config = await Config.get()
    for (const hook of hooks) {
      // @ts-expect-error this is because we haven't moved plugin to sdk v2
      await hook.config?.(config)
    }
    Bus.subscribeAll(async (input) => {
      const hooks = await state().then((x) => x.hooks)
      for (const hook of hooks) {
        hook["event"]?.({
          event: input,
        })
      }
    })
  }
}
