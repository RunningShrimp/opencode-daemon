import path from "node:path"
import { existsSync } from "node:fs"
import { Process } from "@/util/process"
import { Installation } from "@/installation"

export type SpawnMode = "master" | "worker" | "ai-runtime"

export interface SelfSpawnRequest {
  mode: SpawnMode
  namespaceID: string
  args?: string[]
  cwd?: string
  detached?: boolean
  env?: Record<string, string>
}

export interface SelfSpawnResult {
  pid: number
  command: string[]
}

function maybeScriptBootstrapArg() {
  const script = process.argv[1]
  if (!script) return []

  if (script.startsWith("-")) return []
  const extension = path.extname(script).toLowerCase()
  const isScript = [".js", ".mjs", ".cjs", ".ts", ".mts", ".cts"].includes(extension)
  if (!isScript) return []

  if (!existsSync(script)) return []
  return [script]
}

export function buildSelfSpawnCommand(input: { mode: SpawnMode; namespaceID: string; args?: string[] }) {
  const executable = Installation.executablePath()
  const command = [
    executable,
    ...maybeScriptBootstrapArg(),
    ...(input.args ?? []),
  ]

  return {
    command,
    env: {
      OPENCODE_DAEMON_MODE: input.mode,
      OPENCODE_DAEMON_NAMESPACE: input.namespaceID,
      OPENCODE_DAEMON_PARENT_PID: String(process.pid),
    },
  }
}

export class SelfSpawner {
  spawn(input: SelfSpawnRequest): SelfSpawnResult {
    const spec = buildSelfSpawnCommand({
      mode: input.mode,
      namespaceID: input.namespaceID,
      args: input.args,
    })

    const child = Process.spawn(spec.command, {
      cwd: input.cwd,
      env: {
        ...spec.env,
        ...(input.env ?? {}),
      },
      stdin: "ignore",
      stdout: input.detached ? "ignore" : "inherit",
      stderr: input.detached ? "ignore" : "inherit",
    })

    if (input.detached) {
      child.unref?.()
    }

    return {
      pid: child.pid ?? -1,
      command: spec.command,
    }
  }
}
