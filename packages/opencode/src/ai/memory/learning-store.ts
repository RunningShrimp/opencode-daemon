import { Storage } from "@/storage/storage"
import { Log } from "@/util/log"
import { ExperienceLearning, type ContextualLearning, type ExperienceLearningSnapshot } from "@/ai/thinking/experience-learning"
import { ProceduralMemory, type ProceduralMemorySnapshot } from "./procedural-memory"
import { inferLearningContext } from "./learning-context"

const log = Log.create({ service: "learning-store" })

export interface LearningTaskContext extends ContextualLearning {
  projectID: string
  rootDir?: string
}

export interface CrossProjectTransferCandidate {
  sourceProjectID: string
  action: string
  successRate: number
  frequency: number
  confidence: number
  ageDays: number
  conditions: string[]
}

interface LearningSnapshot {
  version: 1
  projectID: string
  experience: ExperienceLearningSnapshot
  procedural: ProceduralMemorySnapshot
  updatedAt: number
}

const cache = new Map<string, { experience: ExperienceLearning; procedural: ProceduralMemory; loaded: boolean }>()

export namespace LearningStore {
  const LANGUAGE_ALIASES: Record<string, string[]> = {
    typescript: ["typescript", "ts", "tsx"],
    javascript: ["javascript", "js", "jsx", "node"],
    python: ["python", "py"],
    rust: ["rust", "rs"],
    go: ["go", "golang"],
    java: ["java", "jvm"],
    swift: ["swift"],
    kotlin: ["kotlin", "kt"],
  }

  const FRAMEWORK_ALIASES: Record<string, string[]> = {
    react: ["react", "next", "nextjs"],
    vue: ["vue", "nuxt"],
    svelte: ["svelte", "sveltekit"],
    angular: ["angular"],
    django: ["django"],
    flask: ["flask"],
    fastapi: ["fastapi"],
    nestjs: ["nestjs", "nest"],
    express: ["express"],
    electron: ["electron"],
    tauri: ["tauri"],
  }

  const TASK_ALIASES: Record<string, string[]> = {
    implementation: ["implementation", "implement", "feature", "build", "patch"],
    debugging: ["debugging", "debug", "fix", "incident", "regression", "diagnostic"],
    testing: ["testing", "test", "spec", "assert", "verify", "validation"],
    refactor: ["refactor", "cleanup", "restructure", "rewrite"],
  }

  function key(projectID: string) {
    return ["learning", projectID]
  }

  async function load(projectID: string) {
    let state = cache.get(projectID)
    if (!state) {
      state = { experience: new ExperienceLearning(), procedural: new ProceduralMemory(), loaded: false }
      cache.set(projectID, state)
    }
    if (!state.loaded) {
      const snapshot = await Storage.read<LearningSnapshot>(key(projectID)).catch(() => undefined)
      if (snapshot) {
        state.experience.restore(snapshot.experience)
        state.procedural.restore(snapshot.procedural)
      }
      state.loaded = true
    }
    return state
  }

  async function persist(projectID: string) {
    const state = await load(projectID)
    const snapshot: LearningSnapshot = {
      version: 1,
      projectID,
      experience: state.experience.snapshot(),
      procedural: state.procedural.snapshot(),
      updatedAt: Date.now(),
    }
    await Storage.write(key(projectID), snapshot).catch((error) => {
      log.warn("failed to persist learning store", { projectID, error: String(error) })
    })
  }

  export async function startTask(input: LearningTaskContext, tags: string[] = []) {
    const context = await resolveContext(input)
    const state = await load(input.projectID)
    state.procedural.startTrajectory(context.taskType ?? "general", [...new Set([...tags, ...contextTags(context)])])
    await persist(input.projectID)
  }

