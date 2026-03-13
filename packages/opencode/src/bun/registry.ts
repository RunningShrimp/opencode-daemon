import semver from "semver"
import { text } from "node:stream/consumers"
import { existsSync } from "fs"
import path from "path"
import { Log } from "../util/log"
import { Process } from "../util/process"

export namespace PackageRegistry {
  const log = Log.create({ service: "bun" })

  function which() {
    const execPath = process.execPath
    const ext = process.platform === "win32" ? ".exe" : ""
    const compatName = `opencode${ext}`
    const currentName = path.basename(execPath)

    if (currentName === `opencoded${ext}`) {
      const compatPath = path.join(path.dirname(execPath), compatName)
      if (existsSync(compatPath)) return compatPath
    }

    return execPath
  }

  export async function info(pkg: string, field: string, cwd?: string): Promise<string | null> {
    const result = Process.spawn([which(), "info", pkg, field], {
      cwd,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        BUN_BE_BUN: "1",
      },
    })

    const code = await result.exited
    const stdout = result.stdout ? await text(result.stdout) : ""
    const stderr = result.stderr ? await text(result.stderr) : ""

    if (code !== 0) {
      log.warn("bun info failed", { pkg, field, code, stderr })
      return null
    }

    const value = stdout.trim()
    if (!value) return null
    return value
  }

  export async function isOutdated(pkg: string, cachedVersion: string, cwd?: string): Promise<boolean> {
    const latestVersion = await info(pkg, "version", cwd)
    if (!latestVersion) {
      log.warn("Failed to resolve latest version, using cached", { pkg, cachedVersion })
      return false
    }

    const isRange = /[\s^~*xX<>|=]/.test(cachedVersion)
    if (isRange) return !semver.satisfies(latestVersion, cachedVersion)

    return semver.lt(cachedVersion, latestVersion)
  }
}
