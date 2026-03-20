import fs from "node:fs/promises"
import path from "node:path"
import { Database, desc, eq } from "@/storage/db"
import { SessionTable } from "@/session/session.sql"
import { WorkspaceTable } from "@/control-plane/workspace.sql"
import { ProjectTable } from "@/project/project.sql"
import { LearningStore } from "@/ai/memory/learning-store"
import { ProjectMemory } from "@/ai/memory/project-memory"
import { Global } from "@/global"
import type { KnowledgeNode } from "@/ai/knowledge"
import type { SessionID } from "@/session/schema"
import type { ProjectID } from "@/project/schema"

export namespace WorkspaceIntelligence {
  const SEMANTIC_CONCEPTS: Record<string, string[]> = {
    auth: ["auth", "authentication", "authorize", "authorization", "signin", "signup", "login", "oauth", "token", "credential", "session"],
    frontend: ["frontend", "ui", "view", "screen", "component", "client"],
    backend: ["backend", "server", "service", "api", "endpoint", "handler"],
    bugfix: ["bug", "fix", "debug", "diagnostic", "incident", "regression", "failure"],
    testing: ["test", "testing", "spec", "assert", "verify", "validation"],
    performance: ["perf", "performance", "latency", "throughput", "optimize", "optimization"],
  }

  const CONCEPT_BY_TOKEN = buildConceptIndex(SEMANTIC_CONCEPTS)

  interface WorkspaceSignals {
    tokens: string[]
    languages: Set<string>
    frameworks: Set<string>
    dependencies: Set<string>
  }

  interface RenderOptions {
    sessionID: SessionID
    projectID: ProjectID
    rootDir: string
    maxWorkspaces?: number
    maxSessions?: number
  }

