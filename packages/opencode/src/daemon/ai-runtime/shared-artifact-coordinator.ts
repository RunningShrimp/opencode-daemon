import path from "node:path"
import { existsSync } from "node:fs"
import { Global } from "@/global"
import { ModuleLoader } from "@/util/module-loader"
import { getModelsCache } from "@/provider/models-cache"
import { LANGUAGE_PACKAGES } from "@/ai/rag/tree-sitter-bg-service"
import type { ArtifactEnsureRequest } from "@/daemon/ai-runtime/ai-runtime-protocol"

interface ModuleLoaderLike {
  isInstalled(name: string): boolean
  install(input: {
    name: string
    version: string
    downloadUrls?: {
      official?: string
      china?: string
    }
    type: "native" | "wasm" | "js"
  }): Promise<boolean>
  getNodeModulesPath(name: string): string
}

interface ModelsCacheLike {
  initialize(): Promise<void>
  getModelCapability?(modelID: string): unknown | Promise<unknown>
}

export interface CoordinatedArtifactResolution {
  path: string
  cacheHit: boolean
}

export interface SharedArtifactCoordinator {
  ensure(request: ArtifactEnsureRequest): Promise<CoordinatedArtifactResolution>
}

export interface SharedArtifactCoordinatorOptions {
  moduleLoader?: ModuleLoaderLike
  getModelsCache?: () => ModelsCacheLike
  treeSitterPackages?: Record<string, string>
  dataPath?: string
  pathExists?: (targetPath: string) => boolean
  resolvePath?: (input: string) => string
}

function defaultRegistryMirror() {
  return {
    official: "https://registry.npmjs.org",
    china: "https://registry.npmmirror.com",
  }
}

export class DefaultSharedArtifactCoordinator implements SharedArtifactCoordinator {
  private readonly moduleLoader: ModuleLoaderLike
  private readonly getCache: () => ModelsCacheLike
  private readonly treeSitterPackages: Record<string, string>
  private readonly dataPath: string
  private readonly pathExists: (targetPath: string) => boolean
  private readonly resolvePath: (input: string) => string

  constructor(options: SharedArtifactCoordinatorOptions = {}) {
    this.moduleLoader = options.moduleLoader ?? ModuleLoader.getInstance()
    this.getCache = options.getModelsCache ?? (() => getModelsCache())
    this.treeSitterPackages = options.treeSitterPackages ?? (LANGUAGE_PACKAGES as Record<string, string>)
    this.dataPath = options.dataPath ?? Global.Path.data
    this.pathExists = options.pathExists ?? existsSync
    this.resolvePath = options.resolvePath ?? ((input) => path.resolve(input))
  }

  async ensure(request: ArtifactEnsureRequest): Promise<CoordinatedArtifactResolution> {
    switch (request.kind) {
      case "module":
        return this.ensurePackage({
          packageName: request.name,
          version: request.version ?? "latest",
          type: "js",
        })
      case "parser":
        return this.ensurePackage({
          packageName: this.resolveParserPackageName(request.name),
          version: request.version ?? "latest",
          type: "wasm",
        })
      case "model":
        return this.ensureModel(request.name)
      case "binary":
        return this.ensureBinary(request.name)
    }
  }

  private resolveParserPackageName(name: string) {
    const direct = this.treeSitterPackages[name]
    if (direct) return direct
    if (name.startsWith("tree-sitter-")) return name
    return `tree-sitter-${name}`
  }

  private async ensurePackage(input: {
    packageName: string
    version: string
    type: "native" | "wasm" | "js"
  }): Promise<CoordinatedArtifactResolution> {
    const cacheHit = this.moduleLoader.isInstalled(input.packageName)
    if (!cacheHit) {
      const installed = await this.moduleLoader.install({
        name: input.packageName,
        version: input.version,
        type: input.type,
        downloadUrls: defaultRegistryMirror(),
      })
      if (!installed) {
        throw new Error(`failed to ensure package artifact: ${input.packageName}`)
      }
    }

    return {
      path: this.moduleLoader.getNodeModulesPath(input.packageName),
      cacheHit,
    }
  }

  private async ensureModel(name: string): Promise<CoordinatedArtifactResolution> {
    const cache = this.getCache()
    await cache.initialize()
    if (cache.getModelCapability) {
      await Promise.resolve(cache.getModelCapability(name)).catch(() => null)
    }

    return {
      path: path.join(this.dataPath, "models-cache"),
      cacheHit: true,
    }
  }

  private async ensureBinary(name: string): Promise<CoordinatedArtifactResolution> {
    const resolvedPath = this.resolvePath(name)
    if (!this.pathExists(resolvedPath)) {
      throw new Error(`binary artifact not found: ${resolvedPath}`)
    }

    return {
      path: resolvedPath,
      cacheHit: true,
    }
  }
}
