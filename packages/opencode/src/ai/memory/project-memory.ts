import { Storage } from "@/storage/storage"
import { Log } from "@/util/log"
import type { ClaimRecord } from "@/ai/thinking/evidence"
import { embeddingService } from "@/ai/rag/embedding"

const log = Log.create({ service: "project-memory" })
const MAX_PROJECT_MEMORY_ENTRIES = 200
const DEFAULT_PROMPT_MEMORY_BUDGET = 220
const MIN_PROMPT_MEMORY_BUDGET = 80

export type ProjectMemoryKind = "fact" | "constraint" | "term" | "command" | "summary" | "failure_mode"

export interface ProjectMemoryEntry {
  id: string
  kind: ProjectMemoryKind
  text: string
  confidence: number
  evidence: string[]
  tags: string[]
  createdAt: number
  updatedAt: number
}

export interface ProjectMemorySnapshot {
  version: 1
  projectID: string
  entries: ProjectMemoryEntry[]
  updatedAt: number
}

export interface RenderProjectMemoryOptions {
  query?: string
  budget?: number
  maxEntries?: number
}

const cache = new Map<string, ProjectMemorySnapshot>()
// In-memory embedding cache for semantic recall — capped at MAX_EMBEDDING_CACHE_SIZE entries.
const embeddingCache = new Map<string, number[]>()
const MAX_EMBEDDING_CACHE_SIZE = 500
// Project IDs that have been explicitly cleared in tests — read() skips disk for these.
const clearedProjects = new Set<string>()

function embeddingKey(projectID: string) {
  return ["project_memory_embeddings", projectID]
}

export namespace ProjectMemory {
  function key(projectID: string) {
    return ["project_memory", projectID]
  }

  async function persist(snapshot: ProjectMemorySnapshot) {
    cache.set(snapshot.projectID, snapshot)
    await Storage.write(key(snapshot.projectID), snapshot).catch((error) => {
      log.warn("failed to persist project memory", { projectID: snapshot.projectID, error: String(error) })
    })
    // Evict embedding cache entries for IDs no longer in the current snapshot
    const liveIds = new Set(snapshot.entries.map((e) => e.id))
    for (const id of Array.from(embeddingCache.keys())) {
      if (!liveIds.has(id)) embeddingCache.delete(id)
    }
    // Persist embeddings for current entries (cap at MAX_PROJECT_MEMORY_ENTRIES to bound storage size)
    const entryIds = snapshot.entries.map((e) => e.id)
    const cached: Record<string, number[]> = {}
    for (const id of entryIds) {
      const vec = embeddingCache.get(id)
      if (vec) cached[id] = vec
    }
    if (Object.keys(cached).length > 0) {
      await Storage.write(embeddingKey(snapshot.projectID), cached).catch(() => undefined)
    }
  }

  export async function read(projectID: string) {
    const cached = cache.get(projectID)
    if (cached) return cached
    if (clearedProjects.has(projectID)) {
      const snapshot: ProjectMemorySnapshot = { version: 1, projectID, entries: [], updatedAt: Date.now() }
      cache.set(projectID, snapshot)
      return snapshot
    }
    const stored = await Storage.read<ProjectMemorySnapshot>(key(projectID)).catch(() => undefined)
    if (stored) {
      cache.set(projectID, stored)
      // Restore persisted embeddings into the in-memory cache
      const storedEmbeddings = await Storage.read<Record<string, number[]>>(embeddingKey(projectID)).catch(() => undefined)
      if (storedEmbeddings) {
        for (const [id, vec] of Object.entries(storedEmbeddings)) {
          if (!embeddingCache.has(id)) embeddingCache.set(id, vec)
        }
      }
      return stored
    }
    const snapshot: ProjectMemorySnapshot = { version: 1, projectID, entries: [], updatedAt: Date.now() }
    cache.set(projectID, snapshot)
    return snapshot
  }