  export async function renderPromptContext(options: RenderOptions) {
    const currentSession = Database.use((db) =>
      db.select().from(SessionTable).where(eq(SessionTable.id, options.sessionID)).get(),
    )
    const workspaces = Database.use((db) =>
      db.select().from(WorkspaceTable).where(eq(WorkspaceTable.project_id, options.projectID)).all(),
    )
    const sessions = Database.use((db) =>
      db
        .select()
        .from(SessionTable)
        .where(eq(SessionTable.project_id, options.projectID))
        .orderBy(desc(SessionTable.time_updated), desc(SessionTable.id))
        .limit(20)
        .all(),
    ).filter((row) => row.id !== options.sessionID && row.time_archived == null)

    const sessionsByWorkspace = new Map<string, Array<typeof SessionTable.$inferSelect>>()
    for (const row of sessions) {
      if (!row.workspace_id) continue
      const list = sessionsByWorkspace.get(row.workspace_id) ?? []
      list.push(row)
      sessionsByWorkspace.set(row.workspace_id, list)
    }

    const workspaceMap = new Map(workspaces.map((workspace) => [workspace.id, workspace]))
    const currentWorkspace = currentSession?.workspace_id ? workspaceMap.get(currentSession.workspace_id) : undefined

    const currentDirectory = currentSession?.directory ?? options.rootDir
    const workspaceSignal = [
      currentSession?.title,
      currentDirectory,
      currentWorkspace?.name,
      currentWorkspace?.branch,
      currentWorkspace?.directory,
    ]
      .filter(Boolean)
      .join(" ")
    const signalTokens = tokenize(workspaceSignal)

    const currentSignals = await inferWorkspaceSignals(currentWorkspace?.directory ?? currentDirectory)

    const siblingCandidates = await Promise.all(
      workspaces
        .filter((workspace) => workspace.id !== currentWorkspace?.id)
        .map(async (workspace) => ({
          workspace,
          score: await scoreWorkspaceSimilarity({
            workspace,
            signalTokens,
            rootDir: options.rootDir,
            currentSignals,
            recentSessions: sessionsByWorkspace.get(workspace.id) ?? [],
          }),
        })),
    )

    const siblingWorkspaces = siblingCandidates
      .sort((a, b) => b.score - a.score)
      .filter((item) => item.score > 0)
      .slice(0, options.maxWorkspaces ?? 3)
      .map((item) => item.workspace)

    const relatedSessions = sessions
      .map((row) => ({
        row,
        score: scoreSessionSimilarity(row, signalTokens),
      }))
      .sort((a, b) => b.score - a.score)
      .slice(0, options.maxSessions ?? 4)
      .map((item) => item.row)

    const hasWorkspaceSignal =
      !!currentWorkspace || siblingWorkspaces.length > 0 || relatedSessions.length > 0 || currentDirectory !== options.rootDir
    if (!hasWorkspaceSignal) return undefined

    const lines = [
      "<workspace_context>",
      "Workspace and session topology for the current project. Use it to avoid mixing sandbox state, branch-specific assumptions, or stale parallel work.",
      `Project root: ${options.rootDir}`,
      `Current directory: ${currentDirectory}`,
    ]

    if (currentWorkspace) {
      lines.push(
        `Current workspace: ${describeWorkspace(currentWorkspace, options.rootDir)}`,
      )
    } else if (currentDirectory !== options.rootDir) {
      lines.push(`Current workspace: ad-hoc worktree (${relativeDirectory(currentDirectory, options.rootDir)})`)
    } else {
      lines.push("Current workspace: primary project root")
    }

    if (siblingWorkspaces.length > 0) {
      lines.push("Sibling workspaces:")
      for (const workspace of siblingWorkspaces) {
        lines.push(`- ${describeWorkspace(workspace, options.rootDir)}`)
      }
    }

    if (relatedSessions.length > 0) {
      lines.push("Recent related sessions:")
      for (const row of relatedSessions) {
        lines.push(`- ${describeSession(row, workspaceMap, options.rootDir)}`)
      }
    }

    // Cross-project experience: surface high-confidence patterns learned in other projects
    const otherProjects = Database.use((db) =>
      db
        .select({ id: ProjectTable.id })
        .from(ProjectTable)
        .limit(5)
        .all(),
    ).filter((p) => p.id !== options.projectID)

    if (otherProjects.length > 0) {
      const otherProjectIds = otherProjects.slice(0, 3).map((p) => p.id)
      const transferable = await LearningStore.getTransferCandidates({
        targetProjectID: options.projectID,
        sourceProjectIDs: otherProjectIds,
        rootDir: options.rootDir,
        limit: 6,
      })
      if (transferable.length > 0) {
        lines.push("Cross-project learned patterns:")
        for (const item of transferable) {
          lines.push(
            `- [${item.sourceProjectID.slice(0, 8)}] ${item.action} confidence=${item.confidence.toFixed(2)} success=${item.successRate.toFixed(2)} age=${Math.round(item.ageDays)}d${item.conditions.length ? ` (${item.conditions.slice(0, 2).join(", ")})` : ""}`,
          )
        }
      }

      const crossMemory = await crossProjectMemoryContext(otherProjectIds)
      if (crossMemory) lines.push(crossMemory)

      const crossKG = await crossProjectKGContext(otherProjectIds)
      if (crossKG) lines.push(crossKG)
    }

    lines.push("</workspace_context>")
    return lines.join("\n")
  }

  function describeWorkspace(
    workspace: typeof WorkspaceTable.$inferSelect,
    rootDir: string,
  ) {
    const label = workspace.name ?? workspace.branch ?? workspace.id
    const directory = workspace.directory ? relativeDirectory(workspace.directory, rootDir) : "no-directory"
    const branch = workspace.branch ? ` branch=${workspace.branch}` : ""
    return `${label} (${workspace.type}${branch}, dir=${directory})`
  }

  function describeSession(
    session: typeof SessionTable.$inferSelect,
    workspaceMap: Map<string, typeof WorkspaceTable.$inferSelect>,
    rootDir: string,
  ) {
    const workspace = session.workspace_id ? workspaceMap.get(session.workspace_id) : undefined
    const scope = workspace
      ? workspace.name ?? workspace.branch ?? workspace.id
      : session.directory === rootDir
        ? "primary"
        : relativeDirectory(session.directory, rootDir)
    return `${session.title} [${scope}] ${relativeDirectory(session.directory, rootDir)}`
  }

  function relativeDirectory(directory: string, rootDir: string) {
    if (!directory) return "."
    const relative = path.relative(rootDir, directory)
    return relative && relative !== "" ? relative : "."
  }

