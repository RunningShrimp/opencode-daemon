import fs from "node:fs/promises"
import path from "node:path"
import { Instance } from "@/project/instance"
import type { ContextualLearning } from "@/ai/thinking/experience-learning"

const IGNORE = new Set(["node_modules", ".git", "dist", "build", ".next", ".sst", "coverage"])
const cache = new Map<string, Omit<ContextualLearning, "taskType" | "complexity">>()

interface PackageShape {
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

export async function inferLearningContext(input?: {
  projectID?: string
  rootDir?: string
  taskType?: string
  complexity?: ContextualLearning["complexity"]
}): Promise<ContextualLearning> {
  const projectID = input?.projectID ?? Instance.project.id
  const rootDir = input?.rootDir ?? Instance.project.worktree
  const base = cache.get(projectID) ?? (await detectProjectSignals(rootDir))
  cache.set(projectID, base)
  return {
    ...base,
    taskType: input?.taskType,
    complexity: input?.complexity,
  }
}

export function resetLearningContextCache() {
  cache.clear()
}

async function detectProjectSignals(rootDir: string): Promise<Omit<ContextualLearning, "taskType" | "complexity">> {
  const deps = await readDependencies(rootDir)
  const framework = detectFramework(deps)
  const language = await detectLanguage(rootDir)
  const projectType = detectProjectType({ framework, rootDir, deps })
  return {
    projectType,
    language,
    framework,
  }
}

async function readDependencies(rootDir: string) {
  const pkg = await fs.readFile(path.join(rootDir, "package.json"), "utf8").catch(() => undefined)
  if (!pkg) return new Set<string>()
  const parsed = JSON.parse(pkg) as PackageShape
  return new Set(Object.keys({ ...(parsed.dependencies ?? {}), ...(parsed.devDependencies ?? {}) }))
}

function detectFramework(deps: Set<string>) {
  if (deps.has("next")) return "nextjs"
  if (deps.has("react")) return "react"
  if (deps.has("vue")) return "vue"
  if (deps.has("svelte")) return "svelte"
  if (deps.has("solid-js")) return "solid"
  if (deps.has("electron")) return "electron"
  if (deps.has("@tauri-apps/api")) return "tauri"
  if (deps.has("astro")) return "astro"
  if (deps.has("sst")) return "sst"
  if (deps.has("hono")) return "hono"
  return undefined
}

async function detectLanguage(rootDir: string) {
  const counts = new Map<string, number>()

  await walk(rootDir, async (file) => {
    const ext = path.extname(file).toLowerCase()
    const language =
      ext === ".ts" || ext === ".tsx"
        ? "typescript"
        : ext === ".js" || ext === ".jsx"
          ? "javascript"
          : ext === ".py"
            ? "python"
            : ext === ".rs"
              ? "rust"
              : ext === ".go"
                ? "go"
                : ext === ".java"
                  ? "java"
                  : ext === ".swift"
                    ? "swift"
                    : ext === ".kt"
                      ? "kotlin"
                      : undefined
    if (!language) return
    counts.set(language, (counts.get(language) ?? 0) + 1)
  })

  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0]
}

function detectProjectType(input: { framework?: string; rootDir: string; deps: Set<string> }) {
  const base = path.basename(input.rootDir).toLowerCase()
  if (input.framework === "electron" || input.framework === "tauri" || /desktop/.test(base)) return "desktop-app"
  if (["nextjs", "react", "vue", "svelte", "solid", "astro"].includes(input.framework ?? "")) return "web-app"
  if (input.deps.has("vitest") || input.deps.has("typescript") || /sdk|lib|core|util/.test(base)) return "library"
  return "application"
}

async function walk(rootDir: string, visit: (file: string) => Promise<void>) {
  let visited = 0

  async function recur(dir: string): Promise<void> {
    if (visited >= 120) return
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (visited >= 120) return
      if (IGNORE.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await recur(full)
        continue
      }
      visited += 1
      await visit(full)
    }
  }

  await recur(rootDir)
}