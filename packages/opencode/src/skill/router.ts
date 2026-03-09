import z from "zod"
import path from "path"
import os from "os"
import { mkdir } from "fs/promises"
import { URL } from "url"
import { Config } from "../config/config"
import { Instance } from "../project/instance"
import { NamedError } from "@opencode-ai/util/error"
import { ConfigMarkdown } from "../config/markdown"
import { Log } from "../util/log"
import { Global } from "@/global"
import { Filesystem } from "@/util/filesystem"
import { Flag } from "@/flag/flag"
import { Bus } from "@/bus"
import { Session } from "@/session"
import { Glob } from "../util/glob"
import { ConcurrencyLimiter } from "../util/concurrency-limiter"

export namespace Skill {
  const log = Log.create({ service: "skill" })

  export const Info = z.object({
    name: z.string(),
    description: z.string(),
    location: z.string(),
    content: z.string(),
  })
  export type Info = z.infer<typeof Info>

  export const InvalidError = NamedError.create(
    "SkillInvalidError",
    z.object({
      path: z.string(),
      message: z.string().optional(),
      issues: z.custom<z.core.$ZodIssue[]>().optional(),
    }),
  )

  export const NameMismatchError = NamedError.create(
    "SkillNameMismatchError",
    z.object({
      path: z.string(),
      expected: z.string(),
      actual: z.string(),
    }),
  )

  // ============================================================================
  // SkillsRouter - 统一的 Skill 路由系统（多实例优化版）
  // ============================================================================

  export interface SkillProvider {
    readonly name: string
    readonly priority: number
    scan(signal?: AbortSignal): Promise<SkillInfo[]>
  }

  export interface SkillInfo {
    name: string
    description: string
    location: string
    content: string
    provider: string
  }

  export interface RouterConfig {
    concurrency?: number
    timeout?: number
    cacheTTL?: number
    cacheMax?: number
  }

  /**
   * 实例感知的 SkillsRouter
   * 每个项目实例有独立的 Router，避免全局状态污染
   */
  export class SkillsRouter {
    private providers: SkillProvider[] = []
    private cache = new Map<string, { data: SkillInfo; expires: number }>()
    private loading: Promise<SkillInfo[]> | null = null
    private initialized = false
    private config: Required<RouterConfig>

    constructor(config: RouterConfig = {}) {
      this.config = {
        concurrency: config.concurrency ?? 5,
        timeout: config.timeout ?? 30000,
        cacheTTL: config.cacheTTL ?? 5 * 60 * 1000,
        cacheMax: config.cacheMax ?? 100,
      }
    }

    register(provider: SkillProvider): void {
      this.providers.push(provider)
      this.providers.sort((a, b) => b.priority - a.priority)
      this.invalidate()
    }

    /**
     * 初始化 Providers（按实例配置）
     * 只调用一次，后续复用
     */
    async initialize(): Promise<void> {
      if (this.initialized) return
      this.initialized = true

      if (Flag.OPENCODE_DISABLE_EXTERNAL_SKILLS) return

      const config = await Config.get()

      // 本地 Providers（项目级和全局）
      const homeRoots = [".claude", ".agents"].map((dir) => path.join(Global.Path.home, dir))

      const projectRoots: string[] = []
      for await (const root of Filesystem.up({
        targets: [".claude", ".agents"],
        start: Instance.directory,
        stop: Instance.worktree,
      })) {
        projectRoots.push(root)
      }

      // 合并全局和项目级，去重
      const uniqueRoots = [...new Set([...homeRoots, ...projectRoots])].filter(
        async (root) => await Filesystem.isDir(root),
      )

      if (uniqueRoots.length > 0) {
        this.register(new LocalSkillProvider(uniqueRoots, "skills/**/SKILL.md"))
      }

      // Opencode Providers
      const opencodeDirs = await Config.directories()
      if (opencodeDirs.length > 0) {
        this.register(new OpencodeSkillProvider(opencodeDirs))
      }

      // 配置路径 Providers
      if (config.skills?.paths && config.skills.paths.length > 0) {
        this.register(new ConfigPathSkillProvider(config.skills.paths))
      }

      // 远程 Providers
      if (config.skills?.urls && config.skills.urls.length > 0) {
        this.register(new RemoteSkillProvider(config.skills.urls))
      }
    }

    invalidate(): void {
      this.cache.clear()
      this.loading = null
    }