  async function crossProjectMemoryContext(otherProjectIds: string[]): Promise<string | undefined> {
    const sections: string[] = []
    for (const pid of otherProjectIds) {
      const ctx = await ProjectMemory.renderPromptContext(pid).catch(() => undefined)
      if (ctx) sections.push(ctx)
    }
    if (sections.length === 0) return undefined
    return `<cross_project_memory>\n${sections.join("\n---\n")}\n</cross_project_memory>`
  }

  async function crossProjectKGContext(otherProjectIds: string[]): Promise<string | undefined> {
    const kgDir = path.join(Global.Path.data, "knowledge-graph")
    const symbols: string[] = []
    for (const pid of otherProjectIds) {
      const file = path.join(kgDir, `${encodeURIComponent(pid)}.json`)
      const raw = await fs.readFile(file, "utf8").catch(() => undefined)
      if (!raw) continue
      try {
        const snapshot = JSON.parse(raw) as { nodes?: KnowledgeNode[] }
        const nodes = (snapshot.nodes ?? [])
          .filter((n) => n.type === "concept" || n.type === "entity" || n.type === "pattern")
          .slice(0, 10)
        for (const n of nodes) {
          symbols.push(`- [${pid.slice(0, 8)}] ${n.type}:${n.name}`)
        }
      } catch {
        // malformed backup — skip
      }
    }
    if (symbols.length === 0) return undefined
    return `<cross_project_symbols>\n${symbols.join("\n")}\n</cross_project_symbols>`
  }