  export async function upsert(projectID: string, entry: Omit<ProjectMemoryEntry, "id" | "createdAt" | "updatedAt"> & { id?: string }) {
    const snapshot = await read(projectID)
    const now = Date.now()
    const existing = findMergeCandidate(snapshot.entries, entry)
    const sameSummarySource =
      !!existing &&
      existing.kind === "summary" &&
      entry.kind === "summary" &&
      summarySource(existing) !== undefined &&
      summarySource(existing) === summarySource(entry)
    const nextEntry: ProjectMemoryEntry = existing
      ? {
          ...existing,
          text: chooseMemoryText(existing.text, entry.text, entry.kind, sameSummarySource),
          confidence: Math.max(existing.confidence, entry.confidence),
          evidence: [...new Set([...existing.evidence, ...entry.evidence])].slice(0, 12),
          tags: [...new Set([...existing.tags, ...entry.tags])].slice(0, 12),
          updatedAt: now,
        }
      : { id: entry.id ?? crypto.randomUUID(), createdAt: now, updatedAt: now, ...entry }
    const next = {
      ...snapshot,
      entries: pruneProjectMemoryEntries(
        dedupeSummaryEntries([...snapshot.entries.filter((item) => item.id !== nextEntry.id), nextEntry]),
      ),
      updatedAt: now,
    }
    await persist(next)
    // Compute embedding for semantic recall; await so it's available before the next renderPromptContext call.
    if (!embeddingCache.has(nextEntry.id)) {
      await embeddingService
        .getEmbedding({ content: nextEntry.text, modality: "text" })
        .then((vec) => {
          embeddingCache.set(nextEntry.id, vec)
          // LRU eviction: remove oldest entries when cache exceeds capacity.
          while (embeddingCache.size > MAX_EMBEDDING_CACHE_SIZE) {
            const oldest = embeddingCache.keys().next().value
            if (oldest !== undefined) embeddingCache.delete(oldest)
          }
        })
        .catch(() => undefined)
    }
    return nextEntry
  }

  export async function ingestClaim(projectID: string, claim: ClaimRecord) {
    if (claim.confidence < 0.6 || claim.counterEvidence.length > claim.evidence.length) return undefined
    const tags = [claim.source, ...claim.evidence.flatMap((item) => item.metadata?.resultType ? [String(item.metadata.resultType)] : [])]
    return upsert(projectID, {
      kind: "fact",
      text: claim.claim,
      confidence: claim.confidence,
      evidence: [...claim.evidence, ...claim.counterEvidence].map((item) => item.attribution.label),
      tags,
    })
  }

  export async function rememberConstraint(projectID: string, text: string, evidence: string[] = []) {
    return upsert(projectID, { kind: "constraint", text, confidence: 0.9, evidence, tags: ["constraint"] })
  }

  export async function rememberPromptConstraints(projectID: string, prompt: string) {
    const constraints = extractConstraints(prompt)
    const result = []
    for (const item of constraints) {
      result.push(await rememberConstraint(projectID, item, [prompt.slice(0, 200)]))
    }
    return result
  }

  export async function rememberFailureMode(projectID: string, text: string, evidence: string[] = []) {
    return upsert(projectID, { kind: "failure_mode", text, confidence: 0.8, evidence, tags: ["failure"] })
  }

  export async function rememberToolFailure(input: {
    projectID: string
    tool: string
    message: string
    taskType?: string
    evidence?: string[]
  }) {
    const summary = clipFailure(input.message)
    if (!summary) return undefined
    return rememberFailureMode(
      input.projectID,
      `Tool ${input.tool} failed${input.taskType ? ` during ${input.taskType}` : ""}: ${summary}`,
      input.evidence ?? [],
    )
  }