    async get(name: string, signal?: AbortSignal): Promise<SkillInfo | undefined> {
      await this.initialize()

      const cached = this.cache.get(name)
      if (cached && cached.expires > Date.now()) {
        return cached.data
      }

      const all = await this.all(signal)
      const found = all.find((s) => s.name === name)
      if (found) {
        this.setCache(name, found)
      }
      return found
    }

    async all(signal?: AbortSignal): Promise<SkillInfo[]> {
      await this.initialize()

      if (this.loading) {
        return this.loading
      }

      this.loading = this.loadAll(signal)
      try {
        return await this.loading
      } catch (error) {
        this.loading = null
        throw error
      }
    }

    private async loadAll(signal?: AbortSignal): Promise<SkillInfo[]> {
      const limiter = new ConcurrencyLimiter(this.config.concurrency)
      const controller = new AbortController()

      if (signal) {
        signal.addEventListener("abort", () => controller.abort())
      }

      const scanProvider = async (provider: SkillProvider): Promise<SkillInfo[]> => {
        try {
          const timeoutPromise = new Promise<SkillInfo[]>((_, reject) => {
            setTimeout(() => reject(new Error(`Provider ${provider.name} timeout`)), this.config.timeout)
          })
          const result = await Promise.race([provider.scan(controller.signal), timeoutPromise])
          return result.map((s) => ({ ...s, provider: provider.name }))
        } catch (error) {
          log.error(`provider ${provider.name} failed`, { error })
          return []
        }
      }

      const results = await Promise.all(this.providers.map((provider) => limiter.run(() => scanProvider(provider))))

      const skillsMap = new Map<string, SkillInfo>()

      for (const providerResults of results) {
        for (const skill of providerResults) {
          if (!skillsMap.has(skill.name)) {
            skillsMap.set(skill.name, skill)
          } else {
            log.warn("duplicate skill overridden", {
              name: skill.name,
              existing: skillsMap.get(skill.name)?.provider,
              new: skill.provider,
            })
            skillsMap.set(skill.name, skill)
          }
        }
      }

      const skills = Array.from(skillsMap.values())

      for (const skill of skills) {
        this.setCache(skill.name, skill)
      }

      return skills
    }

    private setCache(name: string, data: SkillInfo): void {
      if (this.cache.size >= this.config.cacheMax) {
        // LRU: 删除最早的条目
        const firstKey = this.cache.keys().next().value
        if (firstKey) this.cache.delete(firstKey)
      }
      this.cache.set(name, { data, expires: Date.now() + this.config.cacheTTL })
    }

    /** 获取 Provider 列表（用于调试） */
    getProviders(): SkillProvider[] {
      return [...this.providers]
    }
  }

  // ============================================================================
  // 内置 Provider 实现
  // ============================================================================

  const OPENCODE_SKILL_PATTERN = "{skill,skills}/**/SKILL.md"
  const SKILL_PATTERN = "**/SKILL.md"

  export class LocalSkillProvider implements SkillProvider {
    readonly name = "local"
    readonly priority = 10

    constructor(
      private roots: string[],
      private pattern: string,
    ) {}

    async scan(signal?: AbortSignal): Promise<SkillInfo[]> {
      const results: SkillInfo[] = []
      const limiter = new ConcurrencyLimiter(5)

      const scanDir = async (root: string) => {
        if (!(await Filesystem.isDir(root))) return

        const matches = await Glob.scan(this.pattern, {
          cwd: root,
          absolute: true,
          include: "file",
          dot: true,
          symlink: true,
        })

        const processMatch = async (match: string) => {
          if (signal?.aborted) return
          const skill = await this.parseSkill(match)
          if (skill) results.push(skill)
        }

        await Promise.all(matches.map((match) => limiter.run(() => processMatch(match))))
      }

      await Promise.all(this.roots.map(scanDir))
      return results
    }

    private async parseSkill(match: string): Promise<SkillInfo | undefined> {
      const md = await ConfigMarkdown.parse(match).catch((err) => {
        const message = ConfigMarkdown.FrontmatterError.isInstance(err)
          ? err.data.message
          : `Failed to parse skill ${match}`
        Bus.publish(Session.Event.Error, { error: new NamedError.Unknown({ message }).toObject() })
        log.error("failed to load skill", { skill: match, err })
        return undefined
      })

      if (!md) return

      const parsed = z.object({ name: z.string(), description: z.string() }).safeParse(md.data)

      if (!parsed.success) {
        log.warn("skill parse failed", { skill: match, issues: parsed.error.issues })
        return undefined
      }

      return {
        name: parsed.data.name,
        description: parsed.data.description,
        location: match,
        content: md.content,
        provider: this.name,
      }
    }
  }