  function tokenize(text: string) {
    return text
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9_\u4e00-\u9fff]+/g)
      .filter((token) => token.length > 1)
  }

  function overlapScore(signalTokens: string[], targetText: string) {
    if (signalTokens.length === 0 || !targetText) return 0
    const targetTokens = new Set(tokenize(targetText))
    if (targetTokens.size === 0) return 0

    let matches = 0
    for (const token of signalTokens) {
      if (targetTokens.has(token)) matches++
    }

    const lexicalScore = matches / Math.max(signalTokens.length, targetTokens.size)

    const signalConcepts = semanticConcepts(signalTokens)
    const targetConcepts = semanticConcepts(targetTokens)
    const conceptScore = setJaccardScore(signalConcepts, targetConcepts)

    return lexicalScore * 0.78 + conceptScore * 0.22
  }

  function buildConceptIndex(concepts: Record<string, string[]>) {
    const map = new Map<string, string>()
    for (const [concept, aliases] of Object.entries(concepts)) {
      for (const alias of aliases) {
        map.set(alias.toLowerCase(), concept)
      }
    }
    return map
  }

  function semanticConcepts(tokens: Iterable<string>) {
    const concepts = new Set<string>()
    for (const token of tokens) {
      const normalized = token.toLowerCase()
      const direct = CONCEPT_BY_TOKEN.get(normalized)
      if (direct) {
        concepts.add(direct)
        continue
      }
      for (const [alias, concept] of CONCEPT_BY_TOKEN.entries()) {
        if (normalized.includes(alias)) {
          concepts.add(concept)
          break
        }
      }
    }
    return concepts
  }

  function setJaccardScore(left: Set<string>, right: Set<string>) {
    if (left.size === 0 || right.size === 0) return 0
    let shared = 0
    for (const item of left) {
      if (right.has(item)) shared += 1
    }
    return shared / Math.max(1, left.size + right.size - shared)
  }

  async function scoreWorkspaceSimilarity(input: {
    workspace: typeof WorkspaceTable.$inferSelect
    signalTokens: string[]
    rootDir: string
    currentSignals: WorkspaceSignals
    recentSessions: Array<typeof SessionTable.$inferSelect>
  }) {
    const { workspace, signalTokens, rootDir, currentSignals, recentSessions } = input
    const text = [
      workspace.name,
      workspace.branch,
      workspace.directory ? relativeDirectory(workspace.directory, rootDir) : undefined,
      workspace.type,
    ]
      .filter(Boolean)
      .join(" ")

    const lexicalScore = overlapScore(signalTokens, text)

    const sessionTopicText = recentSessions
      .map((row) => [row.title, row.slug].filter(Boolean).join(" "))
      .join(" ")
    const sessionThemeScore = overlapScore(signalTokens, sessionTopicText)

    const candidateSignals = await inferWorkspaceSignals(workspace.directory ?? undefined)
    const profileText = [
      ...candidateSignals.tokens,
      ...candidateSignals.languages,
      ...candidateSignals.frameworks,
      ...candidateSignals.dependencies,
    ].join(" ")
    const signalProfileScore = overlapScore(signalTokens, profileText)

    const languageScore = setOverlapScore(currentSignals.languages, candidateSignals.languages)
    const frameworkScore = setOverlapScore(currentSignals.frameworks, candidateSignals.frameworks)
    const dependencyScore = setOverlapScore(currentSignals.dependencies, candidateSignals.dependencies)

    return (
      lexicalScore * 0.3 +
      sessionThemeScore * 0.25 +
      signalProfileScore * 0.15 +
      dependencyScore * 0.15 +
      frameworkScore * 0.1 +
      languageScore * 0.05
    )
  }

  function scoreSessionSimilarity(session: typeof SessionTable.$inferSelect, signalTokens: string[]) {
    const text = [session.title, session.slug, session.directory].filter(Boolean).join(" ")
    return overlapScore(signalTokens, text)
  }

  async function inferWorkspaceSignals(directory?: string): Promise<WorkspaceSignals> {
    if (!directory) {
      return {
        tokens: [],
        languages: new Set<string>(),
        frameworks: new Set<string>(),
        dependencies: new Set<string>(),
      }
    }

    const tokens = new Set<string>()
    const languages = new Set<string>()
    const frameworks = new Set<string>()
    const dependencies = new Set<string>()

    const addTokens = (value: string | undefined) => {
      if (!value) return
      for (const token of tokenize(value)) {
        tokens.add(token)
      }
    }

    addTokens(path.basename(directory))

    const packageJsonRaw = await fs.readFile(path.join(directory, "package.json"), "utf8").catch(() => undefined)
    if (packageJsonRaw) {
      languages.add("javascript")
      try {
        const parsed = JSON.parse(packageJsonRaw) as {
          name?: string
          dependencies?: Record<string, string>
          devDependencies?: Record<string, string>
        }
        addTokens(parsed.name)

        const depNames = Object.keys({ ...(parsed.dependencies ?? {}), ...(parsed.devDependencies ?? {}) }).slice(0, 60)
        for (const dep of depNames) {
          dependencies.add(dep)
          addTokens(dep)
          addFrameworkHint(dep, frameworks)
        }
      } catch {
        // Ignore malformed package.json files for ranking signals.
      }
    }

    const [hasTsConfig, hasGoMod, hasCargoToml, hasPyProject, hasRequirements] = await Promise.all([
      fileExists(path.join(directory, "tsconfig.json")),
      fileExists(path.join(directory, "go.mod")),
      fileExists(path.join(directory, "Cargo.toml")),
      fileExists(path.join(directory, "pyproject.toml")),
      fileExists(path.join(directory, "requirements.txt")),
    ])

    if (hasTsConfig) languages.add("typescript")
    if (hasGoMod) languages.add("go")
    if (hasCargoToml) languages.add("rust")
    if (hasPyProject || hasRequirements) languages.add("python")

    return {
      tokens: [...tokens],
      languages,
      frameworks,
      dependencies,
    }
  }

  function addFrameworkHint(dep: string, target: Set<string>) {
    const name = dep.toLowerCase()
    if (name.includes("react") || name.includes("next")) target.add("react")
    if (name.includes("vue") || name.includes("nuxt")) target.add("vue")
    if (name.includes("svelte")) target.add("svelte")
    if (name.includes("angular")) target.add("angular")
    if (name.includes("nestjs") || name.includes("express") || name.includes("fastify") || name.includes("koa")) {
      target.add("node-backend")
    }
    if (name.includes("django") || name.includes("flask") || name.includes("fastapi")) target.add("python-backend")
  }

  function setOverlapScore(left: Set<string>, right: Set<string>) {
    if (left.size === 0 || right.size === 0) return 0
    let shared = 0
    for (const item of left) {
      if (right.has(item)) shared += 1
    }
    return shared / Math.max(left.size, right.size)
  }

  async function fileExists(target: string) {
    return fs.access(target).then(() => true).catch(() => false)
  }
}