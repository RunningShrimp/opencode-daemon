import fs from "node:fs/promises"
import path from "node:path"
import { Filesystem } from "@/util/filesystem"
import { Global } from "@/global"

export interface BootstrapLockOptions {
  namespaceID: string
  timeoutMs?: number
  pollMs?: number
  staleAfterMs?: number
  rootDir?: string
}

export interface BootstrapLockHandle extends Disposable {
  readonly path: string
}

function lockFilePath(namespaceID: string, rootDir = Global.Path.state) {
  return path.join(rootDir, "daemon", "locks", `${namespaceID}.lock`)
}

function sleep(ms: number) {
  return new Promise<void>((resolve) => setTimeout(resolve, ms))
}

function isProcessAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function readLockInfo(filePath: string) {
  const content = await fs.readFile(filePath, "utf8").catch(() => "")
  const [pidText, issuedAtText] = content.trim().split(":", 3)

  const pid = Number.parseInt(pidText || "", 10)
  const issuedAt = Number.parseInt(issuedAtText || "", 10)

  return {
    pid: Number.isFinite(pid) && pid > 0 ? pid : undefined,
    issuedAt: Number.isFinite(issuedAt) && issuedAt > 0 ? issuedAt : undefined,
  }
}

async function shouldReapLock(filePath: string, staleAfterMs: number) {
  const stat = await fs.stat(filePath).catch(() => undefined)
  if (!stat) return false

  const lock = await readLockInfo(filePath)
  if (lock.pid && !isProcessAlive(lock.pid)) {
    return true
  }

  const ageByContent = lock.issuedAt ? Date.now() - lock.issuedAt : undefined
  if (ageByContent !== undefined && ageByContent > staleAfterMs) {
    return true
  }

  return Date.now() - stat.mtimeMs > staleAfterMs
}

export async function acquireBootstrapLock(options: BootstrapLockOptions): Promise<BootstrapLockHandle> {
  const timeoutMs = options.timeoutMs ?? 10_000
  const pollMs = options.pollMs ?? 50
  const staleAfterMs = options.staleAfterMs ?? 15_000
  const filePath = lockFilePath(options.namespaceID, options.rootDir)
  const startedAt = Date.now()

  await fs.mkdir(path.dirname(filePath), { recursive: true })

  while (true) {
    try {
      const handle = await fs.open(filePath, "wx", 0o600)
      await handle.writeFile(`${process.pid}:${Date.now()}`)
      await handle.close()

      return {
        path: filePath,
        [Symbol.dispose]() {
          // Best-effort release: lock files must never block process shutdown.
          void fs.rm(filePath, { force: true })
        },
      }
    } catch (error) {
      const isAlreadyExists =
        typeof error === "object" && error !== null && "code" in error && (error as { code: string }).code === "EEXIST"

      if (!isAlreadyExists) {
        throw error
      }

      if (await shouldReapLock(filePath, staleAfterMs)) {
        await fs.rm(filePath, { force: true })
        continue
      }

      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Timed out waiting for bootstrap lock: ${filePath}`)
      }

      await sleep(pollMs)
    }
  }
}

export async function hasBootstrapLock(namespaceID: string, rootDir?: string) {
  return Filesystem.exists(lockFilePath(namespaceID, rootDir))
}
