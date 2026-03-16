import semver from "semver"
import { existsSync } from "fs"
import path from "path"
import { Log } from "../util/log"
import { Process } from "../util/process"

export namespace PackageRegistry {
  const log = Log.create({ service: "bun" })

  export function shouldRefreshCachedVersion(latestVersion: string, cachedVersion: string): boolean {
    const validLatestVersion = semver.valid(latestVersion)
    if (!validLatestVersion) {
      log.warn("latest version is invalid, using cached", { latestVersion, cachedVersion })
      return false
    }

    const isRange = /[\s^~*xX<>|=]/.test(cachedVersion)
    if (isRange) {
      const validRange = semver.validRange(cachedVersion)
      if (!validRange) {
        log.warn("cached version range is invalid, forcing refresh", { latestVersion, cachedVersion })
        return true
      }
      return !semver.satisfies(validLatestVersion, validRange)
    }

    const validCachedVersion = semver.valid(cachedVersion)
    if (!validCachedVersion) {
      log.warn("cached version is invalid, forcing refresh", { latestVersion, cachedVersion })
      return true
    }

    return semver.lt(validCachedVersion, validLatestVersion)
  }

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
    const { code, stdout, stderr } = await Process.run([which(), "info", pkg, field], {
      cwd,
      env: {
        ...process.env,
        BUN_BE_BUN: "1",
      },
      nothrow: true,
    })

    if (code !== 0) {
      log.warn("bun info failed", { pkg, field, code, stderr: stderr.toString() })
      return null
    }

    const value = stdout.toString().trim()
    if (!value) return null
    return value
  }

  export async function isOutdated(pkg: string, cachedVersion: string, cwd?: string): Promise<boolean> {
    const latestVersion = await info(pkg, "version", cwd)
    if (!latestVersion) {
      log.warn("Failed to resolve latest version, using cached", { pkg, cachedVersion })
      return false
    }

    return shouldRefreshCachedVersion(latestVersion, cachedVersion)
  }
}
