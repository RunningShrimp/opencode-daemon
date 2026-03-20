import fs from "node:fs/promises"
import path from "node:path"
import { fileURLToPath } from "node:url"
import { Language, Parser, type Node as TreeSitterNode } from "web-tree-sitter"
import { Log } from "./log"

const log = Log.create({ service: "tree-sitter-scope" })

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

const LANGUAGE_PACKAGES: Record<SupportedLanguage, string> = {
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

function inferLanguageFromExtension(ext: string): SupportedLanguage | null {
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

const localNodeModulesDir = fileURLToPath(new URL("../../node_modules/", import.meta.url))
let parserRuntime: Promise<void> | undefined
const languageCache = new Map<string, Promise<Language>>()
const parserCache = new Map<string, Promise<Parser>>()

export interface SyntaxScopedRange {
  startIndex: number
  endIndex: number
  startLine: number
  endLine: number
  nodeType: string
  syntaxSummary: string
  syntaxHint: string
}

export interface SyntaxFragmentMatch {
  startIndex: number
  endIndex: number
  startLine: number
  endLine: number
  nodeType: string
  syntaxSummary: string
  syntaxHint: string
}

export interface SyntaxNodeHint {
  startLine: number
  endLine: number
  nodeType: string
  syntaxSummary: string
  syntaxHint: string
}

export interface TreeSitterParseResult {
  language: SupportedLanguage
  rootNode: TreeSitterNode
}

function resolveWasmAsset(asset: string) {
  if (asset.startsWith("file://")) return fileURLToPath(asset)
  if (asset.startsWith("/") || /^[a-z]:/i.test(asset)) return asset
  const url = new URL(asset, import.meta.url)
  return fileURLToPath(url)
}

async function initParserRuntime() {
  if (!parserRuntime) {
    parserRuntime = (async () => {
      const { default: treeWasm } = await import("web-tree-sitter/tree-sitter.wasm" as string, {
        with: { type: "wasm" },
      })
      const treePath = resolveWasmAsset(treeWasm)
      await Parser.init({
        locateFile() {
          return treePath
        },
      })
    })()
  }
  return parserRuntime
}

async function pathExists(target: string) {
  try {
    await fs.access(target)
    return true
  } catch {
    return false
  }
}

async function ensureLanguagePackagePath(packageName: string): Promise<string | null> {
  const localPath = path.join(localNodeModulesDir, packageName)
  if (await pathExists(localPath)) {
    return localPath
  }

  const { ModuleLoader } = await import("./module-loader")
  const loader = ModuleLoader.getInstance()
  const installedPath = loader.getNodeModulesPath(packageName)
  if (await pathExists(installedPath)) {
    return installedPath
  }

  loader.installInBackground({
    name: packageName,
    version: "latest",
    downloadUrls: {
      official: "https://registry.npmjs.org",
      china: "https://registry.npmmirror.com",
    },
    type: "wasm",
  })
  log.info("scheduled tree-sitter language install in background", { package: packageName })
  return null
}

async function resolveLanguageWasmPath(
  packagePath: string,
  language: SupportedLanguage,
  filePath: string,
): Promise<string | null> {
  const entries = await fs.readdir(packagePath)
  const wasmFiles = entries.filter((entry) => entry.endsWith(".wasm"))
  if (wasmFiles.length === 0) {
    return null
  }

  const ext = path.extname(filePath).toLowerCase()
  const preferred = [
    language === "typescript" && ext === ".tsx" ? "tree-sitter-tsx.wasm" : undefined,
    language === "typescript" ? "tree-sitter-typescript.wasm" : undefined,
    `tree-sitter-${language}.wasm`,
  ].filter((value): value is string => Boolean(value))

  for (const candidate of preferred) {
    if (wasmFiles.includes(candidate)) {
      return path.join(packagePath, candidate)
    }
  }

  return path.join(packagePath, wasmFiles[0])
}

async function loadLanguage(language: SupportedLanguage, filePath: string): Promise<Language | null> {
  const packageName = LANGUAGE_PACKAGES[language]
  const packagePath = await ensureLanguagePackagePath(packageName)
  if (!packagePath) {
    return null
  }

  const wasmPath = await resolveLanguageWasmPath(packagePath, language, filePath)
  if (!wasmPath) {
    return null
  }

  const key = `${language}:${wasmPath}`
  const cached = languageCache.get(key)
  if (cached) {
    return cached
  }

  const next = Language.load(wasmPath).catch((error) => {
    languageCache.delete(key)
    throw error
  })
  languageCache.set(key, next)
  return next
}

async function scheduleLanguageInstallInBackground(language: SupportedLanguage) {
  const packageName = LANGUAGE_PACKAGES[language]
  if (scheduledBackgroundLanguageChecks.has(packageName)) {
    return
  }

  scheduledBackgroundLanguageChecks.add(packageName)

  try {
    const localPath = path.join(localNodeModulesDir, packageName)
    if (await pathExists(localPath)) {
      return
    }

    const { ModuleLoader } = await import("./module-loader")
    const loader = ModuleLoader.getInstance()
    const installedPath = loader.getNodeModulesPath(packageName)
    if (await pathExists(installedPath)) {
      return
    }

    loader.installInBackground({
      name: packageName,
      version: "latest",
      downloadUrls: {
        official: "https://registry.npmjs.org",
        china: "https://registry.npmmirror.com",
      },
      type: "wasm",
    })
    log.info("scheduled mainstream tree-sitter language install in background", { package: packageName, language })
  } catch (error) {
    log.warn("failed to schedule mainstream tree-sitter install", { language, error: String(error) })
  }
}

export async function preloadMainstreamTreeSitterLanguagesInBackground() {
  await Promise.all(MAINSTREAM_TREE_SITTER_LANGUAGES.map((language) => scheduleLanguageInstallInBackground(language)))
}

export function resetTreeSitterLanguagePreloadStateForTest() {
  scheduledBackgroundLanguageChecks.clear()
}

async function getParser(filePath: string): Promise<{ parser: Parser; language: SupportedLanguage } | null> {
  const ext = path.extname(filePath).slice(1)
  const language = inferLanguageFromExtension(ext)
  if (!language) {
    return null
  }

  await initParserRuntime()
  const loadedLanguage = await loadLanguage(language, filePath)
  if (!loadedLanguage) {
    return null
  }

  const cacheKey = `${language}:${loadedLanguage.name ?? "unknown"}:${path.extname(filePath).toLowerCase()}`
  let parserPromise = parserCache.get(cacheKey)
  if (!parserPromise) {
    parserPromise = Promise.resolve().then(() => {
      const parser = new Parser()
      parser.setLanguage(loadedLanguage)
      return parser
    })
    parserCache.set(cacheKey, parserPromise)
  }

  return {
    parser: await parserPromise,
    language,
  }
}

export function isTreeSitterLanguageSupported(filePath: string): boolean {
  const ext = path.extname(filePath).slice(1)
  return Boolean(inferLanguageFromExtension(ext))
}

export async function parseTreeSitterSyntaxTree(input: {
  filePath: string
  content: string
}): Promise<TreeSitterParseResult | undefined> {
  const loaded = await getParser(input.filePath).catch(() => null)
  if (!loaded) return undefined

  try {
    const tree = loaded.parser.parse(input.content)
    if (!tree?.rootNode) return undefined
    return {
      language: loaded.language,
      rootNode: tree.rootNode,
    }
  } catch {
    return undefined
  }
}

function normalizeText(text: string) {
  return text.replace(/\r\n/g, "\n")
}

function countOccurrences(haystack: string, needle: string) {
  if (!needle) return 0
  let count = 0
  let from = 0
  while (true) {
    const index = haystack.indexOf(needle, from)
    if (index === -1) return count
    count += 1
    from = index + needle.length
  }
}

function collectAncestors(node: TreeSitterNode | null) {
  const ancestors: TreeSitterNode[] = []
  let current = node
  while (current) {
    ancestors.push(current)
    current = current.parent
  }
  return ancestors
}

function dedupeNodes(nodes: TreeSitterNode[]) {
  const seen = new Set<number>()
  return nodes.filter((node) => {
    if (seen.has(node.id)) return false
    seen.add(node.id)
    return true
  })
}

function isUsefulHintNode(node: TreeSitterNode) {
  if (!node.isNamed) return false
  if (node.type === "program" || node.type === "document" || node.type === "source_file") return false
  if (node.namedChildCount === 0 && node.startPosition.row === node.endPosition.row) return false
  return true
}

function sanitizeSyntaxToken(text: string) {
  const compact = text.trim().replace(/\s+/g, "_").replace(/[^A-Za-z0-9_.$:-]/g, "_")
  const normalized = compact.replace(/_+/g, "_").replace(/^_+|_+$/g, "")
  if (!normalized) return null
  return normalized.slice(0, 40)
}

function nodeText(node: TreeSitterNode, content: string) {
  return content.slice(node.startIndex, node.endIndex)
}

function namedChildren(node: TreeSitterNode) {
  const children: TreeSitterNode[] = []
  for (let index = 0; index < node.namedChildCount; index++) {
    const child = node.namedChild(index)
    if (child) children.push(child)
  }
  return children
}

function firstNamedChildOfType(node: TreeSitterNode, type: string) {
  return namedChildren(node).find((child) => child.type === type) ?? null
}

function namedChildrenOfType(node: TreeSitterNode, type: string) {
  return namedChildren(node).filter((child) => child.type === type)
}

const IDENTIFIER_LIKE_TYPES = new Set([
  "identifier",
  "word",
  "name",
  "constant",
  "variable_name",
  "type_identifier",
  "constructor_identifier",
  "constant_identifier",
  "property_identifier",
  "field_identifier",
  "shorthand_property_identifier",
  "shorthand_property_identifier_pattern",
  "namespace_identifier",
  "package_identifier",
  "module_identifier",
  "label_name",
])

const BODY_LIKE_TYPES = new Set([
  "block",
  "statement_block",
  "compound_statement",
  "do_group",
  "suite",
  "body",
  "class_body",
  "object",
  "program",
  "source_file",
  "document",
  "consequence",
  "alternative",
  "then_clause",
  "else_clause",
  "elif_clause",
])

const BODY_LIKE_TYPE_PATTERN = /(?:^|_)(?:block|body|suite|group|list)$/

const MAINSTREAM_TREE_SITTER_LANGUAGES: SupportedLanguage[] = [
  "typescript",
  "javascript",
  "python",
  "bash",
  "go",
  "rust",
  "java",
  "c",
  "cpp",
  "csharp",
  "php",
  "ruby",
  "html",
  "css",
  "json",
  "yaml",
]

const scheduledBackgroundLanguageChecks = new Set<string>()

function isBodyLikeType(type: string) {
  return BODY_LIKE_TYPES.has(type) || BODY_LIKE_TYPE_PATTERN.test(type)
}

function hasSameSpan(a: TreeSitterNode, b: TreeSitterNode) {
  return a.startIndex === b.startIndex && a.endIndex === b.endIndex
}

function normalizeSemanticNode(node: TreeSitterNode) {
  let current = node
  let visited = 0

  while (visited < 8) {
    visited += 1

    if (!isBodyLikeType(current.type)) {
      return current
    }

    const sameSpanChild = namedChildren(current).find(
      (child) => isUsefulHintNode(child) && hasSameSpan(child, current) && !isBodyLikeType(child.type),
    ) ?? namedChildren(current).find((child) => isUsefulHintNode(child) && hasSameSpan(child, current))

    if (sameSpanChild) {
      current = sameSpanChild
      continue
    }

    if (current.parent && isUsefulHintNode(current.parent) && hasSameSpan(current, current.parent)) {
      current = current.parent
      continue
    }

    return current
  }

  return current
}

const DECLARATION_TYPE_PATTERN =
  /(function|method|class|interface|enum|struct|trait|protocol|namespace|module|record|object|type|alias|definition|declaration)$/

const CONDITION_TYPE_PATTERN =
  /(if|while|until|switch|match|when|guard|condition|conditional|assert|catch|except|case|clause)$/

const LOOP_TYPE_PATTERN = /(for|foreach|loop|repeat|iteration)/

function childForFieldNames(node: TreeSitterNode, fieldNames: string[]) {
  for (const fieldName of fieldNames) {
    const child = node.childForFieldName(fieldName)
    if (child) {
      return child
    }
  }
  return null
}

function firstIdentifierLikeChild(node: TreeSitterNode) {
  const queue: TreeSitterNode[] = [...namedChildren(node)]
  let visited = 0

  while (queue.length > 0 && visited < 64) {
    const current = queue.shift()
    if (!current) break
    visited += 1

    if (IDENTIFIER_LIKE_TYPES.has(current.type)) {
      return current
    }

    for (const child of namedChildren(current)) {
      queue.push(child)
    }
  }

  return null
}

function preferredSignalChild(node: TreeSitterNode, preferredTypes: string[]) {
  const direct = namedChildren(node).find((child) => preferredTypes.includes(child.type))
  if (direct) return direct

  const queue: TreeSitterNode[] = [...namedChildren(node)]
  let visited = 0
  while (queue.length > 0 && visited < 64) {
    const current = queue.shift()
    if (!current) break
    visited += 1
    if (preferredTypes.includes(current.type)) {
      return current
    }
    for (const child of namedChildren(current)) {
      queue.push(child)
    }
  }
  return null
}

function summarizeDeclarationNode(node: TreeSitterNode, content: string) {
  const named =
    childForFieldNames(node, ["name", "declarator", "label", "key", "member", "field", "function", "class"] ) ??
    firstIdentifierLikeChild(node)
  return named ? sanitizeSyntaxToken(nodeText(named, content)) : null
}

function summarizeConditionNode(node: TreeSitterNode, content: string) {
  const condition =
    childForFieldNames(node, ["condition", "subject", "value", "left", "right", "expression", "guard", "test"]) ??
    preferredSignalChild(node, [
      "comparison_operator",
      "binary_expression",
      "comparison_expression",
      "logical_expression",
      "relational_expression",
      "unary_expression",
      "update_expression",
      "call_expression",
      "invocation_expression",
      "member_expression",
      "field_expression",
      "selector_expression",
      "qualified_identifier",
      "scoped_identifier",
      "command",
      "parenthesized_expression",
      "expression_statement",
      "string",
      "simple_expansion",
      "identifier",
      "word",
    ]) ??
    namedChildren(node).find((child) => !isBodyLikeType(child.type))
  return condition ? sanitizeSyntaxToken(nodeText(condition, content)) : null
}

function summarizeLoopNode(node: TreeSitterNode, content: string) {
  const iterator = childForFieldNames(node, ["left", "pattern", "name", "variable", "iterator", "item"]) ??
    firstNamedChildOfType(node, "variable_name") ??
    firstIdentifierLikeChild(node)
  const iterable = childForFieldNames(node, ["right", "iterable", "collection", "value", "condition"]) ??
    preferredSignalChild(node, ["array", "list", "tuple", "identifier", "word", "string", "command", "binary_expression"])

  return [
    iterator ? sanitizeSyntaxToken(nodeText(iterator, content)) : null,
    iterable ? sanitizeSyntaxToken(nodeText(iterable, content)) : null,
  ]
    .filter((value): value is string => Boolean(value))
    .join("_") || null
}

function summarizeCaseLikeNode(node: TreeSitterNode, content: string) {
  const subject = childForFieldNames(node, ["value", "subject", "condition", "name"]) ??
    namedChildren(node).find((child) => !isBodyLikeType(child.type) && child.type !== "case_item")
  const labels = namedChildren(node)
    .filter((child) => ["case_item", "switch_case", "case_clause", "when_clause"].includes(child.type))
    .map((child) => firstIdentifierLikeChild(child) ?? preferredSignalChild(child, ["string", "word", "number", "identifier"]))
    .map((child) => (child ? sanitizeSyntaxToken(nodeText(child, content)) : null))
    .filter((value): value is string => Boolean(value))
    .slice(0, 2)

  return [subject ? sanitizeSyntaxToken(nodeText(subject, content)) : null, ...labels]
    .filter((value): value is string => Boolean(value))
    .join("_") || null
}

function summarizeGenericNode(node: TreeSitterNode, content: string) {
  if (DECLARATION_TYPE_PATTERN.test(node.type)) {
    return summarizeDeclarationNode(node, content)
  }

  if (LOOP_TYPE_PATTERN.test(node.type)) {
    return summarizeLoopNode(node, content)
  }

  if (node.type.includes("case") || node.type.includes("switch") || node.type.includes("match")) {
    return summarizeCaseLikeNode(node, content)
  }

  if (CONDITION_TYPE_PATTERN.test(node.type)) {
    return summarizeConditionNode(node, content)
  }

  return null
}

function summarizeCommandNode(node: TreeSitterNode, content: string): string | null {
  const commandName = firstNamedChildOfType(node, "command_name")
  const commandNameToken = commandName ? sanitizeSyntaxToken(nodeText(commandName, content)) : null
  const args = namedChildren(node)
    .filter((child) => child.type !== "command_name")
    .map((child) => sanitizeSyntaxToken(nodeText(child, content)))
    .filter((value): value is string => Boolean(value))
    .slice(0, 2)

  return [commandNameToken, ...args].filter((value): value is string => Boolean(value)).join("_") || null
}

function summarizeShellControlNode(node: TreeSitterNode, content: string): string | null {
  switch (node.type) {
    case "function_definition": {
      const name = firstNamedChildOfType(node, "word")
      return name ? sanitizeSyntaxToken(nodeText(name, content)) : null
    }
    case "if_statement":
    case "elif_clause":
    case "while_statement":
    case "until_statement": {
      const condition = firstNamedChildOfType(node, "command")
      return condition ? summarizeCommandNode(condition, content) : null
    }
    case "for_statement": {
      const iterator = firstNamedChildOfType(node, "variable_name")
      const words = namedChildrenOfType(node, "word")
        .map((child) => sanitizeSyntaxToken(nodeText(child, content)))
        .filter((value): value is string => Boolean(value))
        .slice(0, 2)
      return [iterator ? sanitizeSyntaxToken(nodeText(iterator, content)) : null, ...words]
        .filter((value): value is string => Boolean(value))
        .join("_")
    }
    case "case_statement": {
      const subject = namedChildren(node)
        .find((child) => ["string", "simple_expansion", "word"].includes(child.type))
      const labels = namedChildrenOfType(node, "case_item")
        .map((item) => firstNamedChildOfType(item, "word"))
        .map((child) => (child ? sanitizeSyntaxToken(nodeText(child, content)) : null))
        .filter((value): value is string => Boolean(value))
        .slice(0, 2)
      return [subject ? sanitizeSyntaxToken(nodeText(subject, content)) : null, ...labels]
        .filter((value): value is string => Boolean(value))
        .join("_")
    }
    case "case_item": {
      const label = firstNamedChildOfType(node, "word")
      return label ? sanitizeSyntaxToken(nodeText(label, content)) : null
    }
    case "command":
      return summarizeCommandNode(node, content)
    case "compound_statement": {
      const firstChild = namedChildren(node)[0]
      return firstChild ? buildTreeSitterSyntaxSummary(firstChild, content).replace(/^[^:]+:/, "") : null
    }
    default:
      return null
  }
}

function extractNodeToken(node: TreeSitterNode, content: string): string | null {
  const specialized = summarizeShellControlNode(node, content)
  if (specialized) {
    return specialized
  }

  const generic = summarizeGenericNode(node, content)
  if (generic) {
    return generic
  }

  const queue: Array<{ node: TreeSitterNode; depth: number }> = [{ node, depth: 0 }]
  let visited = 0

  while (queue.length > 0 && visited < 48) {
    const current = queue.shift()
    if (!current) break
    visited += 1

    const text = content.slice(current.node.startIndex, current.node.endIndex)
    const isSmallLeaf = current.node.namedChildCount === 0 && current.node.endPosition.row === current.node.startPosition.row
    const isShortInlineNode = text.length > 0 && text.length <= 48 && current.node.endPosition.row === current.node.startPosition.row

    if (current.depth > 0 && (isSmallLeaf || isShortInlineNode)) {
      const token = sanitizeSyntaxToken(text)
      if (token && token !== current.node.type) {
        return token
      }
    }

    if (current.depth >= 3) {
      continue
    }

    for (let index = 0; index < current.node.namedChildCount; index++) {
      const child = current.node.namedChild(index)
      if (child) {
        queue.push({ node: child, depth: current.depth + 1 })
      }
    }
  }

  return null
}

function formatSyntaxHintSegment(node: TreeSitterNode, content: string): string {
  const semanticNode = normalizeSemanticNode(node)
  const token = extractNodeToken(semanticNode, content)
  return token ? `${semanticNode.type}(${token})` : semanticNode.type
}

export function buildTreeSitterSyntaxSummary(node: TreeSitterNode, content: string): string {
  const semanticNode = normalizeSemanticNode(node)
  const token = extractNodeToken(semanticNode, content)
  return token ? `${semanticNode.type}:${token}` : semanticNode.type
}

export function buildTreeSitterSyntaxHint(node: TreeSitterNode, content: string) {
  const segments = dedupeNodes(collectAncestors(normalizeSemanticNode(node)).map(normalizeSemanticNode))
    .reverse()
    .filter(isUsefulHintNode)
    .map((item) => formatSyntaxHintSegment(item, content))

  return segments.join(">") || node.type
}

export function matchesTreeSitterSyntaxHint(
  expected: string | undefined,
  actual: Pick<SyntaxScopedRange, "nodeType" | "syntaxHint"> | null,
) {
  if (!expected) return true
  if (!actual) return false
  if (expected === actual.nodeType || expected === actual.syntaxHint) return true
  if (actual.syntaxHint.startsWith(`${expected}>`)) return true
  if (actual.syntaxHint.endsWith(`>${expected}`)) return true
  if (actual.syntaxHint.includes(`>${expected}>`)) return true
  return false
}

const TREE_SITTER_SYNTAX_HINT_PATTERN =
  /^(?:[A-Za-z0-9_.$:-]+(?:\([A-Za-z0-9_.$:-]+\))?)(?:>(?:[A-Za-z0-9_.$:-]+(?:\([A-Za-z0-9_.$:-]+\))?))*$/

export function looksLikeTreeSitterSyntaxHint(value: string | undefined) {
  if (!value) return false
  return TREE_SITTER_SYNTAX_HINT_PATTERN.test(value.trim())
}

function collectCandidateNodes(root: TreeSitterNode) {
  const stack = [root]
  const nodes: TreeSitterNode[] = []

  while (stack.length > 0) {
    const node = stack.pop()
    if (!node) continue
    if (isUsefulHintNode(node)) {
      nodes.push(node)
    }
    for (let index = node.namedChildCount - 1; index >= 0; index--) {
      const child = node.namedChild(index)
      if (child) stack.push(child)
    }
  }

  return dedupeNodes(nodes.map(normalizeSemanticNode))
}

export async function findTreeSitterContextRange(input: {
  filePath: string
  content: string
  syntaxHint: string
  startLine?: number
  endLine?: number
  afterLine?: number
}): Promise<SyntaxScopedRange | null> {
  try {
    const loaded = await getParser(input.filePath)
    if (!loaded) {
      return null
    }

    const tree = loaded.parser.parse(input.content)
    if (!tree) {
      return null
    }

    try {
      const startLine = input.startLine ?? 1
      const endLine = input.endLine ?? Number.MAX_SAFE_INTEGER
      const afterLine = input.afterLine ?? startLine
      const candidates = collectCandidateNodes(tree.rootNode)
        .map((node) => ({
          startIndex: node.startIndex,
          endIndex: node.endIndex,
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          nodeType: node.type,
          syntaxSummary: buildTreeSitterSyntaxSummary(node, input.content),
          syntaxHint: buildTreeSitterSyntaxHint(node, input.content),
        }))
        .filter((candidate) => candidate.startLine >= startLine)
        .filter((candidate) => candidate.endLine <= endLine)
        .filter((candidate) => candidate.startLine >= afterLine)
        .filter((candidate) => matchesTreeSitterSyntaxHint(input.syntaxHint, candidate))
        .sort((a, b) => {
          if (a.startLine !== b.startLine) return a.startLine - b.startLine
          const aSpan = a.endIndex - a.startIndex
          const bSpan = b.endIndex - b.startIndex
          return aSpan - bSpan
        })

      return candidates[0] ?? null
    } finally {
      tree.delete()
    }
  } catch (error) {
    log.warn("failed to resolve tree-sitter context", { filePath: input.filePath, error: String(error) })
    return null
  }
}

function lineNumberAtIndex(content: string, index: number) {
  let line = 1
  for (let cursor = 0; cursor < index && cursor < content.length; cursor++) {
    if (content[cursor] === "\n") {
      line += 1
    }
  }
  return line
}

function firstNonWhitespaceColumn(line: string | undefined) {
  if (!line) return 0
  const match = line.match(/\S/)
  return match ? match.index ?? 0 : 0
}

function lastNonWhitespaceColumn(line: string | undefined) {
  if (!line) return 0
  for (let index = line.length - 1; index >= 0; index--) {
    if (/\S/.test(line[index])) {
      return index
    }
  }
  return 0
}

export async function findTreeSitterFragmentMatch(input: {
  filePath: string
  content: string
  searchText: string
  startLine?: number
  endLine?: number
  afterLine?: number
}): Promise<SyntaxFragmentMatch | null> {
  try {
    const loaded = await getParser(input.filePath)
    if (!loaded) {
      return null
    }

    const target = normalizeText(input.searchText)
    if (!target) {
      return null
    }

    const tree = loaded.parser.parse(input.content)
    if (!tree) {
      return null
    }

    try {
      const startLine = input.startLine ?? 1
      const endLine = input.endLine ?? Number.MAX_SAFE_INTEGER
      const afterLine = input.afterLine ?? startLine
      const candidates = collectCandidateNodes(tree.rootNode)
        .map((node) => {
          const nodeText = normalizeText(input.content.slice(node.startIndex, node.endIndex))
          const exact = nodeText === target
          const occurrenceCount = exact ? 1 : countOccurrences(nodeText, target)
          if (!exact && occurrenceCount !== 1) {
            return null
          }

          const relativeIndex = exact ? 0 : nodeText.indexOf(target)
          if (relativeIndex < 0) {
            return null
          }

          const absoluteStart = node.startIndex + relativeIndex
          const absoluteEnd = absoluteStart + target.length
          const fragmentStartLine = lineNumberAtIndex(input.content, absoluteStart)
          const fragmentEndLine = lineNumberAtIndex(input.content, absoluteEnd)

          return {
            startIndex: absoluteStart,
            endIndex: absoluteEnd,
            startLine: fragmentStartLine,
            endLine: fragmentEndLine,
            nodeType: node.type,
            syntaxSummary: buildTreeSitterSyntaxSummary(node, input.content),
            syntaxHint: buildTreeSitterSyntaxHint(node, input.content),
            containerStartLine: node.startPosition.row + 1,
            containerEndLine: node.endPosition.row + 1,
            exact,
            span: node.endIndex - node.startIndex,
          }
        })
        .filter((candidate): candidate is NonNullable<typeof candidate> => Boolean(candidate))
        .filter((candidate) => candidate.containerStartLine >= startLine)
        .filter((candidate) => candidate.containerEndLine <= endLine)
        .filter((candidate) => candidate.startLine >= afterLine)
        .sort((a, b) => {
          if (a.startLine !== b.startLine) return a.startLine - b.startLine
          if (a.exact !== b.exact) return a.exact ? -1 : 1
          return a.span - b.span
        })

      const match = candidates[0]
      if (!match) {
        return null
      }

      return {
        startIndex: match.startIndex,
        endIndex: match.endIndex,
        startLine: match.startLine,
        endLine: match.endLine,
        nodeType: match.nodeType,
        syntaxSummary: match.syntaxSummary,
        syntaxHint: match.syntaxHint,
      }
    } finally {
      tree.delete()
    }
  } catch (error) {
    log.warn("failed to resolve tree-sitter fragment match", { filePath: input.filePath, error: String(error) })
    return null
  }
}

export async function findTreeSitterSyntaxHints(input: {
  filePath: string
  content: string
  startLine: number
  endLine: number
  limit?: number
}): Promise<SyntaxNodeHint[]> {
  try {
    const loaded = await getParser(input.filePath)
    if (!loaded) {
      return []
    }

    const lines = input.content.split("\n")
    const startRow = Math.max(0, input.startLine - 1)
    const endRow = Math.max(0, input.endLine - 1)
    const startColumn = firstNonWhitespaceColumn(lines[startRow])
    const endColumn = lastNonWhitespaceColumn(lines[endRow])
    const tree = loaded.parser.parse(input.content)
    if (!tree) {
      return []
    }

    try {
      const root = tree.rootNode
      const startNode = root.namedDescendantForPosition({ row: startRow, column: startColumn })
      const endNode = root.namedDescendantForPosition({ row: endRow, column: endColumn })
      const hints = dedupeNodes([...collectAncestors(startNode), ...collectAncestors(endNode)].map(normalizeSemanticNode))
        .filter(isUsefulHintNode)
        .filter((node) => node.startPosition.row <= endRow && node.endPosition.row >= startRow)
        .sort((a, b) => {
          const aSpan = a.endIndex - a.startIndex
          const bSpan = b.endIndex - b.startIndex
          return aSpan - bSpan
        })
        .slice(0, input.limit ?? 6)
        .map((node) => ({
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          nodeType: node.type,
          syntaxSummary: buildTreeSitterSyntaxSummary(node, input.content),
          syntaxHint: buildTreeSitterSyntaxHint(node, input.content),
        }))

      return hints
    } finally {
      tree.delete()
    }
  } catch (error) {
    log.warn("failed to derive tree-sitter syntax hints", { filePath: input.filePath, error: String(error) })
    return []
  }
}

export async function findTreeSitterScopedRange(input: {
  filePath: string
  content: string
  oldString: string
  startLine: number
  endLine: number
}): Promise<SyntaxScopedRange | null> {
  try {
    const loaded = await getParser(input.filePath)
    if (!loaded) {
      return null
    }

    const lines = input.content.split("\n")
    const startRow = Math.max(0, input.startLine - 1)
    const endRow = Math.max(0, input.endLine - 1)
    const endColumn = lines[endRow]?.length ?? 0
    const tree = loaded.parser.parse(input.content)
    if (!tree) {
      return null
    }

    try {
      const target = normalizeText(input.oldString)
      const candidates = collectCandidateNodes(tree.rootNode)
        .map((node) => ({
          node,
          text: normalizeText(input.content.slice(node.startIndex, node.endIndex)),
          startLine: node.startPosition.row + 1,
          endLine: node.endPosition.row + 1,
          span: node.endIndex - node.startIndex,
        }))
        .filter((candidate) => candidate.endLine >= input.startLine)
        .filter((candidate) => candidate.startLine <= input.endLine)
        .sort((a, b) => a.span - b.span)

      const exactMatch = candidates.find(
        (candidate) =>
          candidate.text === target && candidate.startLine >= input.startLine && candidate.endLine <= input.endLine,
      )
      if (exactMatch) {
        return {
          startIndex: exactMatch.node.startIndex,
          endIndex: exactMatch.node.endIndex,
          startLine: exactMatch.startLine,
          endLine: exactMatch.endLine,
          nodeType: exactMatch.node.type,
          syntaxSummary: buildTreeSitterSyntaxSummary(exactMatch.node, input.content),
          syntaxHint: buildTreeSitterSyntaxHint(exactMatch.node, input.content),
        }
      }

      const containingMatch = candidates.find(
        (candidate) =>
          candidate.startLine <= input.startLine &&
          candidate.endLine >= input.endLine &&
          candidate.text.includes(target) &&
          countOccurrences(candidate.text, target) === 1,
      )
      if (containingMatch) {
        return {
          startIndex: containingMatch.node.startIndex,
          endIndex: containingMatch.node.endIndex,
          startLine: containingMatch.startLine,
          endLine: containingMatch.endLine,
          nodeType: containingMatch.node.type,
          syntaxSummary: buildTreeSitterSyntaxSummary(containingMatch.node, input.content),
          syntaxHint: buildTreeSitterSyntaxHint(containingMatch.node, input.content),
        }
      }

      return null
    } finally {
      tree.delete()
    }
  } catch (error) {
    log.warn("failed to derive tree-sitter scope", { filePath: input.filePath, error: String(error) })
    return null
  }
}