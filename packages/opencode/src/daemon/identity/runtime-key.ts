import path from "node:path"
import z from "zod"
import { ProjectID } from "@/project/schema"
import { Filesystem } from "@/util/filesystem"
import { Hash } from "@/util/hash"
import { NamespaceID } from "./ids"

type EnvMapInput = Record<string, string | undefined>

const ENV_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/

export interface ToolchainRuntimeProfile {
  language: string
  runtime: string
  version?: string
  env: Record<string, string>
}

export interface RuntimeBoundaryInput {
  projectEnv: EnvMapInput
  toolchain: ToolchainRuntimeProfile
}

export interface RuntimeFingerprints {
  workerEnvScope: string
  envFingerprint: string
  normalizedProjectEnv: Record<string, string>
  normalizedToolchainEnv: Record<string, string>
}

export interface ProjectRuntimeIdentityInput {
  namespaceID: string
  projectID: ProjectID
  worktree: string
  workerEnvScope: string
}

export const ProjectRuntimeKeySchema = z
  .string()
  .regex(/^prk_v1:[^:]{2,128}:[^:]{2,128}:[a-f0-9]{40}:[a-f0-9]{40}$/i, "Invalid ProjectRuntimeKey format")

export type ProjectRuntimeKey = z.infer<typeof ProjectRuntimeKeySchema>

export interface ProjectRuntimeKeyResult {
  value: ProjectRuntimeKey
  canonicalWorktree: string
  worktreeHash: string
  workerEnvScopeHash: string
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => stableValue(entry))
  }

  if (value && typeof value === "object") {
    const result: Record<string, unknown> = {}
    for (const key of Object.keys(value as Record<string, unknown>).sort()) {
      result[key] = stableValue((value as Record<string, unknown>)[key])
    }
    return result
  }

  return value
}

function canonicalJson(value: unknown) {
  return JSON.stringify(stableValue(value))
}

function normalizeEnvMap(input: EnvMapInput): Record<string, string> {
  const entries = Object.entries(input)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([key, value]) => [key.trim().toUpperCase(), value.trim()] as const)
    .filter(([key, value]) => key.length > 0 && value.length > 0)
    .filter(([key]) => ENV_KEY_PATTERN.test(key))
    .sort(([a], [b]) => a.localeCompare(b))

  return Object.fromEntries(entries)
}

function normalizeToolchainProfile(input: ToolchainRuntimeProfile) {
  return {
    language: input.language.trim().toLowerCase(),
    runtime: input.runtime.trim().toLowerCase(),
    version: input.version?.trim() || undefined,
    env: normalizeEnvMap(input.env),
  }
}

function sanitizePart(part: string, label: string) {
  const value = part.trim()
  if (!value) {
    throw new Error(`${label} must not be empty`)
  }

  if (value.includes(":")) {
    throw new Error(`${label} must not include ':'`)
  }

  if (value.length > 128) {
    throw new Error(`${label} must be <= 128 characters`)
  }

  return value
}

function canonicalizeWorktree(worktree: string) {
  const resolved = Filesystem.resolve(worktree)
  return path.normalize(resolved)
}

export function deriveRuntimeFingerprints(input: RuntimeBoundaryInput): RuntimeFingerprints {
  const normalizedProjectEnv = normalizeEnvMap(input.projectEnv)
  const normalizedToolchain = normalizeToolchainProfile(input.toolchain)

  const workerEnvScope = Hash.fast(canonicalJson(normalizedProjectEnv))
  const envFingerprint = Hash.fast(
    canonicalJson({
      language: normalizedToolchain.language,
      runtime: normalizedToolchain.runtime,
      version: normalizedToolchain.version,
      env: normalizedToolchain.env,
    }),
  )

  return {
    workerEnvScope,
    envFingerprint,
    normalizedProjectEnv,
    normalizedToolchainEnv: normalizedToolchain.env,
  }
}

export function createProjectRuntimeKey(input: ProjectRuntimeIdentityInput): ProjectRuntimeKeyResult {
  const namespaceID = NamespaceID.make(input.namespaceID)
  const projectID = sanitizePart(String(input.projectID), "ProjectID")
  const canonicalWorktree = canonicalizeWorktree(input.worktree)
  const worktreeHash = Hash.fast(canonicalWorktree)
  const workerEnvScopeHash = sanitizePart(input.workerEnvScope.toLowerCase(), "workerEnvScope")

  if (!/^[a-f0-9]{40}$/i.test(workerEnvScopeHash)) {
    throw new Error("workerEnvScope must be a SHA-1 hash")
  }

  const value = `prk_v1:${namespaceID}:${projectID}:${worktreeHash}:${workerEnvScopeHash}`
  return {
    value: ProjectRuntimeKeySchema.parse(value),
    canonicalWorktree,
    worktreeHash,
    workerEnvScopeHash,
  }
}

export function parseProjectRuntimeKey(value: string): ProjectRuntimeKey {
  return ProjectRuntimeKeySchema.parse(value)
}
