import { describe, expect, test } from "bun:test"
import { PackageRegistry } from "../src/bun/registry"

describe("PackageRegistry.shouldRefreshCachedVersion", () => {
  test("keeps cached version when latest is invalid", () => {
    expect(PackageRegistry.shouldRefreshCachedVersion("not-a-version", "1.0.0")).toBe(false)
  })

  test("forces refresh when cached version is invalid", () => {
    expect(PackageRegistry.shouldRefreshCachedVersion("1.2.3", "1.0.0.d")).toBe(true)
  })

  test("forces refresh when cached range is invalid", () => {
    expect(PackageRegistry.shouldRefreshCachedVersion("1.2.3", ">>>1.0.0")).toBe(true)
  })

  test("keeps cached version when it is current", () => {
    expect(PackageRegistry.shouldRefreshCachedVersion("1.2.3", "1.2.3")).toBe(false)
  })
})