  export class OpencodeSkillProvider implements SkillProvider {
    readonly name = "opencode"
    readonly priority = 20

    constructor(private directories: string[]) {}

    async scan(signal?: AbortSignal): Promise<SkillInfo[]> {
      const results: SkillInfo[] = []

      for (const dir of this.directories) {
        if (signal?.aborted) break

        const matches = await Glob.scan(OPENCODE_SKILL_PATTERN, {
          cwd: dir,
          absolute: true,
          include: "file",
          symlink: true,
        })

        for (const match of matches) {
          if (signal?.aborted) break
          const skill = await this.parseSkill(match)
          if (skill) results.push(skill)
        }
      }

      return results
    }

    private async parseSkill(match: string): Promise<SkillInfo | undefined> {
      const md = await ConfigMarkdown.parse(match).catch((err) => {
        log.error("failed to load skill", { skill: match, err })
        return undefined
      })

      if (!md) return

      const parsed = z.object({ name: z.string(), description: z.string() }).safeParse(md.data)

      if (!parsed.success) {
        log.warn("skill parse failed", { skill: match, issues: parsed.error.issues })
        return undefined
      }

      return {
        name: parsed.data.name,
        description: parsed.data.description,
        location: match,
        content: md.content,
        provider: this.name,
      }
    }
  }

  export class ConfigPathSkillProvider implements SkillProvider {
    readonly name = "config-path"
    readonly priority = 15

    constructor(private paths: string[]) {}

    async scan(signal?: AbortSignal): Promise<SkillInfo[]> {
      const results: SkillInfo[] = []

      for (const skillPath of this.paths) {
        if (signal?.aborted) break

        const expanded = skillPath.startsWith("~/") ? path.join(os.homedir(), skillPath.slice(2)) : skillPath

        const resolved = path.isAbsolute(expanded) ? expanded : path.join(Instance.directory, expanded)

        if (!(await Filesystem.isDir(resolved))) {
          log.warn("skill path not found", { path: resolved })
          continue
        }

        const matches = await Glob.scan(SKILL_PATTERN, {
          cwd: resolved,
          absolute: true,
          include: "file",
          symlink: true,
        })

        for (const match of matches) {
          if (signal?.aborted) break
          const skill = await this.parseSkill(match)
          if (skill) results.push(skill)
        }
      }

      return results
    }

    private async parseSkill(match: string): Promise<SkillInfo | undefined> {
      const md = await ConfigMarkdown.parse(match).catch((err) => {
        log.error("failed to load skill", { skill: match, err })
        return undefined
      })

      if (!md) return

      const parsed = z.object({ name: z.string(), description: z.string() }).safeParse(md.data)

      if (!parsed.success) {
        log.warn("skill parse failed", { skill: match, issues: parsed.error.issues })
        return undefined
      }

      return {
        name: parsed.data.name,
        description: parsed.data.description,
        location: match,
        content: md.content,
        provider: this.name,
      }
    }
  }

  export class RemoteSkillProvider implements SkillProvider {
    readonly name = "remote"
    readonly priority = 5
    private cacheDir: string

    constructor(private urls: string[]) {
      this.cacheDir = path.join(Global.Path.cache, "skills")
    }

    async scan(signal?: AbortSignal): Promise<SkillInfo[]> {
      const results: SkillInfo[] = []
      const limiter = new ConcurrencyLimiter(3)

      const fetchAndProcessUrl = async (url: string) => {
        if (signal?.aborted) return

        try {
          const dirs = await this.pull(url, signal)
          for (const dir of dirs) {
            if (signal?.aborted) break

            const matches = await Glob.scan(SKILL_PATTERN, {
              cwd: dir,
              absolute: true,
              include: "file",
              symlink: true,
            })

            for (const match of matches) {
              if (signal?.aborted) break
              const skill = await this.parseSkill(match)
              if (skill) results.push(skill)
            }
          }
        } catch (error) {
          log.error("failed to fetch remote skills", { url, error })
        }
      }

      await Promise.all(this.urls.map((url) => limiter.run(() => fetchAndProcessUrl(url))))
      return results
    }

