import { describe, expect, test } from "bun:test"
import {
  createToolchainEnvFingerprint,
  normalizeToolchainRuntimeProfile,
} from "@/daemon/worker/toolchain-profile"

describe("toolchain runtime profile", () => {
  test("normalizes language/runtime/env and computes stable fingerprint", () => {
    const profile = normalizeToolchainRuntimeProfile({
      language: " TypeScript ",
      runtime: " Bun ",
      version: " 1.3.10 ",
      formatter: " Prettier ",
      env: {
        node_env: "ignored",
        OPENCODE_TOOLCHAIN_CACHE: " enabled ",
        OPENCODE_TOOLCHAIN_TARGET: " node ",
      },
    })

    expect(profile.language).toBe("typescript")
    expect(profile.runtime).toBe("bun")
    expect(profile.formatter).toBe("prettier")
    expect(profile.env).toEqual({
      NODE_ENV: "ignored",
      OPENCODE_TOOLCHAIN_CACHE: "enabled",
      OPENCODE_TOOLCHAIN_TARGET: "node",
    })
    expect(profile.envFingerprint).toMatch(/^[a-f0-9]{40}$/)
  })

  test("fingerprint is order-insensitive and changes on semantic changes", () => {
    const first = normalizeToolchainRuntimeProfile({
      language: "typescript",
      runtime: "bun",
      version: "1.3.10",
      env: {
        OPENCODE_TOOLCHAIN_A: "1",
        OPENCODE_TOOLCHAIN_B: "2",
      },
    })

    const second = normalizeToolchainRuntimeProfile({
      language: "typescript",
      runtime: "bun",
      version: "1.3.10",
      env: {
        OPENCODE_TOOLCHAIN_B: "2",
        OPENCODE_TOOLCHAIN_A: "1",
      },
    })

    const third = normalizeToolchainRuntimeProfile({
      language: "typescript",
      runtime: "bun",
      version: "1.3.10",
      env: {
        OPENCODE_TOOLCHAIN_A: "1",
        OPENCODE_TOOLCHAIN_B: "3",
      },
    })

    expect(first.envFingerprint).toBe(second.envFingerprint)
    expect(first.envFingerprint).not.toBe(third.envFingerprint)
  })

  test("createToolchainEnvFingerprint produces deterministic hash", () => {
    const fingerprint = createToolchainEnvFingerprint({
      language: "typescript",
      runtime: "bun",
      version: "1.3.10",
      formatter: "prettier",
      env: { OPENCODE_TOOLCHAIN_CACHE: "enabled" },
    })
    expect(fingerprint).toMatch(/^[a-f0-9]{40}$/)
  })
})
