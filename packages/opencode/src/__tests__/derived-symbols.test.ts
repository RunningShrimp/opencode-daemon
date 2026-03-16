import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const cleanup: string[] = []
const envKeys = ["XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME"] as const
const originalEnv = new Map<string, string | undefined>()

beforeEach(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-derived-symbols-"))
  cleanup.push(root)
  for (const key of envKeys) originalEnv.set(key, process.env[key])
  process.env.XDG_DATA_HOME = path.join(root, "data-home")
  process.env.XDG_CACHE_HOME = path.join(root, "cache-home")
  process.env.XDG_CONFIG_HOME = path.join(root, "config-home")
  process.env.XDG_STATE_HOME = path.join(root, "state-home")
  vi.restoreAllMocks()
})

afterEach(async () => {
  const { Instance } = await import("../project/instance")
  await Instance.disposeAll().catch(() => undefined)
  vi.restoreAllMocks()
  for (const key of envKeys) {
    const value = originalEnv.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  originalEnv.clear()
  while (cleanup.length > 0) {
    const target = cleanup.pop()
    if (target) await fs.rm(target, { recursive: true, force: true })
  }
})

describe("derived knowledge graph — internal symbols and call edges", () => {
  async function buildGraphForContent(content: string) {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-derived-sym-ws-"))
    cleanup.push(workspace)
    await fs.mkdir(path.join(workspace, "src"), { recursive: true })
    await fs.writeFile(path.join(workspace, "src", "module.ts"), content, "utf8")

    const { Instance } = await import("../project/instance")
    await Instance.reload({
      directory: workspace,
      worktree: workspace,
      project: {
        id: "derived-symbols-project",
        worktree: workspace,
        vcs: "git",
        time: { created: Date.now(), updated: Date.now() },
        sandboxes: [],
      },
    })

    let graph: any
    await Instance.provide({
      directory: workspace,
      fn: async () => {
        const { createKnowledgeGraph } = await import("../ai/knowledge/index")
        const { refreshDerivedKnowledgeGraph } = await import("../ai/knowledge/derived")
        graph = createKnowledgeGraph()
        await refreshDerivedKnowledgeGraph(graph, workspace)
      },
    })
    await Instance.disposeAll().catch(() => undefined)
    return graph
  }

  test("internal (non-exported) function symbols are added to the graph", async () => {
    const content = `
export function publicFn() {}
function internalHelper() {}
const privateConst = 42
`
    const graph = await buildGraphForContent(content)
    // Both "publicFn" (exported) and "internalHelper"/"privateConst" (internal) should appear
    const names = graph.query({}).map((n: any) => n.name)
    expect(names.some((n: string) => n.includes("internalHelper"))).toBeTrue()
  })

  test("internal class symbols are added to the graph", async () => {
    const content = `
export class PublicService {}
class InternalCache {}
`
    const graph = await buildGraphForContent(content)
    const names = graph.query({}).map((n: any) => n.name)
    expect(names.some((n: string) => n.includes("InternalCache"))).toBeTrue()
  })

  test("function call relationships produce edges in the graph", async () => {
    const content = `
export function compute() {
  return helper()
}
function helper() {
  return 42
}
`
    const graph = await buildGraphForContent(content)
    const exported = graph.export()
    const callEdges = (exported.edges ?? []).filter((e: any) => e.relation === "calls")
    expect(callEdges.length).toBeGreaterThan(0)
    const callerToCallee = callEdges.map((e: any) => `${e.sourceId}->${e.targetId}`)
    expect(callerToCallee.length).toBeGreaterThan(0)
  })

  test("instantiation relationships produce edges in the graph", async () => {
    const content = `
class Cache {}
export function createService() {
  const c = new Cache()
  return c
}
`
    const graph = await buildGraphForContent(content)
    const exported = graph.export()
    const instEdges = (exported.edges ?? []).filter((e: any) => e.relation === "instantiates")
    expect(instEdges.length).toBeGreaterThan(0)
  })
})