  export async function recordToolExecution(input: {
    projectID: string
    rootDir?: string
    taskType: string
    tool: string
    success: boolean
    description: string
    output?: string
    duration: number
    context?: Record<string, unknown>
    projectType?: string
    language?: string
    framework?: string
    complexity?: ContextualLearning["complexity"]
  }) {
    const learningContext = await resolveContext({
      projectID: input.projectID,
      rootDir: input.rootDir,
      taskType: input.taskType,
      projectType: input.projectType,
      language: input.language,
      framework: input.framework,
      complexity: input.complexity,
    })
    const state = await load(input.projectID)
    state.procedural.addStep(input.description, input.tool, input.context, input.output, input.success, input.duration)
    state.experience.recordExperience({
      situation: `${input.taskType}:${input.tool}`,
      action: input.description,
      outcome: input.output?.slice(0, 200) ?? (input.success ? "success" : "failure"),
      context: { ...learningContext, tool: input.tool, ...(input.context ?? {}) },
      success: input.success,
      tags: [...new Set([input.taskType, input.tool, ...contextTags(learningContext)])],
      lessons: input.success ? [`${input.tool} worked for ${input.taskType}`] : [`${input.tool} failed for ${input.taskType}`],
      applicableTo: [...new Set([input.taskType, input.tool, ...contextTags(learningContext)])],
    })
    await persist(input.projectID)
  }

  export async function finishTask(projectID: string, success: boolean) {
    const state = await load(projectID)
    state.procedural.endTrajectory(success)
    await persist(projectID)
  }

  /**
   * Evict stale patterns: remove experience entries whose success rate has
   * fallen below 0.3 and that have not been referenced in the last 30 days.
   * Called automatically during persist to bound unbounded growth.
   */
  export async function evictStalePatterns(projectID: string): Promise<number> {
    const state = await load(projectID)
    const pruned = state.experience.evictByTimeAndRate(0.3, 30)
    if (pruned > 0) {
      await persist(projectID)
      log.info("evicted stale learning patterns", { projectID, pruned })
    }
    return pruned
  }

  export async function renderPromptContext(input: LearningTaskContext) {
    const context = await resolveContext(input)
    const state = await load(input.projectID)
    const patterns = state.experience.getRelevantPatterns(context).slice(0, 3)
    const insights = state.experience.getApplicableInsights(context).slice(0, 3)
    const workflow = state.procedural.getWorkflowPatterns(context.taskType).slice(0, 2)
    if (patterns.length === 0 && workflow.length === 0 && insights.length === 0) return undefined
    const lines = ["<learned_strategies>"]
    lines.push(
      `Context: ${[
        context.projectType ? `project=${context.projectType}` : undefined,
        context.language ? `language=${context.language}` : undefined,
        context.framework ? `framework=${context.framework}` : undefined,
        context.taskType ? `task=${context.taskType}` : undefined,
        context.complexity ? `complexity=${context.complexity}` : undefined,
      ]
        .filter(Boolean)
        .join(", ")}`,
    )
    for (const pattern of patterns)
      lines.push(`- pattern ${pattern.action} success=${pattern.successRate.toFixed(2)} conditions=${pattern.conditions.join(",") || "general"}`)
    for (const insight of insights) lines.push(`- insight ${insight.action} => ${insight.outcome.slice(0, 120)}`)
    for (const item of workflow) lines.push(`- workflow ${item.description} success=${item.successRate.toFixed(2)}`)
    lines.push("</learned_strategies>")
    return lines.join("\n")
  }

  export function resetForTest() {
    cache.clear()
  }

  /**
   * Return the top high-confidence patterns for a project.
   * Used by cross-project knowledge seeding.
   */
  export async function getTopPatterns(
    projectID: string,
    limit = 5,
  ): Promise<Array<{ action: string; successRate: number; conditions: string[] }>> {
    const state = await load(projectID)
    return state.experience
      .getRelevantPatterns({})
      .filter((p) => p.successRate >= 0.65)
      .slice(0, limit)
      .map((p) => ({ action: p.action, successRate: p.successRate, conditions: p.conditions }))
  }

