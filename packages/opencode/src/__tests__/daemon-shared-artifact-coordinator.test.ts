import { describe, expect, test } from "bun:test"
import { DefaultSharedArtifactCoordinator } from "@/daemon/ai-runtime/shared-artifact-coordinator"

describe("shared artifact coordinator", () => {
  test("installs module artifacts when cache is cold", async () => {
    const installed = new Set<string>()
    const installCalls: string[] = []

    const coordinator = new DefaultSharedArtifactCoordinator({
      moduleLoader: {
        isInstalled(name) {
          return installed.has(name)
        },
        async install(input) {
          installCalls.push(`${input.name}@${input.version}`)
          installed.add(input.name)
          return true
        },
        getNodeModulesPath(name) {
          return `/virtual/node_modules/${name}`
        },
      },
      getModelsCache() {
        return {
          async initialize() {
            return
          },
        }
      },
    })

    const result = await coordinator.ensure({
      kind: "module",
      name: "@scope/example",
      version: "1.2.3",
    })

    expect(result.cacheHit).toBeFalse()
    expect(result.path).toBe("/virtual/node_modules/@scope/example")
    expect(installCalls).toEqual(["@scope/example@1.2.3"])
  })

  test("maps parser language names to tree-sitter package names", async () => {
    const installCalls: string[] = []

    const coordinator = new DefaultSharedArtifactCoordinator({
      treeSitterPackages: {
        rust: "tree-sitter-rust",
      },
      moduleLoader: {
        isInstalled() {
          return false
        },
        async install(input) {
          installCalls.push(input.name)
          return true
        },
        getNodeModulesPath(name) {
          return `/virtual/node_modules/${name}`
        },
      },
      getModelsCache() {
        return {
          async initialize() {
            return
          },
        }
      },
    })

    const result = await coordinator.ensure({
      kind: "parser",
      name: "rust",
    })

    expect(result.path).toBe("/virtual/node_modules/tree-sitter-rust")
    expect(installCalls).toEqual(["tree-sitter-rust"])
  })

  test("warms model cache and resolves model artifact path", async () => {
    let initialized = 0
    const capabilityChecks: string[] = []

    const coordinator = new DefaultSharedArtifactCoordinator({
      dataPath: "/virtual/data",
      moduleLoader: {
        isInstalled() {
          return true
        },
        async install() {
          return true
        },
        getNodeModulesPath(name) {
          return name
        },
      },
      getModelsCache() {
        return {
          async initialize() {
            initialized += 1
          },
          async getModelCapability(modelID: string) {
            capabilityChecks.push(modelID)
            return null
          },
        }
      },
    })

    const result = await coordinator.ensure({
      kind: "model",
      name: "openai/gpt-4o",
    })

    expect(result.path).toBe("/virtual/data/models-cache")
    expect(initialized).toBe(1)
    expect(capabilityChecks).toEqual(["openai/gpt-4o"])
  })

  test("validates binary artifact existence", async () => {
    const coordinator = new DefaultSharedArtifactCoordinator({
      moduleLoader: {
        isInstalled() {
          return true
        },
        async install() {
          return true
        },
        getNodeModulesPath(name) {
          return name
        },
      },
      getModelsCache() {
        return {
          async initialize() {
            return
          },
        }
      },
      resolvePath(input) {
        return `/resolved/${input}`
      },
      pathExists(targetPath) {
        return targetPath === "/resolved/tool.bin"
      },
    })

    const ok = await coordinator.ensure({
      kind: "binary",
      name: "tool.bin",
    })
    expect(ok.path).toBe("/resolved/tool.bin")

    await expect(
      coordinator.ensure({
        kind: "binary",
        name: "missing.bin",
      }),
    ).rejects.toThrow("binary artifact not found")
  })
})