  export async function renderPromptContext(projectID: string, queryOrOptions?: string | RenderProjectMemoryOptions) {
    const snapshot = await read(projectID)
    if (snapshot.entries.length === 0) return undefined
    const options: RenderProjectMemoryOptions =
      typeof queryOrOptions === "string"
        ? { query: queryOrOptions }
        : queryOrOptions ?? {}
    const budget = Math.max(MIN_PROMPT_MEMORY_BUDGET, options.budget ?? estimatePromptBudget(options.query))
    const maxEntries = Math.max(1, Math.min(20, options.maxEntries ?? 12))
    const query = options.query
    const terms = tokenize(query ?? "")
    // Use cosine similarity when query embedding and entry embeddings are cached;
    // fall back to text-overlap scoring for uncached entries.
    const queryVec = query
      ? await embeddingService.getEmbedding({ content: query, modality: "text" }).catch(() => undefined)
      : undefined
    const ranked = [...snapshot.entries]
      .map((entry) => {
        const baseScore =
          entry.confidence +
          Math.min(0.75, entry.evidence.length * 0.1) +
          recencyBoost(entry.updatedAt)
        const entryVec = embeddingCache.get(entry.id)
        const similarityScore =
          queryVec && entryVec
            ? cosineSim(queryVec, entryVec) * 3
            : terms.filter(
                (term) =>
                  entry.text.toLowerCase().includes(term) ||
                  entry.tags.some((tag) => tag.toLowerCase().includes(term)),
              ).length * 1.5
        return { entry, score: baseScore + similarityScore }
      })
      .sort((a, b) => b.score - a.score)
      .map((item) => item.entry)
    const selected = selectEntriesByBudget(ranked, budget, maxEntries)
    if (selected.length === 0) return undefined
    const lines = [
      "<project_memory>",
      `Project-level remembered facts and constraints (budget=${budget} tokens, selected=${selected.length}):`,
    ]
    for (const entry of selected) lines.push(`- [${entry.kind}] ${entry.text}`)
    lines.push("</project_memory>")
    return lines.join("\n")
  }

  export function resetForTest() {
    clearedProjects.clear()
    for (const id of cache.keys()) clearedProjects.add(id)
    cache.clear()
    embeddingCache.clear()
  }
}

function tokenize(text: string) {
  return text.toLowerCase().split(/[^a-z0-9_]+/g).filter((item) => item.length > 2)
}

