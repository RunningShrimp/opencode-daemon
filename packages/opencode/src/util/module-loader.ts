import { Log } from "./log"
import { Global } from "../global"
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import path from "node:path"
import { BunProc } from "../bun"

const log = Log.create({ service: "module-loader" })

interface ModuleConfig {
  name: string
  version: string
  downloadUrls?: {
    official?: string
    china?: string
  }
  type: "native" | "wasm" | "js"
  platforms?: {
    os?: string[]
    arch?: string[]
  }
}

interface InstalledModule {
  name: string
  version: string
  installedAt: number
  platform: string
  arch: string
}

type NetworkType = "china" | "global" | "unknown"

export const MODULE_CONFIGS: Record<string, ModuleConfig> = {
  "@lancedb/lancedb": {
    name: "@lancedb/lancedb",
    version: "latest",
    type: "native",
  },
  "@xenova/transformers": {
    name: "@xenova/transformers",
    version: "latest",
    type: "wasm",
  },
}

export class ModuleLoader {
  private static instance: ModuleLoader
  private modulesDir: string
  private metadataPath: string
  private metadata: Map<string, InstalledModule> = new Map()
  private platform: string
  private arch: string
  private pendingInstalls: Map<string, Promise<boolean>> = new Map()

  private constructor() {
    this.modulesDir = path.join(Global.Path.data, "modules")
    this.metadataPath = path.join(this.modulesDir, "metadata.json")
    this.platform = process.platform
    this.arch = process.arch === "arm64" ? "arm64" : "x64"

    this.ensureDir()
    this.loadMetadata()
  }

  static getInstance(): ModuleLoader {
    if (!ModuleLoader.instance) {
      ModuleLoader.instance = new ModuleLoader()
    }
    return ModuleLoader.instance
  }

  private ensureDir(): void {
    if (!existsSync(this.modulesDir)) {
      mkdirSync(this.modulesDir, { recursive: true })
    }
  }

  private loadMetadata(): void {
    try {
      if (existsSync(this.metadataPath)) {
        const data = JSON.parse(readFileSync(this.metadataPath, "utf-8"))
        this.metadata = new Map(Object.entries(data))
      }
    } catch (error) {
      log.warn("failed to load module metadata", { error: String(error) })
    }
  }

  private saveMetadata(): void {
    try {
      const data = Object.fromEntries(this.metadata)
      writeFileSync(this.metadataPath, JSON.stringify(data, null, 2))
    } catch (error) {
      log.error("failed to save module metadata", { error: String(error) })
    }
  }

  private detectNetwork(): NetworkType {
    const tz = Intl.DateTimeFormat().resolvedOptions().timeZone
    if (tz.startsWith("Asia/Shanghai") || tz.startsWith("Asia/Chongqing") || tz.startsWith("Asia/Hong_Kong")) {
      return "china"
    }
    return "global"
  }

  getModulePath(name: string): string {
    const shortName = name.replace(/^@/, "").replace(/\//g, "-")
    return path.join(this.modulesDir, shortName)
  }

  getNodeModulesPath(name: string): string {
    const shortName = name.replace(/^@/, "").replace(/\//g, "-")
    return path.join(this.modulesDir, shortName, "node_modules", name)
  }

  isInstalled(name: string): boolean {
    const nodeModulesPath = this.getNodeModulesPath(name)
    return existsSync(nodeModulesPath)
  }

  async install(config: ModuleConfig): Promise<boolean> {
    const { name } = config

    if (this.isInstalled(name)) {
      log.info("module already installed", { name })
      return true
    }

    const pendingInstall = this.pendingInstalls.get(name)
    if (pendingInstall) {
      log.info("waiting for pending installation", { name })
      return pendingInstall
    }

    const installPromise = this.doInstall(config)
    this.pendingInstalls.set(name, installPromise)

    try {
      return await installPromise
    } finally {
      this.pendingInstalls.delete(name)
    }
  }

  private async doInstall(config: ModuleConfig): Promise<boolean> {
    const { name, version, downloadUrls } = config

    const networkType = this.detectNetwork()
    log.info("installing module", { name, version, networkType, platform: this.platform, arch: this.arch })

    let registry: string
    if (networkType === "china" && downloadUrls?.china) {
      registry = downloadUrls.china
    } else if (downloadUrls?.official) {
      registry = downloadUrls.official
    } else {
      registry = networkType === "china" ? "https://registry.npmmirror.com" : "https://registry.npmjs.org"
    }

    try {
      const installDir = this.getModulePath(name)
      if (!existsSync(installDir)) {
        mkdirSync(installDir, { recursive: true })
      }

      const packageJsonPath = path.join(installDir, "package.json")
      if (!existsSync(packageJsonPath)) {
        writeFileSync(packageJsonPath, JSON.stringify({ name: "opencode-modules", private: true, dependencies: {} }))
      }

      const registryArg = `--registry=${registry}`
      const osFlag = this.platform === "darwin" ? "darwin" : this.platform
      const cpuFlag = this.arch

      log.info("using bun path", { bunPath: BunProc.which() })

      await BunProc.run(
        [
          "add",
          `${name}@${version}`,
          registryArg,
          "--no-save",
          `--os=${osFlag}`,
          `--cpu=${cpuFlag}`,
        ],
        { cwd: installDir },
      )

      this.metadata.set(name, {
        name,
        version,
        installedAt: Date.now(),
        platform: this.platform,
        arch: this.arch,
      })
      this.saveMetadata()

      log.info("module installed successfully", { name, version, registry })
      return true
    } catch (error) {
      log.error("failed to install module", { name, version, error: String(error) })
      return false
    }
  }

  async load<T>(name: string): Promise<T> {
    if (!this.isInstalled(name)) {
      throw new Error(`Module ${name} is not installed. Please run ModuleLoader.install() first.`)
    }

    const nodeModulesPath = this.getNodeModulesPath(name)
    const url = `file://${nodeModulesPath}`
    return import(url) as Promise<T>
  }

  getModuleInfo(moduleName: string): InstalledModule | undefined {
    return this.metadata.get(moduleName)
  }
}

export async function installAndLoad<T>(moduleName: string): Promise<T> {
  const loader = ModuleLoader.getInstance()
  const config = MODULE_CONFIGS[moduleName]

  if (!config) {
    throw new Error(`No configuration found for module: ${moduleName}`)
  }

  const installed = await loader.install(config)
  if (!installed) {
    throw new Error(`Failed to install module: ${moduleName}`)
  }

  return loader.load<T>(moduleName)
}

export function isModuleInstalled(moduleName: string): boolean {
  return ModuleLoader.getInstance().isInstalled(moduleName)
}

export function getModuleInfo(moduleName: string): InstalledModule | undefined {
  return ModuleLoader.getInstance().getModuleInfo(moduleName)
}
