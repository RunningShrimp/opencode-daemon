import fs from "node:fs/promises"
import path from "node:path"
import { Instance } from "@/project/instance"
import { Log } from "@/util/log"
import { ProjectMemory } from "./project-memory"

const log = Log.create({ service: "project-memory.bootstrap" })
const IGNORE = new Set(["node_modules", ".git", "dist", "build", ".next", ".sst", "coverage"])

interface PackageShape {
  name?: string
  description?: string
  scripts?: Record<string, string>
  dependencies?: Record<string, string>
  devDependencies?: Record<string, string>
}

export async function bootstrapProjectMemory(input?: {
  projectID?: string
  rootDir?: string
  projectName?: string
  startCommand?: string
}) {
  const projectID = input?.projectID ?? Instance.project.id
  const rootDir = input?.rootDir ?? Instance.project.worktree
  const projectName = input?.projectName ?? Instance.project.name ?? path.basename(rootDir)
  const startCommand = input?.startCommand ?? Instance.project.commands?.start

  await ProjectMemory.upsert(projectID, {
    kind: "summary",
    text: `Project ${projectName} rooted at ${rootDir}`,
    confidence: 0.95,
    evidence: [rootDir],
    tags: ["project", "root"],
  })

  if (startCommand) {
    await ProjectMemory.upsert(projectID, {
      kind: "command",
      text: `Startup command: ${startCommand}`,
      confidence: 0.9,
      evidence: [rootDir],
      tags: ["command", "startup"],
    })
  }

  await ingestPackage(projectID, rootDir)
  await ingestDocs(projectID, rootDir)
}

export async function bootstrapProjectMemorySafe(input?: {
  projectID?: string
  rootDir?: string
  projectName?: string
  startCommand?: string
}) {
  await bootstrapProjectMemory(input).catch((error) => {
    log.warn("failed to bootstrap project memory", {
      projectID: input?.projectID ?? Instance.project?.id,
      rootDir: input?.rootDir ?? Instance.project?.worktree,
      error: String(error),
    })
  })
}

async function ingestPackage(projectID: string, rootDir: string) {
  const pkgPath = path.join(rootDir, "package.json")
  const content = await fs.readFile(pkgPath, "utf8").catch(() => undefined)
  if (!content) return
  const parsed = JSON.parse(content) as PackageShape

  if (parsed.name) {
    await ProjectMemory.upsert(projectID, {
      kind: "term",
      text: `Package name: ${parsed.name}`,
      confidence: 0.95,
      evidence: [pkgPath],
      tags: ["package", "name"],
    })
  }

  if (parsed.description) {
    await ProjectMemory.upsert(projectID, {
      kind: "summary",
      text: `Package summary: ${parsed.description}`,
      confidence: 0.8,
      evidence: [pkgPath],
      tags: ["package", "summary"],
    })
  }

  for (const [name, command] of Object.entries(parsed.scripts ?? {}).slice(0, 8)) {
    await ProjectMemory.upsert(projectID, {
      kind: "command",
      text: `Script ${name}: ${command}`,
      confidence: 0.85,
      evidence: [pkgPath],
      tags: ["script", name],
    })
  }

  for (const name of Object.keys({ ...(parsed.dependencies ?? {}), ...(parsed.devDependencies ?? {}) }).slice(0, 16)) {
    await ProjectMemory.upsert(projectID, {
      kind: "term",
      text: `Dependency: ${name}`,
      confidence: 0.7,
      evidence: [pkgPath],
      tags: ["dependency", name],
    })
  }
}

async function ingestDocs(projectID: string, rootDir: string) {
  const docs = await collectMarkdown(rootDir)
  for (const file of docs.slice(0, 12)) {
    const content = await fs.readFile(file, "utf8").catch(() => undefined)
    if (!content) continue
    const rel = path.relative(rootDir, file)
    const headings = extractHeadings(content)
    if (headings.length === 0) continue

    await ProjectMemory.upsert(projectID, {
      kind: "summary",
      text: `${rel}: ${headings[0]}`,
      confidence: 0.75,
      evidence: [rel],
      tags: ["doc", path.basename(rel)],
    })

    for (const heading of headings.slice(1, 4)) {
      await ProjectMemory.upsert(projectID, {
        kind: "term",
        text: `Doc heading: ${heading}`,
        confidence: 0.65,
        evidence: [rel],
        tags: ["doc", "heading"],
      })
    }
  }
}

async function collectMarkdown(rootDir: string) {
  const result: string[] = []

  async function walk(dir: string): Promise<void> {
    const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (IGNORE.has(entry.name)) continue
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (/\.(md|mdx)$/i.test(entry.name)) {
        result.push(full)
      }
    }
  }

  await walk(rootDir)
  return result.sort((a, b) => a.localeCompare(b))
}

function extractHeadings(content: string) {
  return content
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => /^#{1,3}\s+/.test(line))
    .map((line) => line.replace(/^#{1,3}\s+/, ""))
    .slice(0, 5)
}