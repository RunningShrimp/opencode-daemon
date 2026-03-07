import { Log } from "./log"
import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import z from "zod"
import fs from "fs"
import path from "path"

const log = Log.create({ service: "security" })

export const RateLimitConfig = z.object({
  maxOperations: z.number().default(100),
  windowMs: z.number().default(60000),
})
export type RateLimitConfig = z.infer<typeof RateLimitConfig>

interface RateLimitEntry {
  count: number
  resetAt: number
}

const rateLimiters = new Map<string, RateLimitEntry>()

export function checkRateLimit(key: string, config: RateLimitConfig = {}): boolean {
  const cfg = { maxOperations: 100, windowMs: 60000, ...config }
  const now = Date.now()
  const entry = rateLimiters.get(key)

  if (!entry || now > entry.resetAt) {
    rateLimiters.set(key, { count: 1, resetAt: now + cfg.windowMs })
    return true
  }

  if (entry.count >= cfg.maxOperations) {
    log.warn("rate limit exceeded", { key, count: entry.count, max: cfg.maxOperations })
    return false
  }

  entry.count++
  return true
}

export function resetRateLimit(key: string): void {
  rateLimiters.delete(key)
}

const DANGEROUS_BASH_COMMANDS = [
  "rm -rf /",
  "rm -rf /*",
  "mkfs",
  "dd if=",
  "> /dev/sd",
  ":(){ :|:& };:",
  "sudo",
  "su -",
  "chmod 777",
  "chown root",
  "curl http://",
  "wget http://",
  "nc -",
  "ncat",
  "/dev/tcp/",
  "cat /etc/passwd",
  "cat /etc/shadow",
  "cat ~/.ssh",
  "cat ~/.gnupg",
  "ssh-keygen",
  "kill -9 1",
  "killall",
  "pkill -9",
  "$((",
  "${",
  "`",
  "| bash",
  "| sh",
  "> /dev/null 2>&1 &",
]