    private async pull(url: string, signal?: AbortSignal): Promise<string[]> {
      const result: string[] = []
      const base = url.endsWith("/") ? url : `${url}/`
      const index = new URL("index.json", base).href

      const data = await fetch(index)
        .then(async (response) => {
          if (!response.ok) {
            log.error("failed to fetch index", { url: index, status: response.status })
            return undefined
          }
          return response.json().catch((err) => {
            log.error("failed to parse index", { url: index, err })
            return undefined
          })
        })
        .catch((err) => {
          log.error("failed to fetch index", { url: index, err })
          return undefined
        })

      if (!data?.skills || !Array.isArray(data.skills)) {
        return result
      }

      const list = data.skills.filter(
        (skill: { name?: string; files?: unknown[] }) => skill?.name && Array.isArray(skill.files),
      )

      const limiter = new ConcurrencyLimiter(3)

      const processSkill = async (skill: { name: string; files: string[] }) => {
        if (signal?.aborted) return

        const root = path.join(this.cacheDir, skill.name)

        // 限制文件下载并发
        const downloadFile = async (file: string) => {
          if (signal?.aborted) return

          const link = new URL(file, `${base}${skill.name}/`).href
          const dest = path.join(root, file)
          await mkdir(path.dirname(dest), { recursive: true })
          await this.download(link, dest, signal)
        }

        await Promise.all(skill.files.map(downloadFile))

        const md = path.join(root, "SKILL.md")
        if (await Filesystem.exists(md)) {
          result.push(root)
        }
      }

      await Promise.all(list.map((skill: { name: string; files: string[] }) => limiter.run(() => processSkill(skill))))

      return result
    }

    private async download(url: string, dest: string, _signal?: AbortSignal): Promise<boolean> {
      if (await Filesystem.exists(dest)) return true

      return fetch(url)
        .then(async (response) => {
          if (!response.ok) {
            log.error("failed to download", { url, status: response.status })
            return false
          }
          if (response.body) await Filesystem.writeStream(dest, response.body)
          return true
        })
        .catch((err) => {
          log.error("failed to download", { url, err })
          return false
        })
    }

    private async parseSkill(match: string): Promise<SkillInfo | undefined> {
      const md = await ConfigMarkdown.parse(match).catch((err) => {
        log.error("failed to load skill", { skill: match, err })
        return undefined
      })

      if (!md) return

      const parsed = z.object({ name: z.string(), description: z.string() }).safeParse(md.data)

      if (!parsed.success) {
        log.warn("skill parse failed", { skill: match, issues: parsed.error.issues })
        return undefined
      }

      return {
        name: parsed.data.name,
        description: parsed.data.description,
        location: match,
        content: md.content,
        provider: this.name,
      }
    }
  }

  // ============================================================================
  // 兼容层 - 保持原有 API（使用实例级 Router）
  // ============================================================================

  /**
   * 创建实例级的 Router
   * 每个项目实例有独立的 Router，确保缓存和状态隔离
   */
  const createInstanceRouter = () =>
    new SkillsRouter({
      concurrency: 5,
      timeout: 30000,
      cacheTTL: 5 * 60 * 1000,
      cacheMax: 100,
    })

  /**
   * 实例级 Router（通过 Instance.state() 确保每个实例独立）
   */
  const routerState = Instance.state(async () => {
    const router = createInstanceRouter()
    await router.initialize()
    return router
  })

  /**
   * 获取当前实例的 Router
   */
  async function getRouterInstance(): Promise<SkillsRouter> {
    return routerState()
  }

  /**
   * 导出 state（兼容原有 API）
   * 每个实例有独立的状态，按 Instance.directory 隔离
   */
  export const state = Instance.state(async () => {
    const router = await getRouterInstance()
    const skills = await router.all()
    const dirs = new Set<string>()

    for (const skill of skills) {
      dirs.add(path.dirname(skill.location))
    }

    return {
      skills: Object.fromEntries(skills.map((s) => [s.name, s])),
      dirs: Array.from(dirs),
    }
  })

  export async function get(name: string) {
    return state().then((x) => x.skills[name])
  }

  export async function all() {
    return state().then((x) => Object.values(x.skills))
  }

  export async function dirs() {
    return state().then((x) => x.dirs)
  }

  /**
   * 刷新当前实例的缓存
   */
  export async function refresh(): Promise<void> {
    const router = await getRouterInstance()
    router.invalidate()
  }

  /**
   * 获取 Router 实例（用于高级操作）
   */
  export async function getRouter(): Promise<SkillsRouter> {
    return getRouterInstance()
  }

  /**
   * 获取已注册的 Providers（用于调试）
   */
  export async function getProviders(): Promise<SkillProvider[]> {
    const router = await getRouterInstance()
    return router.getProviders()
  }
}