function extractConstraints(prompt: string) {
  const cn = ["必须", "需要", "不要", "不能", "禁止"]
  const en = ["must", "required", "should", "do not", "don't", "without"]
  return prompt
    .split(/\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
    .filter((line) => {
      const lower = line.toLowerCase()
      return cn.some((item) => line.includes(item)) || en.some((item) => lower.includes(item))
    })
    .slice(0, 8)
}

function clipFailure(message: string) {
  const text = message.replace(/\s+/g, " ").trim()
  if (!text) return ""
  return text.length > 160 ? `${text.slice(0, 159).trimEnd()}…` : text
}

function normalizeMemoryText(text: string) {
  return text
    .toLowerCase()
    .replace(/[`'"_*~]/g, "")
    .replace(/[^a-z0-9\u4e00-\u9fff]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
}

function overlapScore(a: string, b: string) {
  const left = new Set(tokenize(a))
  const right = new Set(tokenize(b))
  if (left.size === 0 || right.size === 0) return 0
  const intersection = [...left].filter((item) => right.has(item)).length
  const union = new Set([...left, ...right]).size
  return union > 0 ? intersection / union : 0
}

function shareTags(a: string[], b: string[]) {
  return a.some((item) => b.includes(item))
}

function findMergeCandidate(
  entries: ProjectMemoryEntry[],
  entry: Omit<ProjectMemoryEntry, "id" | "createdAt" | "updatedAt"> & { id?: string },
) {
  const incomingSummarySource = entry.kind === "summary" ? summarySource(entry) : undefined
  const normalized = normalizeMemoryText(entry.text)
  return entries.find((item) => {
    if (item.kind !== entry.kind) return false
    if (item.kind === "summary" && incomingSummarySource) {
      const existingSource = summarySource(item)
      if (existingSource && existingSource === incomingSummarySource) return true
    }
    const existingNormalized = normalizeMemoryText(item.text)
    if (existingNormalized === normalized) return true
    if (!shareTags(item.tags, entry.tags)) return false
    return overlapScore(item.text, entry.text) >= 0.8
  })
}

function chooseMemoryText(
  existing: string,
  incoming: string,
  kind: ProjectMemoryKind,
  sameSummarySource = false,
) {
  if (kind === "summary" && sameSummarySource) {
    return incoming
  }
  if (normalizeMemoryText(existing) === normalizeMemoryText(incoming)) {
    return incoming.length > existing.length ? incoming : existing
  }
  return incoming.length >= existing.length ? incoming : existing
}

function summarySource(entry: Pick<ProjectMemoryEntry, "evidence" | "tags">) {
  const source = entry.evidence[0]?.trim()
  if (source) return source.toLowerCase()
  const docTag = entry.tags.find((tag) => tag.toLowerCase() === "doc")
  if (docTag) return docTag
  return undefined
}

function dedupeSummaryEntries(entries: ProjectMemoryEntry[]) {
  const seen = new Map<string, ProjectMemoryEntry>()
  const rest: ProjectMemoryEntry[] = []
  for (const entry of entries) {
    if (entry.kind !== "summary") {
      rest.push(entry)
      continue
    }
    const source = summarySource(entry)
    if (!source) {
      rest.push(entry)
      continue
    }
    const existing = seen.get(source)
    if (!existing || entry.updatedAt >= existing.updatedAt) {
      seen.set(source, entry)
    }
  }
  return [...rest, ...seen.values()]
}

function pruneProjectMemoryEntries(entries: ProjectMemoryEntry[]) {
  const now = Date.now()
  return [...entries]
    .sort(
      (a, b) =>
        projectMemoryScore(b, now) - projectMemoryScore(a, now) ||
        b.updatedAt - a.updatedAt,
    )
    .slice(0, MAX_PROJECT_MEMORY_ENTRIES)
}

function projectMemoryScore(entry: ProjectMemoryEntry, now: number) {
  const ageDays = Math.max(0, now - entry.updatedAt) / (24 * 60 * 60 * 1000)
  const recency = Math.max(0.1, 1 - ageDays / 45)
  return entry.confidence * 3 + Math.min(1, entry.evidence.length * 0.15) + Math.min(0.8, entry.tags.length * 0.05) + recency
}

function recencyBoost(updatedAt: number) {
  const ageHours = Math.max(0, Date.now() - updatedAt) / (60 * 60 * 1000)
  if (ageHours < 1) return 0.6
  if (ageHours < 24) return 0.3
  if (ageHours < 24 * 7) return 0.1
  return 0
}

function estimatePromptBudget(query?: string) {
  if (!query) return DEFAULT_PROMPT_MEMORY_BUDGET
  const complexity = Math.min(120, Math.max(0, Math.floor(query.trim().length / 2)))
  return DEFAULT_PROMPT_MEMORY_BUDGET + complexity
}

function estimateEntryTokens(text: string) {
  const tokensFromChars = Math.ceil(text.length / 4)
  return tokensFromChars + 8
}

function selectEntriesByBudget(entries: ProjectMemoryEntry[], budget: number, maxEntries: number) {
  const selected: ProjectMemoryEntry[] = []
  let spent = 20
  for (const entry of entries) {
    if (selected.length >= maxEntries) break
    const line = `- [${entry.kind}] ${entry.text}`
    const cost = estimateEntryTokens(line)
    if (selected.length > 0 && spent + cost > budget) continue
    selected.push(entry)
    spent += cost
  }
  if (selected.length === 0 && entries[0]) selected.push(entries[0])
  return selected
}

function cosineSim(a: number[], b: number[]): number {
  if (a.length === 0 || a.length !== b.length) return 0
  let dot = 0
  let normA = 0
  let normB = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    normA += a[i] * a[i]
    normB += b[i] * b[i]
  }
  return normA > 0 && normB > 0 ? dot / (Math.sqrt(normA) * Math.sqrt(normB)) : 0
}