import { afterEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { SharedArtifactRegistry } from "@/daemon/ai-runtime/shared-artifact-registry"

const cleanup: string[] = []

async function tempRegistryPath() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-shared-artifact-registry-"))
  cleanup.push(dir)
  return path.join(dir, "daemon", "shared-artifact-registry.json")
}

afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })))
})

describe("shared artifact registry", () => {
  test("ensures artifacts once and reuses existing path with cache hit", async () => {
    const filePath = await tempRegistryPath()
    const ensuredKeys: string[] = []
    const existing = new Set<string>()

    const registry = new SharedArtifactRegistry(filePath, {
      now: () => 1_700_002_100_000,
      pathExists(targetPath) {
        return existing.has(targetPath)
      },
      coordinator: {
        async ensure(request) {
          const artifactPath = `/artifact/${request.kind}/${request.name}`
          ensuredKeys.push(`${request.kind}:${request.name}`)
          existing.add(artifactPath)
          return {
            path: artifactPath,
            cacheHit: false,
          }
        },
      },
    })

    const first = await registry.ensure({
      kind: "module",
      name: "@scope/shared-module",
      version: "1.0.0",
    })
    expect(first.cacheHit).toBeFalse()

    const second = await registry.ensure({
      kind: "module",
      name: "@scope/shared-module",
      version: "1.0.0",
    })
    expect(second.cacheHit).toBeTrue()
    expect(second.path).toBe(first.path)
    expect(ensuredKeys).toHaveLength(1)

    const descriptor = await registry.get({
      kind: "module",
      name: "@scope/shared-module",
      version: "1.0.0",
    })

    expect(descriptor?.refCount).toBe(2)
  })

  test("releases artifact leases with non-negative refCount", async () => {
    const filePath = await tempRegistryPath()
    const existing = new Set<string>()

    const registry = new SharedArtifactRegistry(filePath, {
      now: () => 1_700_002_200_000,
      pathExists(targetPath) {
        return existing.has(targetPath)
      },
      coordinator: {
        async ensure(request) {
          const artifactPath = `/artifact/${request.kind}/${request.name}`
          existing.add(artifactPath)
          return {
            path: artifactPath,
            cacheHit: false,
          }
        },
      },
    })

    await registry.ensure({
      kind: "parser",
      name: "tree-sitter-typescript",
    })

    const released = await registry.release({
      kind: "parser",
      name: "tree-sitter-typescript",
    })

    expect(released?.refCount).toBe(0)

    const releasedAgain = await registry.release({
      kind: "parser",
      name: "tree-sitter-typescript",
    })
    expect(releasedAgain?.refCount).toBe(0)
  })

  test("re-ensures artifact when stored path disappears", async () => {
    const filePath = await tempRegistryPath()
    const existing = new Set<string>()
    let ensureCount = 0

    const registry = new SharedArtifactRegistry(filePath, {
      now: () => 1_700_002_300_000,
      pathExists(targetPath) {
        return existing.has(targetPath)
      },
      coordinator: {
        async ensure(request) {
          ensureCount += 1
          const artifactPath = `/artifact/${request.kind}/${request.name}/v${ensureCount}`
          existing.add(artifactPath)
          return {
            path: artifactPath,
            cacheHit: false,
          }
        },
      },
    })

    const first = await registry.ensure({
      kind: "model",
      name: "openai/gpt-4o",
    })

    existing.delete(first.path)

    const second = await registry.ensure({
      kind: "model",
      name: "openai/gpt-4o",
    })

    expect(ensureCount).toBe(2)
    expect(second.path).not.toBe(first.path)
  })
})
