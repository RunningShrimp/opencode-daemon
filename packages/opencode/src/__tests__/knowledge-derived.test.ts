import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"

const cleanup: string[] = []
const envKeys = ["XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME"] as const
const originalEnv = new Map<string, string | undefined>()

beforeEach(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-knowledge-derived-"))
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

describe("derived knowledge graph", () => {
  test("prefers imported module symbol when call targets collide across files", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-knowledge-derived-import-call-"))
    cleanup.push(workspace)
    await fs.mkdir(path.join(workspace, "src"), { recursive: true })
    await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: "import-call-demo" }), "utf8")
    await fs.writeFile(path.join(workspace, "src", "a.ts"), "export function helper() { return 'a' }\n", "utf8")
    await fs.writeFile(path.join(workspace, "src", "b.ts"), "export function helper() { return 'b' }\n", "utf8")
    await fs.writeFile(
      path.join(workspace, "src", "main.ts"),
      [
        "import { helper } from './b'",
        "export function run() {",
        "  return helper()",
        "}",
      ].join("\n"),
      "utf8",
    )

    const { Instance } = await import("../project/instance")
    await Instance.reload({
      directory: workspace,
      worktree: workspace,
      project: {
        id: "derived-knowledge-import-call-project",
        worktree: workspace,
        vcs: "git",
        time: { created: Date.now(), updated: Date.now() },
        sandboxes: [],
      },
    })

    await Instance.provide({
      directory: workspace,
      fn: async () => {
        const { createKnowledgeGraph } = await import("../ai/knowledge/index")
        const { refreshDerivedKnowledgeGraph } = await import("../ai/knowledge/derived")

        const graph = createKnowledgeGraph()
        await refreshDerivedKnowledgeGraph(graph, workspace)

        const runNode = graph
          .query({ text: "run", limit: 8 })
          .find((node) => node.tags.includes("symbol") && node.metadata?.path === "src/main.ts")
        const helperFromA = graph
          .query({ text: "helper", limit: 12 })
          .find((node) => node.tags.includes("symbol") && node.metadata?.path === "src/a.ts")
        const helperFromB = graph
          .query({ text: "helper", limit: 12 })
          .find((node) => node.tags.includes("symbol") && node.metadata?.path === "src/b.ts")

        expect(runNode).toBeDefined()
        expect(helperFromA).toBeDefined()
        expect(helperFromB).toBeDefined()

        const callTargets = graph
          .getEdges(runNode!.id, "out")
          .filter((edge) => edge.relation === "calls")
          .map((edge) => edge.targetId)

        expect(callTargets).toContain(helperFromB!.id)
        expect(callTargets).not.toContain(helperFromA!.id)
      },
    })
  })

  test("resolves TypeScript named import aliases to original exported symbols", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-knowledge-derived-ts-alias-call-"))
    cleanup.push(workspace)
    await fs.mkdir(path.join(workspace, "src"), { recursive: true })
    await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: "ts-alias-call-demo" }), "utf8")
    await fs.writeFile(path.join(workspace, "src", "a.ts"), "export function helper() { return 'a' }\n", "utf8")
    await fs.writeFile(path.join(workspace, "src", "b.ts"), "export function helper() { return 'b' }\n", "utf8")
    await fs.writeFile(
      path.join(workspace, "src", "main.ts"),
      [
        "import { helper } from './a'",
        "import { helper as twoHelper } from './b'",
        "export function run() {",
        "  return twoHelper()",
        "}",
      ].join("\n"),
      "utf8",
    )

    const { Instance } = await import("../project/instance")
    await Instance.reload({
      directory: workspace,
      worktree: workspace,
      project: {
        id: "derived-knowledge-ts-alias-call-project",
        worktree: workspace,
        vcs: "git",
        time: { created: Date.now(), updated: Date.now() },
        sandboxes: [],
      },
    })

    await Instance.provide({
      directory: workspace,
      fn: async () => {
        const { createKnowledgeGraph } = await import("../ai/knowledge/index")
        const { refreshDerivedKnowledgeGraph } = await import("../ai/knowledge/derived")

        const graph = createKnowledgeGraph()
        await refreshDerivedKnowledgeGraph(graph, workspace)

        const runNode = graph
          .query({ text: "run", limit: 10 })
          .find((node) => node.tags.includes("symbol") && node.metadata?.path === "src/main.ts")
        const helperFromA = graph
          .query({ text: "helper", limit: 12 })
          .find((node) => node.tags.includes("symbol") && node.metadata?.path === "src/a.ts")
        const helperFromB = graph
          .query({ text: "helper", limit: 12 })
          .find((node) => node.tags.includes("symbol") && node.metadata?.path === "src/b.ts")

        expect(runNode).toBeDefined()
        expect(helperFromA).toBeDefined()
        expect(helperFromB).toBeDefined()

        const callTargets = graph
          .getEdges(runNode!.id, "out")
          .filter((edge) => edge.relation === "calls")
          .map((edge) => edge.targetId)

        expect(callTargets).toContain(helperFromB!.id)
        expect(callTargets).not.toContain(helperFromA!.id)
      },
    })
  })

  test("resolves TypeScript default import aliases for qualifier member calls", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-knowledge-derived-ts-default-alias-call-"))
    cleanup.push(workspace)
    await fs.mkdir(path.join(workspace, "src"), { recursive: true })
    await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: "ts-default-alias-call-demo" }), "utf8")
    await fs.writeFile(path.join(workspace, "src", "a.ts"), "export function helper() { return 'a' }\n", "utf8")
    await fs.writeFile(
      path.join(workspace, "src", "b.ts"),
      [
        "export function helper() { return 'b' }",
        "export default { helper }",
      ].join("\n"),
      "utf8",
    )
    await fs.writeFile(
      path.join(workspace, "src", "main.ts"),
      [
        "import { helper } from './a'",
        "import two from './b'",
        "export function run() {",
        "  return two.helper()",
        "}",
      ].join("\n"),
      "utf8",
    )

    const { Instance } = await import("../project/instance")
    await Instance.reload({
      directory: workspace,
      worktree: workspace,
      project: {
        id: "derived-knowledge-ts-default-alias-call-project",
        worktree: workspace,
        vcs: "git",
        time: { created: Date.now(), updated: Date.now() },
        sandboxes: [],
      },
    })

    await Instance.provide({
      directory: workspace,
      fn: async () => {
        const { createKnowledgeGraph } = await import("../ai/knowledge/index")
        const { refreshDerivedKnowledgeGraph } = await import("../ai/knowledge/derived")

        const graph = createKnowledgeGraph()
        await refreshDerivedKnowledgeGraph(graph, workspace)

        const runNode = graph
          .query({ text: "run", limit: 10 })
          .find((node) => node.tags.includes("symbol") && node.metadata?.path === "src/main.ts")
        const helperFromA = graph
          .query({ text: "helper", limit: 12 })
          .find((node) => node.tags.includes("symbol") && node.metadata?.path === "src/a.ts")
        const helperFromB = graph
          .query({ text: "helper", limit: 12 })
          .find((node) => node.tags.includes("symbol") && node.metadata?.path === "src/b.ts")

        expect(runNode).toBeDefined()
        expect(helperFromA).toBeDefined()
        expect(helperFromB).toBeDefined()

        const callTargets = graph
          .getEdges(runNode!.id, "out")
          .filter((edge) => edge.relation === "calls")
          .map((edge) => edge.targetId)

        expect(callTargets).toContain(helperFromB!.id)
        expect(callTargets).not.toContain(helperFromA!.id)
      },
    })
  })

  test("resolves TypeScript named re-export chains to original exported symbols", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-knowledge-derived-ts-reexport-named-"))
    cleanup.push(workspace)
    await fs.mkdir(path.join(workspace, "src"), { recursive: true })
    await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: "ts-reexport-named-demo" }), "utf8")
    await fs.writeFile(path.join(workspace, "src", "a.ts"), "export function helper() { return 'a' }\n", "utf8")
    await fs.writeFile(path.join(workspace, "src", "b.ts"), "export function helper() { return 'b' }\n", "utf8")
    await fs.writeFile(path.join(workspace, "src", "barrel.ts"), "export { helper } from './b'\n", "utf8")
    await fs.writeFile(
      path.join(workspace, "src", "main.ts"),
      [
        "import { helper } from './a'",
        "import { helper as viaBarrel } from './barrel'",
        "export function run() {",
        "  return viaBarrel()",
        "}",
      ].join("\n"),
      "utf8",
    )

    const { Instance } = await import("../project/instance")
    await Instance.reload({
      directory: workspace,
      worktree: workspace,
      project: {
        id: "derived-knowledge-ts-reexport-named-project",
        worktree: workspace,
        vcs: "git",
        time: { created: Date.now(), updated: Date.now() },
        sandboxes: [],
      },
    })

    await Instance.provide({
      directory: workspace,
      fn: async () => {
        const { createKnowledgeGraph } = await import("../ai/knowledge/index")
        const { refreshDerivedKnowledgeGraph } = await import("../ai/knowledge/derived")

        const graph = createKnowledgeGraph()
        await refreshDerivedKnowledgeGraph(graph, workspace)

        const runNode = graph
          .query({ text: "run", limit: 10 })
          .find((node) => node.tags.includes("symbol") && node.metadata?.path === "src/main.ts")
        const helperFromA = graph
          .query({ text: "helper", limit: 16 })
          .find((node) => node.tags.includes("symbol") && node.metadata?.path === "src/a.ts")
        const helperFromB = graph
          .query({ text: "helper", limit: 16 })
          .find((node) => node.tags.includes("symbol") && node.metadata?.path === "src/b.ts")

        expect(runNode).toBeDefined()
        expect(helperFromA).toBeDefined()
        expect(helperFromB).toBeDefined()

        const callTargets = graph
          .getEdges(runNode!.id, "out")
          .filter((edge) => edge.relation === "calls")
          .map((edge) => edge.targetId)

        expect(callTargets).toContain(helperFromB!.id)
        expect(callTargets).not.toContain(helperFromA!.id)
      },
    })
  })

  test("resolves TypeScript export-star chains to original exported symbols", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-knowledge-derived-ts-reexport-star-"))
    cleanup.push(workspace)
    await fs.mkdir(path.join(workspace, "src"), { recursive: true })
    await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: "ts-reexport-star-demo" }), "utf8")
    await fs.writeFile(path.join(workspace, "src", "a.ts"), "export function helper() { return 'a' }\n", "utf8")
    await fs.writeFile(path.join(workspace, "src", "c.ts"), "export function helper() { return 'c' }\n", "utf8")
    await fs.writeFile(path.join(workspace, "src", "barrel.ts"), "export * from './c'\n", "utf8")
    await fs.writeFile(
      path.join(workspace, "src", "main.ts"),
      [
        "import { helper } from './a'",
        "import { helper as fromBarrel } from './barrel'",
        "export function run() {",
        "  return fromBarrel()",
        "}",
      ].join("\n"),
      "utf8",
    )

    const { Instance } = await import("../project/instance")
    await Instance.reload({
      directory: workspace,
      worktree: workspace,
      project: {
        id: "derived-knowledge-ts-reexport-star-project",
        worktree: workspace,
        vcs: "git",
        time: { created: Date.now(), updated: Date.now() },
        sandboxes: [],
      },
    })

    await Instance.provide({
      directory: workspace,
      fn: async () => {
        const { createKnowledgeGraph } = await import("../ai/knowledge/index")
        const { refreshDerivedKnowledgeGraph } = await import("../ai/knowledge/derived")

        const graph = createKnowledgeGraph()
        await refreshDerivedKnowledgeGraph(graph, workspace)

        const runNode = graph
          .query({ text: "run", limit: 10 })
          .find((node) => node.tags.includes("symbol") && node.metadata?.path === "src/main.ts")
        const helperFromA = graph
          .query({ text: "helper", limit: 16 })
          .find((node) => node.tags.includes("symbol") && node.metadata?.path === "src/a.ts")
        const helperFromC = graph
          .query({ text: "helper", limit: 16 })
          .find((node) => node.tags.includes("symbol") && node.metadata?.path === "src/c.ts")

        expect(runNode).toBeDefined()
        expect(helperFromA).toBeDefined()
        expect(helperFromC).toBeDefined()

        const callTargets = graph
          .getEdges(runNode!.id, "out")
          .filter((edge) => edge.relation === "calls")
          .map((edge) => edge.targetId)

        expect(callTargets).toContain(helperFromC!.id)
        expect(callTargets).not.toContain(helperFromA!.id)
      },
    })
  })

  test("resolves TypeScript export-namespace re-export qualifiers to original symbols", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-knowledge-derived-ts-reexport-namespace-"))
    cleanup.push(workspace)
    await fs.mkdir(path.join(workspace, "src"), { recursive: true })
    await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: "ts-reexport-namespace-demo" }), "utf8")
    await fs.writeFile(path.join(workspace, "src", "a.ts"), "export function helper() { return 'a' }\n", "utf8")
    await fs.writeFile(path.join(workspace, "src", "d.ts"), "export function helper() { return 'd' }\n", "utf8")
    await fs.writeFile(path.join(workspace, "src", "barrel.ts"), "export * as tools from './d'\n", "utf8")
    await fs.writeFile(
      path.join(workspace, "src", "main.ts"),
      [
        "import { helper } from './a'",
        "import { tools } from './barrel'",
        "export function run() {",
        "  return tools.helper()",
        "}",
      ].join("\n"),
      "utf8",
    )

    const { Instance } = await import("../project/instance")
    await Instance.reload({
      directory: workspace,
      worktree: workspace,
      project: {
        id: "derived-knowledge-ts-reexport-namespace-project",
        worktree: workspace,
        vcs: "git",
        time: { created: Date.now(), updated: Date.now() },
        sandboxes: [],
      },
    })

    await Instance.provide({
      directory: workspace,
      fn: async () => {
        const { createKnowledgeGraph } = await import("../ai/knowledge/index")
        const { refreshDerivedKnowledgeGraph } = await import("../ai/knowledge/derived")

        const graph = createKnowledgeGraph()
        await refreshDerivedKnowledgeGraph(graph, workspace)

        const runNode = graph
          .query({ text: "run", limit: 10 })
          .find((node) => node.tags.includes("symbol") && node.metadata?.path === "src/main.ts")
        const helperFromA = graph
          .query({ text: "helper", limit: 16 })
          .find((node) => node.tags.includes("symbol") && node.metadata?.path === "src/a.ts")
        const helperFromD = graph
          .query({ text: "helper", limit: 16 })
          .find((node) => node.tags.includes("symbol") && node.metadata?.path === "src/d.ts")

        expect(runNode).toBeDefined()
        expect(helperFromA).toBeDefined()
        expect(helperFromD).toBeDefined()

        const callTargets = graph
          .getEdges(runNode!.id, "out")
          .filter((edge) => edge.relation === "calls")
          .map((edge) => edge.targetId)

        expect(callTargets).toContain(helperFromD!.id)
        expect(callTargets).not.toContain(helperFromA!.id)
      },
    })
  })

  test("resolves multi-hop TypeScript export-namespace re-export qualifiers", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-knowledge-derived-ts-reexport-namespace-multihop-"))
    cleanup.push(workspace)
    await fs.mkdir(path.join(workspace, "src"), { recursive: true })
    await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: "ts-reexport-namespace-multihop-demo" }), "utf8")
    await fs.writeFile(path.join(workspace, "src", "a.ts"), "export function helper() { return 'a' }\n", "utf8")
    await fs.writeFile(path.join(workspace, "src", "d.ts"), "export function helper() { return 'd' }\n", "utf8")
    await fs.writeFile(path.join(workspace, "src", "barrel2.ts"), "export * as tools from './d'\n", "utf8")
    await fs.writeFile(path.join(workspace, "src", "barrel1.ts"), "export { tools as hub } from './barrel2'\n", "utf8")
    await fs.writeFile(
      path.join(workspace, "src", "main.ts"),
      [
        "import { helper } from './a'",
        "import { hub } from './barrel1'",
        "export function run() {",
        "  return hub.helper()",
        "}",
      ].join("\n"),
      "utf8",
    )

    const { Instance } = await import("../project/instance")
    await Instance.reload({
      directory: workspace,
      worktree: workspace,
      project: {
        id: "derived-knowledge-ts-reexport-namespace-multihop-project",
        worktree: workspace,
        vcs: "git",
        time: { created: Date.now(), updated: Date.now() },
        sandboxes: [],
      },
    })

    await Instance.provide({
      directory: workspace,
      fn: async () => {
        const { createKnowledgeGraph } = await import("../ai/knowledge/index")
        const { refreshDerivedKnowledgeGraph } = await import("../ai/knowledge/derived")

        const graph = createKnowledgeGraph()
        await refreshDerivedKnowledgeGraph(graph, workspace)

        const runNode = graph
          .query({ text: "run", limit: 10 })
          .find((node) => node.tags.includes("symbol") && node.metadata?.path === "src/main.ts")
        const helperFromA = graph
          .query({ text: "helper", limit: 16 })
          .find((node) => node.tags.includes("symbol") && node.metadata?.path === "src/a.ts")
        const helperFromD = graph
          .query({ text: "helper", limit: 16 })
          .find((node) => node.tags.includes("symbol") && node.metadata?.path === "src/d.ts")

        expect(runNode).toBeDefined()
        expect(helperFromA).toBeDefined()
        expect(helperFromD).toBeDefined()

        const callTargets = graph
          .getEdges(runNode!.id, "out")
          .filter((edge) => edge.relation === "calls")
          .map((edge) => edge.targetId)

        expect(callTargets).toContain(helperFromD!.id)
        expect(callTargets).not.toContain(helperFromA!.id)
      },
    })
  })

  test("handles cyclic TypeScript export-star re-export chains without false call edges", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-knowledge-derived-ts-reexport-cycle-"))
    cleanup.push(workspace)
    await fs.mkdir(path.join(workspace, "src"), { recursive: true })
    await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: "ts-reexport-cycle-demo" }), "utf8")
    await fs.writeFile(path.join(workspace, "src", "a.ts"), "export function helper() { return 'a' }\n", "utf8")
    await fs.writeFile(path.join(workspace, "src", "loop1.ts"), "export * from './loop2'\n", "utf8")
    await fs.writeFile(path.join(workspace, "src", "loop2.ts"), "export * from './loop1'\n", "utf8")
    await fs.writeFile(
      path.join(workspace, "src", "main.ts"),
      [
        "import { helper } from './a'",
        "import { helper as loopHelper } from './loop1'",
        "export function run() {",
        "  return loopHelper()",
        "}",
      ].join("\n"),
      "utf8",
    )

    const { Instance } = await import("../project/instance")
    await Instance.reload({
      directory: workspace,
      worktree: workspace,
      project: {
        id: "derived-knowledge-ts-reexport-cycle-project",
        worktree: workspace,
        vcs: "git",
        time: { created: Date.now(), updated: Date.now() },
        sandboxes: [],
      },
    })

    await Instance.provide({
      directory: workspace,
      fn: async () => {
        const { createKnowledgeGraph } = await import("../ai/knowledge/index")
        const { refreshDerivedKnowledgeGraph } = await import("../ai/knowledge/derived")

        const graph = createKnowledgeGraph()
        await refreshDerivedKnowledgeGraph(graph, workspace)

        const runNode = graph
          .query({ text: "run", limit: 10 })
          .find((node) => node.tags.includes("symbol") && node.metadata?.path === "src/main.ts")
        const helperFromA = graph
          .query({ text: "helper", limit: 16 })
          .find((node) => node.tags.includes("symbol") && node.metadata?.path === "src/a.ts")

        expect(runNode).toBeDefined()
        expect(helperFromA).toBeDefined()

        const callTargets = graph
          .getEdges(runNode!.id, "out")
          .filter((edge) => edge.relation === "calls")
          .map((edge) => edge.targetId)

        expect(callTargets.length).toBe(0)
        expect(callTargets).not.toContain(helperFromA!.id)
      },
    })
  })

  test("resolves mixed TypeScript import patterns with same-name symbols", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-knowledge-derived-ts-mixed-imports-"))
    cleanup.push(workspace)
    await fs.mkdir(path.join(workspace, "src"), { recursive: true })
    await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: "ts-mixed-imports-demo" }), "utf8")
    await fs.writeFile(path.join(workspace, "src", "a.ts"), "export function helper() { return 'a' }\n", "utf8")
    await fs.writeFile(
      path.join(workspace, "src", "b.ts"),
      [
        "export function helper() { return 'b' }",
        "export default { helper }",
      ].join("\n"),
      "utf8",
    )
    await fs.writeFile(path.join(workspace, "src", "c.ts"), "export function helper() { return 'c' }\n", "utf8")
    await fs.writeFile(path.join(workspace, "src", "barrel.ts"), "export { helper as namedHelper } from './c'\n", "utf8")
    await fs.writeFile(
      path.join(workspace, "src", "main.ts"),
      [
        "import * as aNS from './a'",
        "import two, { helper as helperFromB } from './b'",
        "import { namedHelper as helperFromC } from './barrel'",
        "export function run() {",
        "  aNS.helper()",
        "  two.helper()",
        "  helperFromB()",
        "  helperFromC()",
        "}",
      ].join("\n"),
      "utf8",
    )

    const { Instance } = await import("../project/instance")
    await Instance.reload({
      directory: workspace,
      worktree: workspace,
      project: {
        id: "derived-knowledge-ts-mixed-imports-project",
        worktree: workspace,
        vcs: "git",
        time: { created: Date.now(), updated: Date.now() },
        sandboxes: [],
      },
    })

    await Instance.provide({
      directory: workspace,
      fn: async () => {
        const { createKnowledgeGraph } = await import("../ai/knowledge/index")
        const { refreshDerivedKnowledgeGraph } = await import("../ai/knowledge/derived")

        const graph = createKnowledgeGraph()
        await refreshDerivedKnowledgeGraph(graph, workspace)

        const runNode = graph
          .query({ text: "run", limit: 10 })
          .find((node) => node.tags.includes("symbol") && node.metadata?.path === "src/main.ts")
        const helperFromA = graph
          .query({ text: "helper", limit: 16 })
          .find((node) => node.tags.includes("symbol") && node.metadata?.path === "src/a.ts")
        const helperFromB = graph
          .query({ text: "helper", limit: 16 })
          .find((node) => node.tags.includes("symbol") && node.metadata?.path === "src/b.ts")
        const helperFromC = graph
          .query({ text: "helper", limit: 16 })
          .find((node) => node.tags.includes("symbol") && node.metadata?.path === "src/c.ts")

        expect(runNode).toBeDefined()
        expect(helperFromA).toBeDefined()
        expect(helperFromB).toBeDefined()
        expect(helperFromC).toBeDefined()

        const callTargets = graph
          .getEdges(runNode!.id, "out")
          .filter((edge) => edge.relation === "calls")
          .map((edge) => edge.targetId)

        expect(callTargets).toContain(helperFromA!.id)
        expect(callTargets).toContain(helperFromB!.id)
        expect(callTargets).toContain(helperFromC!.id)
      },
    })
  })

  test("extracts Rust symbols/calls/imports via tree-sitter when parser is available", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-knowledge-derived-rs-"))
    cleanup.push(workspace)
    await fs.mkdir(path.join(workspace, "src"), { recursive: true })
    await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: "rs-demo" }), "utf8")
    await fs.writeFile(
      path.join(workspace, "src", "lib.rs"),
      [
        "use serde::Serialize;",
        "",
        "struct Worker {}",
        "",
        "fn helper() {}",
        "",
        "pub fn process() {",
        "    helper();",
        "    let _w = Worker {};",
        "}",
      ].join("\n"),
      "utf8",
    )

    const { parseTreeSitterSyntaxTree } = await import("../util/tree-sitter-scope")
    const parseProbe = await parseTreeSitterSyntaxTree({
      filePath: "src/lib.rs",
      content: "fn probe() {}\n",
    })
    if (!parseProbe) return

    const { Instance } = await import("../project/instance")
    await Instance.reload({
      directory: workspace,
      worktree: workspace,
      project: {
        id: "derived-knowledge-rs-project",
        worktree: workspace,
        vcs: "git",
        time: { created: Date.now(), updated: Date.now() },
        sandboxes: [],
      },
    })

    await Instance.provide({
      directory: workspace,
      fn: async () => {
        const { createKnowledgeGraph } = await import("../ai/knowledge/index")
        const { refreshDerivedKnowledgeGraph } = await import("../ai/knowledge/derived")

        const graph = createKnowledgeGraph()
        await refreshDerivedKnowledgeGraph(graph, workspace)

        const processNode = graph
          .query({ text: "process", limit: 8 })
          .find((node) => node.tags.includes("symbol") && node.metadata?.path === "src/lib.rs")
        const helperNode = graph
          .query({ text: "helper", limit: 8 })
          .find((node) => node.tags.includes("symbol") && node.metadata?.path === "src/lib.rs")
        const workerNode = graph
          .query({ text: "Worker", limit: 8 })
          .find((node) => node.tags.includes("symbol") && node.metadata?.path === "src/lib.rs")
        const serdeImportNode = graph
          .query({ text: "serde::Serialize", limit: 8 })
          .find((node) => node.tags.includes("import") && node.metadata?.path === "src/lib.rs")

        expect(processNode).toBeDefined()
        expect(helperNode).toBeDefined()
        expect(workerNode).toBeDefined()
        expect(serdeImportNode).toBeDefined()
        expect(
          graph
            .getEdges(processNode!.id, "out")
            .some((edge) => edge.relation === "calls" && edge.targetId === helperNode!.id),
        ).toBeTrue()
      },
    })
  })

  test("extracts Python symbols/calls/instantiation via tree-sitter when parser is available", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-knowledge-derived-py-"))
    cleanup.push(workspace)
    await fs.mkdir(path.join(workspace, "src"), { recursive: true })
    await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: "py-demo" }), "utf8")
    await fs.writeFile(
      path.join(workspace, "src", "service.py"),
      [
        "class Worker:",
        "    pass",
        "",
        "def helper():",
        "    return 1",
        "",
        "def process():",
        "    helper()",
        "    return Worker()",
      ].join("\n"),
      "utf8",
    )

    const { parseTreeSitterSyntaxTree } = await import("../util/tree-sitter-scope")
    const parseProbe = await parseTreeSitterSyntaxTree({
      filePath: "src/service.py",
      content: "def probe():\n    return 1\n",
    })
    if (!parseProbe) {
      // In minimal environments where tree-sitter-python is not yet available,
      // the extractor must degrade gracefully without failing the test run.
      return
    }

    const { Instance } = await import("../project/instance")
    await Instance.reload({
      directory: workspace,
      worktree: workspace,
      project: {
        id: "derived-knowledge-py-project",
        worktree: workspace,
        vcs: "git",
        time: { created: Date.now(), updated: Date.now() },
        sandboxes: [],
      },
    })

    await Instance.provide({
      directory: workspace,
      fn: async () => {
        const { createKnowledgeGraph } = await import("../ai/knowledge/index")
        const { refreshDerivedKnowledgeGraph } = await import("../ai/knowledge/derived")

        const graph = createKnowledgeGraph()
        await refreshDerivedKnowledgeGraph(graph, workspace)

        const processNode = graph
          .query({ text: "process", limit: 8 })
          .find((node) => node.tags.includes("symbol") && node.metadata?.path === "src/service.py")
        const helperNode = graph
          .query({ text: "helper", limit: 8 })
          .find((node) => node.tags.includes("symbol") && node.metadata?.path === "src/service.py")
        const workerNode = graph
          .query({ text: "Worker", limit: 8 })
          .find((node) => node.tags.includes("symbol") && node.metadata?.path === "src/service.py")

        expect(processNode).toBeDefined()
        expect(helperNode).toBeDefined()
        expect(workerNode).toBeDefined()
        expect(
          graph
            .getEdges(processNode!.id, "out")
            .some((edge) => edge.relation === "calls" && edge.targetId === helperNode!.id),
        ).toBeTrue()
        expect(
          graph
            .getEdges(processNode!.id, "out")
            .some((edge) => edge.relation === "instantiates" && edge.targetId === workerNode!.id),
        ).toBeTrue()
      },
    })
  })

  test("extracts Go symbols and call relations via tree-sitter when parser is available", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-knowledge-derived-go-"))
    cleanup.push(workspace)
    await fs.mkdir(path.join(workspace, "src"), { recursive: true })
    await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: "go-demo" }), "utf8")
    await fs.writeFile(
      path.join(workspace, "src", "service.go"),
      [
        "package service",
        "",
        "type Worker struct{}",
        "",
        "func helper() {}",
        "",
        "func Process() {",
        "\thelper()",
        "}",
      ].join("\n"),
      "utf8",
    )

    const { parseTreeSitterSyntaxTree } = await import("../util/tree-sitter-scope")
    const parseProbe = await parseTreeSitterSyntaxTree({
      filePath: "src/service.go",
      content: "package main\nfunc Probe() {}\n",
    })
    if (!parseProbe) return

    const { Instance } = await import("../project/instance")
    await Instance.reload({
      directory: workspace,
      worktree: workspace,
      project: {
        id: "derived-knowledge-go-project",
        worktree: workspace,
        vcs: "git",
        time: { created: Date.now(), updated: Date.now() },
        sandboxes: [],
      },
    })

    await Instance.provide({
      directory: workspace,
      fn: async () => {
        const { createKnowledgeGraph } = await import("../ai/knowledge/index")
        const { refreshDerivedKnowledgeGraph } = await import("../ai/knowledge/derived")

        const graph = createKnowledgeGraph()
        await refreshDerivedKnowledgeGraph(graph, workspace)

        const processNode = graph
          .query({ text: "Process", limit: 10 })
          .find((node) => node.tags.includes("symbol") && node.metadata?.path === "src/service.go")
        const helperNode = graph
          .query({ text: "helper", limit: 10 })
          .find((node) => node.tags.includes("symbol") && node.metadata?.path === "src/service.go")

        expect(processNode).toBeDefined()
        expect(helperNode).toBeDefined()
        expect(processNode?.tags.includes("internal")).toBeFalse()
        expect(helperNode?.tags.includes("internal")).toBeTrue()
        expect(
          graph
            .getEdges(processNode!.id, "out")
            .some((edge) => edge.relation === "calls" && edge.targetId === helperNode!.id),
        ).toBeTrue()
      },
    })
  })

  test("extracts Java symbols/imports/calls via tree-sitter when parser is available", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-knowledge-derived-java-"))
    cleanup.push(workspace)
    await fs.mkdir(path.join(workspace, "src"), { recursive: true })
    await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: "java-demo" }), "utf8")
    await fs.writeFile(
      path.join(workspace, "src", "Service.java"),
      [
        "import java.util.ArrayList;",
        "",
        "public class Worker {}",
        "",
        "public class Service {",
        "  static void helper() {}",
        "  public static void process() {",
        "    helper();",
        "  }",
        "}",
      ].join("\n"),
      "utf8",
    )

    const { parseTreeSitterSyntaxTree } = await import("../util/tree-sitter-scope")
    const parseProbe = await parseTreeSitterSyntaxTree({
      filePath: "src/Service.java",
      content: "class Probe {}\n",
    })
    if (!parseProbe) return

    const { Instance } = await import("../project/instance")
    await Instance.reload({
      directory: workspace,
      worktree: workspace,
      project: {
        id: "derived-knowledge-java-project",
        worktree: workspace,
        vcs: "git",
        time: { created: Date.now(), updated: Date.now() },
        sandboxes: [],
      },
    })

    await Instance.provide({
      directory: workspace,
      fn: async () => {
        const { createKnowledgeGraph } = await import("../ai/knowledge/index")
        const { refreshDerivedKnowledgeGraph } = await import("../ai/knowledge/derived")

        const graph = createKnowledgeGraph()
        await refreshDerivedKnowledgeGraph(graph, workspace)

        const processNode = graph
          .query({ text: "process", limit: 10 })
          .find((node) => node.tags.includes("symbol") && node.metadata?.path === "src/Service.java")
        const helperNode = graph
          .query({ text: "helper", limit: 10 })
          .find((node) => node.tags.includes("symbol") && node.metadata?.path === "src/Service.java")
        const importNode = graph
          .query({ text: "java.util.ArrayList", limit: 10 })
          .find((node) => node.tags.includes("import") && node.metadata?.path === "src/Service.java")

        expect(processNode).toBeDefined()
        expect(helperNode).toBeDefined()
        expect(importNode).toBeDefined()
        expect(
          graph
            .getEdges(processNode!.id, "out")
            .some((edge) => edge.relation === "calls" && edge.targetId === helperNode!.id),
        ).toBeTrue()
      },
    })
  })

  test("resolves Java dotted package imports to local files", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-knowledge-derived-java-local-import-"))
    cleanup.push(workspace)
    await fs.mkdir(path.join(workspace, "src", "com", "example"), { recursive: true })
    await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: "java-local-import-demo" }), "utf8")
    await fs.writeFile(path.join(workspace, "src", "com", "example", "Helper.java"), "public class Helper {}\n", "utf8")
    await fs.writeFile(
      path.join(workspace, "src", "Service.java"),
      [
        "import com.example.Helper;",
        "public class Service {",
        "  public static void process() {}",
        "}",
      ].join("\n"),
      "utf8",
    )

    const { Instance } = await import("../project/instance")
    await Instance.reload({
      directory: workspace,
      worktree: workspace,
      project: {
        id: "derived-knowledge-java-local-import-project",
        worktree: workspace,
        vcs: "git",
        time: { created: Date.now(), updated: Date.now() },
        sandboxes: [],
      },
    })

    await Instance.provide({
      directory: workspace,
      fn: async () => {
        const { createKnowledgeGraph } = await import("../ai/knowledge/index")
        const { refreshDerivedKnowledgeGraph } = await import("../ai/knowledge/derived")

        const graph = createKnowledgeGraph()
        await refreshDerivedKnowledgeGraph(graph, workspace)

        const importNode = graph
          .query({ text: "com.example.Helper", limit: 10 })
          .find((node) => node.tags.includes("import") && node.metadata?.path === "src/Service.java")
        const helperFile = graph
          .query({ text: "src/com/example/Helper.java", limit: 10 })
          .find((node) => node.tags.includes("file") && node.metadata?.path === "src/com/example/Helper.java")

        expect(importNode).toBeDefined()
        expect(helperFile).toBeDefined()
        expect(importNode?.tags.includes("internal-import")).toBeTrue()
        expect(
          graph
            .getEdges(importNode!.id, "out")
            .some((edge) => edge.relation === "resolves_to" && edge.targetId === helperFile!.id),
        ).toBeTrue()
      },
    })
  })

  test("extracts C++ include and call edges via tree-sitter when parser is available", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-knowledge-derived-cpp-"))
    cleanup.push(workspace)
    await fs.mkdir(path.join(workspace, "src"), { recursive: true })
    await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: "cpp-demo" }), "utf8")
    await fs.writeFile(path.join(workspace, "src", "helper.h"), "int helper();\n", "utf8")
    await fs.writeFile(
      path.join(workspace, "src", "main.cpp"),
      [
        "#include \"helper.h\"",
        "",
        "int helper() { return 1; }",
        "",
        "int process() {",
        "  return helper();",
        "}",
      ].join("\n"),
      "utf8",
    )

    const { parseTreeSitterSyntaxTree } = await import("../util/tree-sitter-scope")
    const parseProbe = await parseTreeSitterSyntaxTree({
      filePath: "src/main.cpp",
      content: "int probe() { return 0; }\n",
    })
    if (!parseProbe) return

    const { Instance } = await import("../project/instance")
    await Instance.reload({
      directory: workspace,
      worktree: workspace,
      project: {
        id: "derived-knowledge-cpp-project",
        worktree: workspace,
        vcs: "git",
        time: { created: Date.now(), updated: Date.now() },
        sandboxes: [],
      },
    })

    await Instance.provide({
      directory: workspace,
      fn: async () => {
        const { createKnowledgeGraph } = await import("../ai/knowledge/index")
        const { refreshDerivedKnowledgeGraph } = await import("../ai/knowledge/derived")

        const graph = createKnowledgeGraph()
        await refreshDerivedKnowledgeGraph(graph, workspace)

        const processNode = graph
          .query({ text: "process", limit: 10 })
          .find((node) => node.tags.includes("symbol") && node.metadata?.path === "src/main.cpp")
        const helperNode = graph
          .query({ text: "helper", limit: 12 })
          .find((node) => node.tags.includes("symbol") && node.metadata?.path === "src/main.cpp")
        const includeNode = graph
          .query({ text: "helper.h", limit: 10 })
          .find((node) => node.tags.includes("import") && node.metadata?.path === "src/main.cpp")
        const helperHeaderFile = graph
          .query({ text: "src/helper.h", limit: 10 })
          .find((node) => node.tags.includes("file") && node.metadata?.path === "src/helper.h")

        expect(processNode).toBeDefined()
        expect(helperNode).toBeDefined()
        expect(includeNode).toBeDefined()
        expect(helperHeaderFile).toBeDefined()
        expect(
          graph
            .getEdges(processNode!.id, "out")
            .some((edge) => edge.relation === "calls" && edge.targetId === helperNode!.id),
        ).toBeTrue()
        expect(
          graph
            .getEdges(includeNode!.id, "out")
            .some((edge) => edge.relation === "resolves_to" && edge.targetId === helperHeaderFile!.id),
        ).toBeTrue()
      },
    })
  })

  test("resolves Go module-prefixed imports to local package files", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-knowledge-derived-go-module-import-"))
    cleanup.push(workspace)
    await fs.mkdir(path.join(workspace, "pkg", "util"), { recursive: true })
    await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: "go-module-import-demo" }), "utf8")
    await fs.writeFile(path.join(workspace, "go.mod"), "module example.com/acme\n", "utf8")
    await fs.writeFile(path.join(workspace, "pkg", "util", "util.go"), "package util\nfunc Helper() {}\n", "utf8")
    await fs.writeFile(
      path.join(workspace, "main.go"),
      [
        "package main",
        "import \"example.com/acme/pkg/util\"",
        "func process() {",
        "\tutil.Helper()",
        "}",
      ].join("\n"),
      "utf8",
    )

    const { Instance } = await import("../project/instance")
    await Instance.reload({
      directory: workspace,
      worktree: workspace,
      project: {
        id: "derived-knowledge-go-module-import-project",
        worktree: workspace,
        vcs: "git",
        time: { created: Date.now(), updated: Date.now() },
        sandboxes: [],
      },
    })

    await Instance.provide({
      directory: workspace,
      fn: async () => {
        const { createKnowledgeGraph } = await import("../ai/knowledge/index")
        const { refreshDerivedKnowledgeGraph } = await import("../ai/knowledge/derived")

        const graph = createKnowledgeGraph()
        await refreshDerivedKnowledgeGraph(graph, workspace)

        const importNode = graph
          .query({ text: "example.com/acme/pkg/util", limit: 12 })
          .find((node) => node.tags.includes("import") && node.metadata?.path === "main.go")
        const utilFile = graph
          .query({ text: "pkg/util/util.go", limit: 12 })
          .find((node) => node.tags.includes("file") && node.metadata?.path === "pkg/util/util.go")

        expect(importNode).toBeDefined()
        expect(utilFile).toBeDefined()
        expect(importNode?.tags.includes("internal-import")).toBeTrue()
        expect(
          graph
            .getEdges(importNode!.id, "out")
            .some((edge) => edge.relation === "resolves_to" && edge.targetId === utilFile!.id),
        ).toBeTrue()
      },
    })
  })

  test("prefers qualifier-matched imported package for member calls", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-knowledge-derived-go-qualified-call-"))
    cleanup.push(workspace)
    await fs.mkdir(path.join(workspace, "pkg", "one"), { recursive: true })
    await fs.mkdir(path.join(workspace, "pkg", "two"), { recursive: true })
    await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: "go-qualified-call-demo" }), "utf8")
    await fs.writeFile(path.join(workspace, "go.mod"), "module example.com/multi\n", "utf8")
    await fs.writeFile(path.join(workspace, "pkg", "one", "util.go"), "package one\nfunc Helper() {}\n", "utf8")
    await fs.writeFile(path.join(workspace, "pkg", "two", "util.go"), "package two\nfunc Helper() {}\n", "utf8")
    await fs.writeFile(
      path.join(workspace, "main.go"),
      [
        "package main",
        "import \"example.com/multi/pkg/one\"",
        "import \"example.com/multi/pkg/two\"",
        "func process() {",
        "\ttwo.Helper()",
        "}",
      ].join("\n"),
      "utf8",
    )

    const { parseTreeSitterSyntaxTree } = await import("../util/tree-sitter-scope")
    const parseProbe = await parseTreeSitterSyntaxTree({
      filePath: "main.go",
      content: "package main\nfunc probe() {}\n",
    })
    if (!parseProbe) return

    const { Instance } = await import("../project/instance")
    await Instance.reload({
      directory: workspace,
      worktree: workspace,
      project: {
        id: "derived-knowledge-go-qualified-call-project",
        worktree: workspace,
        vcs: "git",
        time: { created: Date.now(), updated: Date.now() },
        sandboxes: [],
      },
    })

    await Instance.provide({
      directory: workspace,
      fn: async () => {
        const { createKnowledgeGraph } = await import("../ai/knowledge/index")
        const { refreshDerivedKnowledgeGraph } = await import("../ai/knowledge/derived")

        const graph = createKnowledgeGraph()
        await refreshDerivedKnowledgeGraph(graph, workspace)

        const processNode = graph
          .query({ text: "process", limit: 12 })
          .find((node) => node.tags.includes("symbol") && node.metadata?.path === "main.go")
        const helperOne = graph
          .query({ text: "Helper", limit: 20 })
          .find((node) => node.tags.includes("symbol") && node.metadata?.path === "pkg/one/util.go")
        const helperTwo = graph
          .query({ text: "Helper", limit: 20 })
          .find((node) => node.tags.includes("symbol") && node.metadata?.path === "pkg/two/util.go")

        expect(processNode).toBeDefined()
        expect(helperOne).toBeDefined()
        expect(helperTwo).toBeDefined()

        const callTargets = graph
          .getEdges(processNode!.id, "out")
          .filter((edge) => edge.relation === "calls")
          .map((edge) => edge.targetId)

        expect(callTargets).toContain(helperTwo!.id)
        expect(callTargets).not.toContain(helperOne!.id)
      },
    })
  })

  test("extracts class-method call and instantiation relations via AST semantics", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-knowledge-derived-ast-"))
    cleanup.push(workspace)
    await fs.mkdir(path.join(workspace, "src"), { recursive: true })
    await fs.writeFile(path.join(workspace, "package.json"), JSON.stringify({ name: "ast-demo" }), "utf8")
    await fs.writeFile(
      path.join(workspace, "src", "service.ts"),
      [
        "class Worker {}",
        "function helper() { return 1 }",
        "export class Service {",
        "  process() {",
        "    helper()",
        "    return new Worker()",
        "  }",
        "}",
      ].join("\n"),
      "utf8",
    )

    const { Instance } = await import("../project/instance")
    await Instance.reload({
      directory: workspace,
      worktree: workspace,
      project: {
        id: "derived-knowledge-ast-project",
        worktree: workspace,
        vcs: "git",
        time: { created: Date.now(), updated: Date.now() },
        sandboxes: [],
      },
    })

    await Instance.provide({
      directory: workspace,
      fn: async () => {
        const { createKnowledgeGraph } = await import("../ai/knowledge/index")
        const { refreshDerivedKnowledgeGraph } = await import("../ai/knowledge/derived")

        const graph = createKnowledgeGraph()
        await refreshDerivedKnowledgeGraph(graph, workspace)

        const processNode = graph
          .query({ text: "process", limit: 8 })
          .find((node) => node.tags.includes("symbol") && node.metadata?.path === "src/service.ts")
        const helperNode = graph
          .query({ text: "helper", limit: 8 })
          .find((node) => node.tags.includes("symbol") && node.metadata?.path === "src/service.ts")
        const workerNode = graph
          .query({ text: "Worker", limit: 8 })
          .find((node) => node.tags.includes("symbol") && node.metadata?.path === "src/service.ts")

        expect(processNode).toBeDefined()
        expect(helperNode).toBeDefined()
        expect(workerNode).toBeDefined()
        expect(
          graph
            .getEdges(processNode!.id, "out")
            .some((edge) => edge.relation === "calls" && edge.targetId === helperNode!.id),
        ).toBeTrue()
        expect(
          graph
            .getEdges(processNode!.id, "out")
            .some((edge) => edge.relation === "instantiates" && edge.targetId === workerNode!.id),
        ).toBeTrue()
      },
    })
  })

  test("extracts dependencies, source imports, and docs", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-knowledge-derived-workspace-"))
    cleanup.push(workspace)
    await fs.mkdir(path.join(workspace, "src"), { recursive: true })
    await fs.mkdir(path.join(workspace, "docs"), { recursive: true })
    await fs.writeFile(
      path.join(workspace, "package.json"),
      JSON.stringify({ dependencies: { zod: "^3.0.0" } }),
      "utf8",
    )
    await fs.writeFile(
      path.join(workspace, "src", "index.ts"),
      'import { z } from "zod"\nimport { helper } from "./helper"\nexport { z, helper }\n',
      "utf8",
    )
    await fs.writeFile(path.join(workspace, "src", "helper.ts"), "export const helper = 1\n", "utf8")
    await fs.writeFile(path.join(workspace, "docs", "README.md"), "# Project Guide\n\nHello", "utf8")

    const { Instance } = await import("../project/instance")
    await Instance.reload({
      directory: workspace,
      worktree: workspace,
      project: {
        id: "derived-knowledge-project",
        worktree: workspace,
        vcs: "git",
        time: { created: Date.now(), updated: Date.now() },
        sandboxes: [],
      },
    })

    await Instance.provide({
      directory: workspace,
      fn: async () => {
        const { createKnowledgeGraph } = await import("../ai/knowledge/index")
        const { refreshDerivedKnowledgeGraph } = await import("../ai/knowledge/derived")

        const graph = createKnowledgeGraph()
        await refreshDerivedKnowledgeGraph(graph, workspace)

        expect(graph.query({ text: "zod" }).length).toBeGreaterThan(0)
        expect(graph.query({ text: "src/index.ts" }).length).toBeGreaterThan(0)
        expect(graph.query({ text: "Project Guide" }).length).toBeGreaterThan(0)

        const sourceNode = graph.query({ text: "src/index.ts", limit: 5 }).find((node) => node.tags.includes("file"))
        const helperImportNode = graph.query({ text: "./helper", limit: 5 }).find((node) => node.tags.includes("import"))
        const helperFileNode = graph.query({ text: "src/helper.ts", limit: 5 }).find((node) => node.tags.includes("file"))
        const dependencyNode = graph.query({ text: "zod", limit: 5 }).find((node) => node.tags.includes("dependency"))

        expect(sourceNode).toBeDefined()
        expect(helperImportNode).toBeDefined()
        expect(helperFileNode).toBeDefined()
        expect(dependencyNode).toBeDefined()
        expect(
          graph.getEdges(helperImportNode!.id, "out").some((edge) => edge.relation === "resolves_to" && edge.targetId === helperFileNode!.id),
        ).toBeTrue()
        expect(
          graph.getEdges(sourceNode!.id, "out").some((edge) => edge.relation === "uses_dependency" && edge.targetId === dependencyNode!.id),
        ).toBeTrue()
      },
    })
  })
})