  /**
   * Cross-project transfer candidates with admission + decay rules.
   *
   * Admission rules:
   * - successRate must remain high enough.
   * - hard context conflicts (task/lang/framework/project/complexity) are rejected.
   *
   * Decay rules:
   * - confidence decays with age, context specificity, and contextual fit.
   */
  export async function getTransferCandidates(input: {
    targetProjectID: string
    sourceProjectIDs: string[]
    rootDir?: string
    taskType?: string
    complexity?: ContextualLearning["complexity"]
    limit?: number
    minConfidence?: number
    maxAgeDays?: number
    now?: number
  }): Promise<CrossProjectTransferCandidate[]> {
    const minConfidence = input.minConfidence ?? 0.55
    const maxAgeDays = input.maxAgeDays ?? 90
    const now = input.now ?? Date.now()
    const targetContext = await resolveContext({
      projectID: input.targetProjectID,
      rootDir: input.rootDir,
      taskType: input.taskType,
      complexity: input.complexity,
    })

    const candidates: CrossProjectTransferCandidate[] = []
    for (const sourceProjectID of input.sourceProjectIDs) {
      if (!sourceProjectID || sourceProjectID === input.targetProjectID) continue
      const state = await load(sourceProjectID)
      const patterns = state.experience.getPatterns()
      for (const pattern of patterns) {
        const scored = scoreTransferCandidate(pattern, targetContext, {
          minConfidence,
          maxAgeDays,
          now,
        })
        if (!scored) continue
        candidates.push({
          sourceProjectID,
          action: pattern.action,
          successRate: pattern.successRate,
          frequency: pattern.frequency,
          confidence: scored.confidence,
          ageDays: scored.ageDays,
          conditions: pattern.conditions,
        })
      }
    }

    return candidates
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, input.limit ?? 6)
  }

  async function resolveContext(input: LearningTaskContext): Promise<ContextualLearning> {
    const inferred = await inferLearningContext({
      projectID: input.projectID,
      rootDir: input.rootDir,
      taskType: input.taskType,
      complexity: input.complexity,
    })
    return {
      ...inferred,
      ...input,
    }
  }

  function contextTags(context: ContextualLearning) {
    return [context.projectType, context.language, context.framework, context.taskType, context.complexity]
      .filter(Boolean)
      .map((item) => String(item))
  }

  function parseCondition(condition: string): { key: string; value: string } | undefined {
    const index = condition.indexOf(":")
    if (index <= 0 || index === condition.length - 1) return undefined
    return {
      key: condition.slice(0, index),
      value: condition.slice(index + 1),
    }
  }

  function targetValueByKey(context: ContextualLearning, key: string) {
    switch (key) {
      case "task":
        return context.taskType
      case "lang":
        return context.language
      case "fw":
        return context.framework
      case "pt":
        return context.projectType
      case "cx":
        return context.complexity
      default:
        return undefined
    }
  }

  function scoreTransferCandidate(
    pattern: {
      successRate: number
      frequency: number
      lastUsed: number
      conditions: string[]
      action: string
      trigger: string
      context: string[]
    },
    target: ContextualLearning,
    options: { minConfidence: number; maxAgeDays: number; now: number },
  ): { confidence: number; ageDays: number } | undefined {
    if (pattern.successRate < 0.7 || pattern.frequency < 3) return undefined

    const ageDays = Math.max(0, options.now - pattern.lastUsed) / (24 * 60 * 60 * 1000)
    if (ageDays > options.maxAgeDays * 1.5) return undefined

    let compared = 0
    let matched = 0
    for (const raw of pattern.conditions) {
      const parsed = parseCondition(raw)
      if (!parsed) continue
      const targetValue = targetValueByKey(target, parsed.key)
      if (!targetValue) continue
      compared += 1
      if (String(targetValue) !== parsed.value) return undefined
      matched += 1
    }

    const targetLabels = collectTargetSemanticLabels(target)
    const patternLabels = collectPatternSemanticLabels(pattern)
    if (hasHardSemanticConflict(patternLabels, targetLabels)) return undefined

    if (compared === 0 && patternLabels.size > 0 && targetLabels.size > 0) {
      const semanticFit = labelOverlapScore(patternLabels, targetLabels)
      if (semanticFit < 0.2) return undefined
    }

    const contextFit = compared === 0 ? 0.72 : 0.72 + (matched / compared) * 0.28
    const frequencyBoost = Math.min(1.2, 0.72 + Math.log2(pattern.frequency + 1) * 0.16)
    const specificityPenalty = Math.max(0.62, 1 - pattern.conditions.length * 0.035)
    const recencyDecay = Math.max(0.28, 1 - ageDays / Math.max(1, options.maxAgeDays))

    const confidence = pattern.successRate * frequencyBoost * specificityPenalty * contextFit * recencyDecay
    if (confidence < options.minConfidence) return undefined

    return { confidence, ageDays }
  }

  function collectPatternSemanticLabels(pattern: { action: string; trigger: string; context: string[]; conditions: string[] }) {
    const labels = new Set<string>()
    const text = [pattern.action, pattern.trigger, ...pattern.context, ...pattern.conditions].join(" ")
    const tokens = tokenizeSemantic(text)

    collectLabelsForAliases(tokens, LANGUAGE_ALIASES, "lang", labels)
    collectLabelsForAliases(tokens, FRAMEWORK_ALIASES, "fw", labels)
    collectLabelsForAliases(tokens, TASK_ALIASES, "task", labels)

    return labels
  }

  function collectTargetSemanticLabels(target: ContextualLearning) {
    const labels = new Set<string>()

    const language = normalizeAliasValue(target.language)
    if (language) labels.add(`lang:${language}`)

    const framework = normalizeFramework(target.framework)
    if (framework) labels.add(`fw:${framework}`)

    const task = normalizeTask(target.taskType)
    if (task) labels.add(`task:${task}`)

    return labels
  }

  function tokenizeSemantic(text: string) {
    return text
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .toLowerCase()
      .split(/[^a-z0-9_\u4e00-\u9fff]+/g)
      .filter((token) => token.length > 1)
  }

  function collectLabelsForAliases(
    tokens: string[],
    aliases: Record<string, string[]>,
    prefix: string,
    labels: Set<string>,
  ) {
    for (const token of tokens) {
      for (const [name, values] of Object.entries(aliases)) {
        if (
          values.some((value) => {
            if (token === value) return true
            if (value.length <= 3) return false
            return token.includes(value)
          })
        ) {
          labels.add(`${prefix}:${name}`)
          break
        }
      }
    }
  }

  function normalizeAliasValue(value?: string) {
    if (!value) return undefined
    const lowered = value.toLowerCase()
    for (const [name, aliases] of Object.entries(LANGUAGE_ALIASES)) {
      if (aliases.includes(lowered)) return name
    }
    return lowered
  }

  function normalizeFramework(value?: string) {
    if (!value) return undefined
    const lowered = value.toLowerCase()
    for (const [name, aliases] of Object.entries(FRAMEWORK_ALIASES)) {
      if (aliases.includes(lowered)) return name
    }
    return lowered
  }

  function normalizeTask(value?: string) {
    if (!value) return undefined
    const lowered = value.toLowerCase()
    for (const [name, aliases] of Object.entries(TASK_ALIASES)) {
      if (aliases.includes(lowered)) return name
    }
    return lowered
  }

  function labelsByPrefix(labels: Set<string>, prefix: string) {
    const values = new Set<string>()
    const start = `${prefix}:`
    for (const label of labels) {
      if (!label.startsWith(start)) continue
      values.add(label.slice(start.length))
    }
    return values
  }

  function hasHardSemanticConflict(patternLabels: Set<string>, targetLabels: Set<string>) {
    const prefixes = ["lang", "fw", "task"] as const
    for (const prefix of prefixes) {
      const patternValues = labelsByPrefix(patternLabels, prefix)
      const targetValues = labelsByPrefix(targetLabels, prefix)
      if (patternValues.size === 0 || targetValues.size === 0) continue
      const hasShared = [...patternValues].some((value) => targetValues.has(value))
      if (!hasShared) return true
    }
    return false
  }

  function labelOverlapScore(patternLabels: Set<string>, targetLabels: Set<string>) {
    if (patternLabels.size === 0 || targetLabels.size === 0) return 0
    let shared = 0
    for (const label of patternLabels) {
      if (targetLabels.has(label)) shared += 1
    }
    return shared / Math.max(1, patternLabels.size)
  }
}