const DANGEROUS_BASH_PATTERNS = [
  /\$\([^)]*\)/,
  /\$\{[^}]*\}/,
  /`[^`]*`/,
  /\|\s*(bash|sh|zsh|fish)/i,
  /;\s*(rm|sudo|chmod)/i,
  />\s*(\/dev\/|\/etc\/)/i,
]

export function isDangerousBash(command: string): boolean {
  const lower = command.toLowerCase().trim()

  for (const dangerous of DANGEROUS_BASH_COMMANDS) {
    if (lower.includes(dangerous.toLowerCase())) {
      log.warn("dangerous bash command detected", { command, pattern: dangerous })
      return true
    }
  }

  for (const pattern of DANGEROUS_BASH_PATTERNS) {
    if (pattern.test(command)) {
      log.warn("dangerous bash pattern detected", { command, pattern: pattern.source })
      return true
    }
  }

  return false
}

const DANGEROUS_POWERSHELL_CMDLETS = [
  "Invoke-Expression",
  "Invoke-Command",
  "Invoke-WebRequest",
  "Start-Process",
  "Set-ExecutionPolicy",
  "Remove-Item -Recurse",
  "Clear-Content",
  "Set-Content -Path",
  "[ScriptBlock]",
  "[System.Net.WebClient]",
]

const DANGEROUS_POWERSHELL_PATTERNS = [
  /\$\([^)]*\)/,
  /&\s*\(/,
  /\|\s*(iex|icm)/i,
  /\[ScriptBlock\]::Create/i,
  /-EncodedCommand/i,
]

export function isDangerousPowerShell(command: string): boolean {
  const trimmed = command.trim()

  for (const cmdlet of DANGEROUS_POWERSHELL_CMDLETS) {
    if (trimmed.includes(cmdlet)) {
      log.warn("dangerous PowerShell cmdlet detected", { command, cmdlet })
      return true
    }
  }

  for (const pattern of DANGEROUS_POWERSHELL_PATTERNS) {
    if (pattern.test(command)) {
      log.warn("dangerous PowerShell pattern detected", { command, pattern: pattern.source })
      return true
    }
  }

  return false
}

const SENSITIVE_ENV_PATTERNS = [
  /^PASSWORD/i,
  /^SECRET/i,
  /^API_KEY/i,
  /^APIKEY/i,
  /^TOKEN/i,
  /^AUTH/i,
  /^CREDENTIAL/i,
  /^PRIVATE_KEY/i,
  /^ACCESS_KEY/i,
  /^SESSION/i,
]

export function sanitizeEnvironment(env: Record<string, string | undefined>): Record<string, string | undefined> {
  const sanitized: Record<string, string | undefined> = {}

  for (const [key, value] of Object.entries(env)) {
    const upper = key.toUpperCase()
    const isSensitive = SENSITIVE_ENV_PATTERNS.some(p => upper.includes(p))

    if (isSensitive) {
      log.info("removing sensitive env var from command environment", { key })
      continue
    }

    sanitized[key] = value
  }

  return sanitized
}

export const SecurityAuditEvent = BusEvent.define(
  "security.audit",
  z.object({
    timestamp: z.number(),
    type: z.enum([
      "permission_auto_accept",
      "dangerous_command_blocked",
      "rate_limit_exceeded",
      "path_traversal_blocked",
      "symlink_escape_blocked",
      "env_sanitized",
    ]),
    sessionID: z.string().optional(),
    projectID: z.string().optional(),
    details: z.record(z.string(), z.any()),
  })
)

export function auditLog(
  type: z.infer<typeof SecurityAuditEvent>["payload"]["type"],
  details: Record<string, any>,
  context?: { sessionID?: string; projectID?: string }
): void {
  const event = {
    timestamp: Date.now(),
    type,
    sessionID: context?.sessionID,
    projectID: context?.projectID,
    details,
  }

  log.info("security audit", event)
  Bus.publish(SecurityAuditEvent, event)
}

export async function isPathEscape(
  targetPath: string,
  projectDir: string
): Promise<{ escaped: boolean; reason?: string; realPath?: string }> {
  try {
    const realTarget = await fs.promises.realpath(targetPath).catch(() => null)
    const realProject = await fs.promises.realpath(projectDir).catch(() => null)

    if (!realTarget || !realProject) {
      return { escaped: false, realPath: realTarget ?? targetPath }
    }

    const normalizedTarget = path.normalize(realTarget)
    const normalizedProject = path.normalize(realProject)

    if (
      !normalizedTarget.startsWith(normalizedProject + path.sep) &&
      normalizedTarget !== normalizedProject
    ) {
      log.warn("path escape detected", { targetPath, realTarget, projectDir, realProject })
      return {
        escaped: true,
        reason: "Path resolves outside project directory",
        realPath: realTarget,
      }
    }

    return { escaped: false, realPath: realTarget }
  } catch (error) {
    log.error("path escape check failed", { targetPath, projectDir, error: String(error) })
    return { escaped: false, reason: "Check failed" }
  }
}

export async function detectSuspiciousSymlink(
  filePath: string,
  projectDir: string
): Promise<{ suspicious: boolean; reason?: string }> {
  try {
    const stat = await fs.promises.lstat(filePath)

    if (stat.isSymbolicLink()) {
      const target = await fs.promises.readlink(filePath)

      if (path.isAbsolute(target)) {
        const realProject = await fs.promises.realpath(projectDir).catch(() => projectDir)

        if (!target.startsWith(realProject)) {
          return {
            suspicious: true,
            reason: `Symlink points outside project: ${target}`,
          }
        }
      }

      const sensitive = ["/etc", "/root", "~/.ssh", "~/.gnupg", "/var/log"]
      const expanded = target.replace(/^~/, process.env.HOME || "")

      for (const dir of sensitive) {
        if (expanded.startsWith(dir) || target.startsWith(dir)) {
          return {
            suspicious: true,
            reason: `Symlink points to sensitive directory: ${dir}`,
          }
        }
      }
    }

    return { suspicious: false }
  } catch {
    return { suspicious: false }
  }
}
