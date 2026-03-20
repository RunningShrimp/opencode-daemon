import { Hash } from "@/util/hash"

const ENV_KEY_PATTERN = /^[A-Z][A-Z0-9_]*$/

export interface ToolchainRuntimeProfileInput {
  language: string
  runtime: string
  version?: string
  env?: Record<string, string | undefined>
  formatter?: string
}

export interface ToolchainRuntimeProfile {
  language: string
  runtime: string
  version?: string
  formatter?: string
  env: Record<string, string>
  envFingerprint: string
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map((entry) => stableValue(entry))

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

function normalizeEnvMap(input: Record<string, string | undefined> | undefined): Record<string, string> {
  if (!input) return {}

  const entries = Object.entries(input)
    .filter((entry): entry is [string, string] => typeof entry[1] === "string")
    .map(([key, value]) => [key.trim().toUpperCase(), value.trim()] as const)
    .filter(([key, value]) => key.length > 0 && value.length > 0)
    .filter(([key]) => ENV_KEY_PATTERN.test(key))
    .sort(([a], [b]) => a.localeCompare(b))

  return Object.fromEntries(entries)
}

function normalizeRequired(value: string, label: string): string {
  const normalized = value.trim().toLowerCase()
  if (!normalized) throw new Error(`${label} is required`)
  return normalized
}

function normalizeOptional(value: string | undefined): string | undefined {
  const normalized = value?.trim()
  return normalized ? normalized : undefined
}

export function createToolchainEnvFingerprint(input: {
  language: string
  runtime: string
  version?: string
  formatter?: string
  env: Record<string, string>
}): string {
  return Hash.fast(
    canonicalJson({
      language: input.language,
      runtime: input.runtime,
      version: input.version,
      formatter: input.formatter,
      env: input.env,
    }),
  )
}

export function normalizeToolchainRuntimeProfile(input: ToolchainRuntimeProfileInput): ToolchainRuntimeProfile {
  const language = normalizeRequired(input.language, "language")
  const runtime = normalizeRequired(input.runtime, "runtime")
  const version = normalizeOptional(input.version)
  const formatter = normalizeOptional(input.formatter)?.toLowerCase()
  const env = normalizeEnvMap(input.env)

  const envFingerprint = createToolchainEnvFingerprint({
    language,
    runtime,
    version,
    formatter,
    env,
  })

  return {
    language,
    runtime,
    version,
    formatter,
    env,
    envFingerprint,
  }
}
