import { Log } from "@/util/log"
import { BackgroundServiceManager, type IBackgroundService, type ServiceStatus } from "@/util/background-service"
import { ModuleLoader } from "@/util/module-loader"

const log = Log.create({ service: "tree-sitter-bg" })

export type SupportedLanguage =
  | "typescript"
  | "javascript"
  | "python"
  | "rust"
  | "go"
  | "cpp"
  | "csharp"
  | "bash"
  | "c"
  | "java"
  | "ruby"
  | "php"
  | "scala"
  | "html"
  | "json"
  | "yaml"
  | "haskell"
  | "css"
  | "julia"
  | "ocaml"
  | "clojure"
  | "swift"
  | "nix"

export const LANGUAGE_PACKAGES: Record<SupportedLanguage, string> = {
  typescript: "tree-sitter-typescript",
  javascript: "tree-sitter-javascript",
  python: "tree-sitter-python",
  rust: "tree-sitter-rust",
  go: "tree-sitter-go",
  cpp: "tree-sitter-cpp",
  csharp: "tree-sitter-c-sharp",
  bash: "tree-sitter-bash",
  c: "tree-sitter-c",
  java: "tree-sitter-java",
  ruby: "tree-sitter-ruby",
  php: "tree-sitter-php",
  scala: "tree-sitter-scala",
  html: "tree-sitter-html",
  json: "tree-sitter-json",
  yaml: "tree-sitter-yaml",
  haskell: "tree-sitter-haskell",
  css: "tree-sitter-css",
  julia: "tree-sitter-julia",
  ocaml: "tree-sitter-ocaml",
  clojure: "tree-sitter-clojure",
  swift: "tree-sitter-swift",
  nix: "tree-sitter-nix",
}

interface LanguageParser {
  language: SupportedLanguage
  parser: unknown
  loadedAt: number
}

export class TreeSitterBackgroundService implements IBackgroundService {
  name = "tree-sitter"
  priority = 30
  private status: ServiceStatus = "idle"
  private parsers: Map<SupportedLanguage, LanguageParser> = new Map()
  private loadPromises: Map<SupportedLanguage, Promise<void>> = new Map()
  private projectLanguages: Set<SupportedLanguage> = new Set()

  async start(): Promise<void> {
    log.info("starting tree-sitter service")

    const commonLanguages: SupportedLanguage[] = ["bash", "python", "javascript", "typescript"]

    for (const lang of commonLanguages) {
      this.preloadLanguage(lang).catch((err) => {
        log.warn("preload language failed", { lang, error: String(err) })
      })
    }

    this.status = "ready"
    log.info("tree-sitter service ready")
  }

  async stop(): Promise<void> {
    this.parsers.clear()
    this.loadPromises.clear()
    this.projectLanguages.clear()
    this.status = "idle"
    log.info("tree-sitter service stopped")
  }

  getStatus(): ServiceStatus {
    return this.status
  }

  isReady(): boolean {
    return this.status === "ready"
  }

  setProjectLanguages(languages: SupportedLanguage[]): void {
    for (const lang of languages) {
      if (!this.projectLanguages.has(lang)) {
        this.projectLanguages.add(lang)
        this.preloadLanguage(lang).catch((err) => {
          log.warn("load language failed", { lang, error: String(err) })
        })
      }
    }
  }

  async preloadLanguage(lang: SupportedLanguage): Promise<void> {
    if (this.parsers.has(lang)) {
      return
    }

    const existingPromise = this.loadPromises.get(lang)
    if (existingPromise) {
      return existingPromise
    }

    const loadPromise = this.loadLanguage(lang)
    this.loadPromises.set(lang, loadPromise)

    try {
      await loadPromise
    } finally {
      this.loadPromises.delete(lang)
    }
  }

  private async loadLanguage(lang: SupportedLanguage): Promise<void> {
    const packageName = LANGUAGE_PACKAGES[lang]
    const loader = ModuleLoader.getInstance()

    log.info("loading tree-sitter language", { lang, package: packageName })

    try {
      if (!loader.isInstalled(packageName)) {
        log.info("installing tree-sitter language", { lang, package: packageName })

        await loader.install({
          name: packageName,
          version: "latest",
          downloadUrls: {
            official: "https://registry.npmjs.org",
            china: "https://registry.npmmirror.com",
          },
          type: "wasm",
        })
      }

      this.parsers.set(lang, {
        language: lang,
        parser: null,
        loadedAt: Date.now(),
      })

      log.info("tree-sitter language loaded", { lang })
    } catch (error) {
      log.error("failed to load tree-sitter language", { lang, error: String(error) })
      throw error
    }
  }

  getParser(lang: SupportedLanguage): unknown {
    return this.parsers.get(lang)?.parser
  }

  isLanguageLoaded(lang: SupportedLanguage): boolean {
    return this.parsers.has(lang)
  }

  getLoadedLanguages(): SupportedLanguage[] {
    return Array.from(this.parsers.keys())
  }

  static inferLanguageFromExtension(ext: string): SupportedLanguage | null {
    const extMap: Record<string, SupportedLanguage> = {
      ts: "typescript",
      tsx: "typescript",
      js: "javascript",
      jsx: "javascript",
      mjs: "javascript",
      cjs: "javascript",
      py: "python",
      rs: "rust",
      go: "go",
      cpp: "cpp",
      cc: "cpp",
      cxx: "cpp",
      c: "c",
      h: "c",
      hpp: "cpp",
      cs: "csharp",
      sh: "bash",
      bash: "bash",
      zsh: "bash",
      java: "java",
      rb: "ruby",
      php: "php",
      scala: "scala",
      html: "html",
      htm: "html",
      json: "json",
      yaml: "yaml",
      yml: "yaml",
      hs: "haskell",
      css: "css",
      julia: "julia",
      ml: "ocaml",
      mli: "ocaml",
      clj: "clojure",
      cljs: "clojure",
      swift: "swift",
      nix: "nix",
    }

    return extMap[ext.toLowerCase()] || null
  }
}

export const treeSitterBackgroundService = new TreeSitterBackgroundService()

export function initTreeSitterBackgroundService(): void {
  const manager = BackgroundServiceManager.getInstance()
  manager.register(treeSitterBackgroundService)
}
