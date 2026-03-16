import fs from "node:fs/promises"
import path from "node:path"
import { KnowledgeGraph } from "./index"
import { Instance } from "@/project/instance"
import { Log } from "@/util/log"
import { parseTreeSitterSyntaxTree } from "@/util/tree-sitter-scope"

const log = Log.create({ service: "knowledge.derived" })
const MAX_SOURCE_FILES = 150
const IGNORE = new Set(["node_modules", ".git", "dist", "build", ".next", ".sst", "coverage"])
const SOURCE_EXTENSIONS = [
  ".ts",
  ".tsx",
  ".js",
  ".jsx",
  ".mjs",
  ".cjs",
  ".py",
  ".rs",
  ".go",
  ".java",
  ".c",
  ".h",
  ".cpp",
  ".cc",
  ".cxx",
  ".hpp",
  ".cs",
  ".rb",
  ".php",
  ".scala",
  ".swift",
]

export async function refreshDerivedKnowledgeGraph(graph: KnowledgeGraph, rootDir = Instance.project?.worktree ?? Instance.worktree) {
  const projectName = path.basename(rootDir)
  const projectNode = ensureNode(graph, `project:${projectName}`, {
    type: "entity",
    name: projectName,
    content: `Derived project knowledge for ${projectName}`,
    tags: ["project", "derived"],
    metadata: { kind: "project", rootDir },
  })

  await ingestPackageJson(graph, projectNode, rootDir)
  await ingestSources(graph, projectNode, rootDir)
  await ingestDocs(graph, projectNode, rootDir)
}

async function ingestPackageJson(graph: KnowledgeGraph, projectNode: string, rootDir: string) {
  const file = path.join(rootDir, "package.json")
  const content = await fs.readFile(file, "utf8").catch(() => undefined)
  if (!content) return
  const parsed = JSON.parse(content) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> }
  for (const [name, version] of Object.entries({ ...(parsed.dependencies ?? {}), ...(parsed.devDependencies ?? {}) }).slice(0, 80)) {
    const dep = ensureNode(graph, `dependency:${name}`, {
      type: "entity",
      name,
      content: `${name}@${version}`,
      tags: ["dependency"],
      metadata: { version },
    })
    ensureEdge(graph, projectNode, dep, "depends_on", { version })
  }
}

async function ingestSources(graph: KnowledgeGraph, projectNode: string, rootDir: string) {
  const files = await collectFiles(rootDir, SOURCE_EXTENSIONS).then((result) => result.slice(0, MAX_SOURCE_FILES))
  const sourceIndex = buildSourceIndex(rootDir, files)
  const importContext = await buildImportResolveContext(rootDir)
  const fileNodes = new Map<string, string>()
  const contents = new Map<string, string>()
  const semanticsByFile = new Map<string, SourceSemanticSnapshot>()
  const symbolNodesByFile = new Map<string, Map<string, string>>()
  const exportedSymbolNodesByFile = new Map<string, Map<string, string>>()
  const importedInternalFilesByFile = new Map<string, Set<string>>()
  const importedInternalHintsByFile = new Map<string, Map<string, Set<string>>>()
  const importedSymbolAliasHintsByFile = new Map<string, Map<string, Array<{ file: string; imported: string }>>>()
  const reExportAliasHintsByFile = new Map<string, Map<string, Array<{ file: string; imported: string }>>>()
  const reExportAllHintsByFile = new Map<string, Set<string>>()

  for (const file of files) {
    const rel = path.relative(rootDir, file).replaceAll("\\", "/")
    const content = await fs.readFile(file, "utf8").catch(() => undefined)
    if (!content) continue
    const fileNode = ensureNode(graph, `file:${rel}`, {
      type: "entity",
      name: rel,
      content: rel,
      tags: ["file", "source"],
      metadata: { path: rel },
    })
    ensureEdge(graph, projectNode, fileNode, "contains")
    fileNodes.set(rel, fileNode)
    contents.set(rel, content)
  }

  for (const [rel, content] of contents) {
    const fileNode = fileNodes.get(rel)
    if (!fileNode) continue
    const semantics = await extractSourceSemantics(rel, content).catch(() => undefined)
    if (semantics) semanticsByFile.set(rel, semantics)

    const resolvedImportsBySpecifier = new Map<string, string>()
    const importSpecifiers = semantics?.imports?.length ? semantics.imports : extractImports(content)
    for (const specifier of importSpecifiers.slice(0, 24)) {
      const resolvedInternal = resolveInternalImport(rel, specifier, sourceIndex, importContext)
      const isInternalImport = isInternalImportSpecifier(specifier) || Boolean(resolvedInternal)
      const importNode = ensureNode(graph, `import:${rel}:${specifier}`, {
        type: isInternalImport ? "entity" : "concept",
        name: specifier,
        content: specifier,
        tags: [isInternalImport ? "internal-import" : "external-import", "import"],
        metadata: { path: rel, specifier },
      })
      ensureEdge(graph, fileNode, importNode, "imports")

      if (isInternalImport) {
        const resolved = resolvedInternal
        if (!resolved) continue
        resolvedImportsBySpecifier.set(specifier, resolved)
        let imported = importedInternalFilesByFile.get(rel)
        if (!imported) {
          imported = new Set<string>()
          importedInternalFilesByFile.set(rel, imported)
        }
        imported.add(resolved)
        addImportedInternalHints(importedInternalHintsByFile, rel, specifier, resolved)
        const targetNode = fileNodes.get(resolved)
        if (targetNode) {
          ensureEdge(graph, importNode, targetNode, "resolves_to")
        }
        continue
      }

      const dependencyNode = ensureNode(graph, `dependency:${specifier}`, {
        type: "entity",
        name: specifier,
        content: specifier,
        tags: ["dependency"],
        metadata: {},
      })
      ensureEdge(graph, fileNode, dependencyNode, "uses_dependency")
      ensureEdge(graph, importNode, dependencyNode, "references")
    }

    if (semantics?.importAliases?.length) {
      for (const binding of semantics.importAliases) {
        const resolved =
          resolvedImportsBySpecifier.get(binding.specifier) ??
          resolveInternalImport(rel, binding.specifier, sourceIndex, importContext)
        if (!resolved) continue

        if (binding.imported === "*" || binding.imported === "default") {
          addImportedInternalHintToken(importedInternalHintsByFile, rel, binding.alias, resolved)
          continue
        }

        addImportedSymbolAliasHint(importedSymbolAliasHintsByFile, rel, binding.alias, resolved, binding.imported)
      }
    }

    if (semantics?.reExportAliases?.length) {
      for (const binding of semantics.reExportAliases) {
        const resolved =
          resolvedImportsBySpecifier.get(binding.specifier) ??
          resolveInternalImport(rel, binding.specifier, sourceIndex, importContext)
        if (!resolved) continue
        addReExportAliasHint(reExportAliasHintsByFile, rel, binding.alias, resolved, binding.imported)
      }
    }

    if (semantics?.reExportAllSpecifiers?.length) {
      for (const specifier of semantics.reExportAllSpecifiers) {
        const resolved = resolvedImportsBySpecifier.get(specifier) ?? resolveInternalImport(rel, specifier, sourceIndex, importContext)
        if (!resolved) continue
        addReExportAllHint(reExportAllHintsByFile, rel, resolved)
      }
    }

    const exportedSymbols = semantics?.exported ?? extractExportedSymbols(content)
    for (const symbol of exportedSymbols.slice(0, 40)) {
      const symbolNode = ensureNode(graph, `symbol:${rel}:${symbol.name}`, {
        type: "entity",
        name: symbol.name,
        content: `${symbol.kind} ${symbol.name} in ${rel}`,
        tags: ["symbol", symbol.kind, "source"],
        metadata: { path: rel, kind: symbol.kind },
      })
      ensureEdge(graph, fileNode, symbolNode, "exports")
      let symbols = symbolNodesByFile.get(rel)
      if (!symbols) {
        symbols = new Map<string, string>()
        symbolNodesByFile.set(rel, symbols)
      }
      if (!symbols.has(symbol.name)) symbols.set(symbol.name, symbolNode)

      let exportedSymbolsMap = exportedSymbolNodesByFile.get(rel)
      if (!exportedSymbolsMap) {
        exportedSymbolsMap = new Map<string, string>()
        exportedSymbolNodesByFile.set(rel, exportedSymbolsMap)
      }
      if (!exportedSymbolsMap.has(symbol.name)) exportedSymbolsMap.set(symbol.name, symbolNode)
    }

    // Internal (non-exported) symbols
    const internalSymbols = semantics?.internal ?? extractInternalSymbols(content)
    for (const symbol of internalSymbols.slice(0, 30)) {
      const symbolNode = ensureNode(graph, `symbol:${rel}:${symbol.name}`, {
        type: "entity",
        name: symbol.name,
        content: `${symbol.kind} ${symbol.name} in ${rel}`,
        tags: ["symbol", symbol.kind, "source", "internal"],
        metadata: { path: rel, kind: symbol.kind, internal: true },
      })
      ensureEdge(graph, fileNode, symbolNode, "defines")
      let symbols = symbolNodesByFile.get(rel)
      if (!symbols) {
        symbols = new Map<string, string>()
        symbolNodesByFile.set(rel, symbols)
      }
      if (!symbols.has(symbol.name)) symbols.set(symbol.name, symbolNode)
    }
  }

  // Second pass: call and instantiation edges (requires all symbol nodes to exist from first pass)
  for (const [rel, content] of contents) {
    const semantics = semanticsByFile.get(rel)
    const calls = semantics?.calls ?? extractFunctionCalls(content)
    for (const call of calls.slice(0, 60)) {
      const callerNodeId = resolveSymbolNodeId({
        sourceFile: rel,
        symbolName: call.caller,
        qualifier: call.qualifier,
        symbolNodesByFile,
        exportedSymbolNodesByFile,
        importedInternalFilesByFile,
        importedInternalHintsByFile,
        importedSymbolAliasHintsByFile,
        reExportAliasHintsByFile,
        reExportAllHintsByFile,
      })
      if (!callerNodeId) continue

      const calleeNodeId = resolveSymbolNodeId({
        sourceFile: rel,
        symbolName: call.callee,
        qualifier: call.qualifier,
        symbolNodesByFile,
        exportedSymbolNodesByFile,
        importedInternalFilesByFile,
        importedInternalHintsByFile,
        importedSymbolAliasHintsByFile,
        reExportAliasHintsByFile,
        reExportAllHintsByFile,
      })
      if (!calleeNodeId) continue
      ensureEdge(graph, callerNodeId, calleeNodeId, "calls")
    }

    const instantiations = semantics?.instantiations ?? extractInstantiations(content)
    for (const inst of instantiations.slice(0, 40)) {
      const instantiatorNodeId = resolveSymbolNodeId({
        sourceFile: rel,
        symbolName: inst.caller,
        symbolNodesByFile,
        exportedSymbolNodesByFile,
        importedInternalFilesByFile,
        importedInternalHintsByFile,
        importedSymbolAliasHintsByFile,
        reExportAliasHintsByFile,
        reExportAllHintsByFile,
      })
      if (!instantiatorNodeId) continue
      const classNodeId = resolveSymbolNodeId({
        sourceFile: rel,
        symbolName: inst.className,
        symbolNodesByFile,
        exportedSymbolNodesByFile,
        importedInternalFilesByFile,
        importedInternalHintsByFile,
        importedSymbolAliasHintsByFile,
        reExportAliasHintsByFile,
        reExportAllHintsByFile,
      })
      if (!classNodeId) continue
      ensureEdge(graph, instantiatorNodeId, classNodeId, "instantiates")
    }
  }
}

async function ingestDocs(graph: KnowledgeGraph, projectNode: string, rootDir: string) {
  const files = await collectFiles(rootDir, [".md", ".mdx"]).then((result) => result.slice(0, 60))
  for (const file of files) {
    const rel = path.relative(rootDir, file)
    const content = await fs.readFile(file, "utf8").catch(() => undefined)
    if (!content) continue
    const firstHeading = content.split(/\n+/).find((line) => line.startsWith("#")) ?? rel
    const docNode = ensureNode(graph, `doc:${rel}`, {
      type: "concept",
      name: rel,
      content: firstHeading.replace(/^#+\s*/, ""),
      tags: ["doc"],
      metadata: { path: rel },
    })
    ensureEdge(graph, projectNode, docNode, "documents")
    for (const heading of extractMarkdownHeadings(content).slice(0, 20)) {
      const headingNode = ensureNode(graph, `doc-heading:${rel}#${heading.anchor}`, {
        type: "concept",
        name: heading.title,
        content: `${rel}#${heading.anchor}`,
        tags: ["doc", "doc-heading", `h${heading.level}`],
        metadata: {
          path: rel,
          anchor: heading.anchor,
          level: heading.level,
        },
      })
      ensureEdge(graph, docNode, headingNode, "has_heading")
    }
  }
}

async function collectFiles(rootDir: string, extensions: string[]) {
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
      if (extensions.some((ext) => entry.name.endsWith(ext))) {
        result.push(full)
      }
    }
  }
  await walk(rootDir)
  return result
}

type SymbolKind = "function" | "class" | "interface" | "type" | "enum" | "const" | "namespace"

type ImportAliasBinding = {
  alias: string
  imported: string
  specifier: string
}

type SourceSemanticSnapshot = {
  exported: Array<{ name: string; kind: SymbolKind }>
  internal: Array<{ name: string; kind: SymbolKind }>
  calls: Array<{ caller: string; callee: string; qualifier?: string }>
  instantiations: Array<{ caller: string; className: string }>
  imports: string[]
  importAliases: ImportAliasBinding[]
  reExportAliases: ImportAliasBinding[]
  reExportAllSpecifiers: string[]
}

let typeScriptLoader: Promise<any | undefined> | undefined

async function loadTypeScript() {
  if (!typeScriptLoader) {
    typeScriptLoader = import("typescript").catch(() => undefined)
  }
  return typeScriptLoader
}

function isSourceFileEligibleForTsAst(relPath: string) {
  return /\.(ts|tsx|js|jsx|mts|cts|mjs|cjs)$/i.test(relPath)
}

function symbolNameFromProperty(node: any) {
  if (!node) return undefined
  if (typeof node.text === "string") return node.text
  return undefined
}

function extractTypeScriptCallTarget(node: any, sourceFile: any): { callee: string; qualifier?: string } | undefined {
  const parseQualified = (raw: string | undefined) => {
    if (!raw) return undefined
    const segments = raw.match(/[A-Za-z_][A-Za-z0-9_]*/g)
    if (!segments || segments.length === 0) return undefined
    const callee = segments[segments.length - 1]
    const qualifier = segments.length > 1 ? segments[0] : undefined
    return {
      callee,
      qualifier: qualifier && !["this", "self", "super", "cls"].includes(qualifier) ? qualifier : undefined,
    }
  }

  if (!node) return undefined
  if (typeof node.text === "string") {
    return parseQualified(node.text)
  }
  if (typeof node.getText === "function") {
    return parseQualified(node.getText(sourceFile))
  }
  return undefined
}

async function extractSourceSemantics(relPath: string, content: string): Promise<SourceSemanticSnapshot | undefined> {
  const tsSemantics = await extractTypeScriptSourceSemantics(relPath, content).catch(() => undefined)
  if (tsSemantics) return tsSemantics

  const treeSitterSemantics = await extractTreeSitterSourceSemantics(relPath, content).catch(() => undefined)
  if (treeSitterSemantics) return treeSitterSemantics

  return undefined
}

async function extractTypeScriptSourceSemantics(relPath: string, content: string): Promise<SourceSemanticSnapshot | undefined> {
  if (!isSourceFileEligibleForTsAst(relPath)) return undefined
  const ts = await loadTypeScript()
  if (!ts) return undefined

  const ext = path.extname(relPath).toLowerCase()
  const scriptKind =
    ext === ".ts" || ext === ".cts" || ext === ".mts"
      ? ts.ScriptKind.TS
      : ext === ".tsx"
        ? ts.ScriptKind.TSX
        : ext === ".jsx"
          ? ts.ScriptKind.JSX
          : ts.ScriptKind.JS

  const sourceFile = ts.createSourceFile(relPath, content, ts.ScriptTarget.Latest, true, scriptKind)
  const exported: Array<{ name: string; kind: SymbolKind }> = []
  const internal: Array<{ name: string; kind: SymbolKind }> = []
  const calls: Array<{ caller: string; callee: string; qualifier?: string }> = []
  const instantiations: Array<{ caller: string; className: string }> = []
  const imports: string[] = []
  const importAliases: ImportAliasBinding[] = []
  const reExportAliases: ImportAliasBinding[] = []
  const reExportAllSpecifiers: string[] = []

  const exportedSeen = new Set<string>()
  const internalSeen = new Set<string>()
  const callSeen = new Set<string>()
  const instantiateSeen = new Set<string>()
  const importSeen = new Set<string>()
  const importAliasSeen = new Set<string>()
  const reExportAliasSeen = new Set<string>()
  const reExportAllSeen = new Set<string>()

  const addImport = (specifier: string) => {
    const value = normalizeImportSpecifier(specifier)
    if (!value || importSeen.has(value)) return
    importSeen.add(value)
    imports.push(value)
  }

  const addImportAlias = (alias: string, imported: string, specifier: string) => {
    const cleanAlias = alias?.trim()
    const cleanImported = imported?.trim()
    const normalizedSpecifier = normalizeImportSpecifier(specifier)
    if (!cleanAlias || !cleanImported || !normalizedSpecifier) return
    const key = `${cleanAlias}|${cleanImported}|${normalizedSpecifier}`
    if (importAliasSeen.has(key)) return
    importAliasSeen.add(key)
    importAliases.push({ alias: cleanAlias, imported: cleanImported, specifier: normalizedSpecifier })
  }

  const addReExportAlias = (alias: string, imported: string, specifier: string) => {
    const cleanAlias = alias?.trim()
    const cleanImported = imported?.trim()
    const normalizedSpecifier = normalizeImportSpecifier(specifier)
    if (!cleanAlias || !cleanImported || !normalizedSpecifier) return
    const key = `${cleanAlias}|${cleanImported}|${normalizedSpecifier}`
    if (reExportAliasSeen.has(key)) return
    reExportAliasSeen.add(key)
    reExportAliases.push({ alias: cleanAlias, imported: cleanImported, specifier: normalizedSpecifier })
  }

  const addReExportAllSpecifier = (specifier: string) => {
    const normalizedSpecifier = normalizeImportSpecifier(specifier)
    if (!normalizedSpecifier || reExportAllSeen.has(normalizedSpecifier)) return
    reExportAllSeen.add(normalizedSpecifier)
    reExportAllSpecifiers.push(normalizedSpecifier)
  }

  const addSymbol = (target: "exported" | "internal", symbol: { name: string; kind: SymbolKind }) => {
    if (!symbol.name || symbol.name.length <= 1) return
    const seen = target === "exported" ? exportedSeen : internalSeen
    if (seen.has(symbol.name)) return
    seen.add(symbol.name)
    if (target === "exported") exported.push(symbol)
    else internal.push(symbol)
  }

  const hasExportModifier = (node: any) => !!node.modifiers?.some((modifier: any) => modifier.kind === ts.SyntaxKind.ExportKeyword)

  const variableDeclarationKind = (declaration: any): SymbolKind => {
    const init = declaration.initializer
    return init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) ? "function" : "const"
  }

  for (const statement of sourceFile.statements) {
    if (ts.isImportDeclaration(statement) && ts.isStringLiteral(statement.moduleSpecifier)) {
      const specifier = statement.moduleSpecifier.text
      addImport(specifier)
      const clause = statement.importClause
      if (clause?.name?.text) {
        addImportAlias(clause.name.text, "default", specifier)
      }
      const namedBindings = clause?.namedBindings
      if (namedBindings && ts.isNamespaceImport(namedBindings)) {
        addImportAlias(namedBindings.name.text, "*", specifier)
      }
      if (namedBindings && ts.isNamedImports(namedBindings)) {
        for (const element of namedBindings.elements) {
          const alias = element.name.text
          const imported = element.propertyName?.text ?? element.name.text
          addImportAlias(alias, imported, specifier)
        }
      }
    }
    if (ts.isExportDeclaration(statement) && statement.moduleSpecifier && ts.isStringLiteral(statement.moduleSpecifier)) {
      const specifier = statement.moduleSpecifier.text
      addImport(specifier)

      const clause = statement.exportClause
      if (!clause) {
        addReExportAllSpecifier(specifier)
        continue
      }

      if (ts.isNamedExports(clause)) {
        for (const element of clause.elements) {
          const alias = element.name.text
          const imported = element.propertyName?.text ?? element.name.text
          addSymbol("exported", { name: alias, kind: "const" })
          addReExportAlias(alias, imported, specifier)
        }
        continue
      }

      if (ts.isNamespaceExport(clause)) {
        addSymbol("exported", { name: clause.name.text, kind: "namespace" })
        addReExportAlias(clause.name.text, "*", specifier)
        continue
      }

      continue
    }

    if (ts.isFunctionDeclaration(statement) && statement.name?.text) {
      addSymbol(hasExportModifier(statement) ? "exported" : "internal", { name: statement.name.text, kind: "function" })
      continue
    }
    if (ts.isClassDeclaration(statement) && statement.name?.text) {
      addSymbol(hasExportModifier(statement) ? "exported" : "internal", { name: statement.name.text, kind: "class" })
      for (const member of statement.members) {
        if (!ts.isMethodDeclaration(member) && !ts.isGetAccessorDeclaration(member) && !ts.isSetAccessorDeclaration(member)) continue
        const methodName = symbolNameFromProperty(member.name)
        if (methodName) addSymbol("internal", { name: methodName, kind: "function" })
      }
      continue
    }
    if (ts.isInterfaceDeclaration(statement) && statement.name?.text) {
      addSymbol(hasExportModifier(statement) ? "exported" : "internal", { name: statement.name.text, kind: "interface" })
      continue
    }
    if (ts.isTypeAliasDeclaration(statement) && statement.name?.text) {
      addSymbol(hasExportModifier(statement) ? "exported" : "internal", { name: statement.name.text, kind: "type" })
      continue
    }
    if (ts.isEnumDeclaration(statement) && statement.name?.text) {
      addSymbol(hasExportModifier(statement) ? "exported" : "internal", { name: statement.name.text, kind: "enum" })
      continue
    }
    if (ts.isModuleDeclaration(statement) && statement.name?.text) {
      addSymbol(hasExportModifier(statement) ? "exported" : "internal", { name: statement.name.text, kind: "namespace" })
      continue
    }
    if (ts.isVariableStatement(statement)) {
      for (const declaration of statement.declarationList.declarations) {
        if (!ts.isIdentifier(declaration.name)) continue
        const name = declaration.name.text
        addSymbol(hasExportModifier(statement) ? "exported" : "internal", {
          name,
          kind: variableDeclarationKind(declaration),
        })
      }
      continue
    }
    if (ts.isExportDeclaration(statement) && statement.exportClause && ts.isNamedExports(statement.exportClause)) {
      for (const element of statement.exportClause.elements) {
        const name = element.name.text
        addSymbol("exported", { name, kind: "const" })
      }
      continue
    }
  }

  const isCallableNode = (node: any) => {
    if (ts.isFunctionDeclaration(node) && node.name?.text) return node.name.text
    if (ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) {
      return symbolNameFromProperty(node.name)
    }
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      if (ts.isArrowFunction(node.initializer) || ts.isFunctionExpression(node.initializer)) {
        return node.name.text
      }
    }
    return undefined
  }

  const visit = (node: any, currentCaller?: string) => {
    const nextCaller = isCallableNode(node) ?? currentCaller

    if (nextCaller && ts.isCallExpression(node)) {
      const target = extractTypeScriptCallTarget(node.expression, sourceFile)
      const callee = target?.callee
      if (callee !== nextCaller) {
        const key = `${nextCaller}->${target?.qualifier ?? ""}.${callee}`
        if (callee && !callSeen.has(key)) {
          callSeen.add(key)
          calls.push({ caller: nextCaller, callee, qualifier: target?.qualifier })
        }
      }
    }

    if (nextCaller && ts.isNewExpression(node) && ts.isIdentifier(node.expression)) {
      const className = node.expression.text
      const key = `${nextCaller}->${className}`
      if (!instantiateSeen.has(key)) {
        instantiateSeen.add(key)
        instantiations.push({ caller: nextCaller, className })
      }
    }

    ts.forEachChild(node, (child: any) => visit(child, nextCaller))
  }

  visit(sourceFile)
  return {
    exported,
    internal,
    calls,
    instantiations,
    imports,
    importAliases,
    reExportAliases,
    reExportAllSpecifiers,
  }
}

const TREE_SITTER_SYMBOL_NODE_TYPES = new Set([
  "function_definition",
  "function_declaration",
  "function_item",
  "method_definition",
  "method_declaration",
  "constructor_declaration",
  "constructor_definition",
  "class_definition",
  "class_declaration",
  "class_specifier",
  "interface_declaration",
  "interface_specifier",
  "trait_item",
  "protocol_declaration",
  "type_alias_declaration",
  "type_definition",
  "type_declaration",
  "type_spec",
  "enum_declaration",
  "enum_specifier",
  "enum_item",
  "module_declaration",
  "namespace_declaration",
  "struct_declaration",
  "struct_specifier",
  "struct_item",
  "const_declaration",
  "const_item",
  "variable_declaration",
  "lexical_declaration",
])

const TREE_SITTER_CALL_NODE_TYPES = new Set([
  "call",
  "call_expression",
  "method_invocation",
  "invocation_expression",
  "function_call_expression",
])

const TREE_SITTER_INSTANTIATION_NODE_TYPES = new Set([
  "new_expression",
  "object_creation_expression",
  "constructor_call_expression",
  "class_instantiation_expression",
  "struct_expression",
])

const ROOT_LIKE_NODE_TYPES = new Set([
  "program",
  "module",
  "source_file",
  "translation_unit",
  "compilation_unit",
])

type TreeSitterLanguage = Awaited<ReturnType<typeof parseTreeSitterSyntaxTree>> extends { language: infer T } ? T : never

async function extractTreeSitterSourceSemantics(relPath: string, content: string): Promise<SourceSemanticSnapshot | undefined> {
  const parsed = await parseTreeSitterSyntaxTree({ filePath: relPath, content }).catch(() => undefined)
  if (!parsed?.rootNode) return undefined

  const exported: Array<{ name: string; kind: SymbolKind }> = []
  const internal: Array<{ name: string; kind: SymbolKind }> = []
  const calls: Array<{ caller: string; callee: string; qualifier?: string }> = []
  const instantiations: Array<{ caller: string; className: string }> = []
  const imports: string[] = []
  const importAliases: ImportAliasBinding[] = []
  const reExportAliases: ImportAliasBinding[] = []
  const reExportAllSpecifiers: string[] = []

  const exportedSeen = new Set<string>()
  const internalSeen = new Set<string>()
  const callSeen = new Set<string>()
  const instantiationSeen = new Set<string>()
  const importSeen = new Set<string>()

  const addSymbol = (target: "exported" | "internal", symbol: { name: string; kind: SymbolKind }) => {
    if (!symbol.name || symbol.name.length <= 1) return
    const seen = target === "exported" ? exportedSeen : internalSeen
    const key = `${symbol.kind}:${symbol.name}`
    if (seen.has(key)) return
    seen.add(key)
    if (target === "exported") exported.push(symbol)
    else internal.push(symbol)
  }

  const addImport = (specifier: string) => {
    const value = normalizeImportSpecifier(specifier)
    if (!value || importSeen.has(value)) return
    importSeen.add(value)
    imports.push(value)
  }

  const visit = (node: any, currentCaller?: string) => {
    const importSpecifiers = extractTreeSitterImportSpecifiers(node, content)
    for (const specifier of importSpecifiers) {
      addImport(specifier)
    }

    const declarationKind = classifyTreeSitterDeclarationKind(node.type)
    const declarationName = declarationKind ? extractTreeSitterDeclarationName(node, content) : undefined

    let nextCaller = currentCaller
    if (declarationKind && declarationName) {
      const isTopLevel = !node.parent || ROOT_LIKE_NODE_TYPES.has(String(node.parent.type))
      const visibility = isTopLevel && isLikelyTreeSitterExported(parsed.language, node, declarationName, content)
      addSymbol(visibility ? "exported" : "internal", { name: declarationName, kind: declarationKind })
      if (declarationKind === "function") {
        nextCaller = declarationName
      }
    }

    if (nextCaller) {
      const target = extractTreeSitterCallTarget(node, content)
      const callee = target?.callee
      if (callee && callee !== nextCaller) {
        const key = `${nextCaller}->${target?.qualifier ?? ""}.${callee}`
        if (!callSeen.has(key)) {
          callSeen.add(key)
          calls.push({ caller: nextCaller, callee, qualifier: target?.qualifier })
        }
      }

      const className = extractTreeSitterInstantiationName(node, content, parsed.language)
      if (className) {
        const key = `${nextCaller}->${className}`
        if (!instantiationSeen.has(key)) {
          instantiationSeen.add(key)
          instantiations.push({ caller: nextCaller, className })
        }
      }
    }

    const children = Array.isArray(node?.namedChildren) ? node.namedChildren : []
    for (const child of children) {
      visit(child, nextCaller)
    }
  }

  visit(parsed.rootNode)

  if (exported.length === 0 && internal.length === 0 && calls.length === 0 && instantiations.length === 0 && imports.length === 0) {
    return undefined
  }

  return {
    exported,
    internal,
    calls,
    instantiations,
    imports,
    importAliases,
    reExportAliases,
    reExportAllSpecifiers,
  }
}

function classifyTreeSitterDeclarationKind(nodeType: string): SymbolKind | undefined {
  if (!TREE_SITTER_SYMBOL_NODE_TYPES.has(nodeType)) return undefined
  const lower = nodeType.toLowerCase()
  if (lower.includes("function") || lower.includes("method") || lower.includes("constructor")) return "function"
  if (lower.includes("class")) return "class"
  if (lower.includes("interface") || lower.includes("trait") || lower.includes("protocol")) return "interface"
  if (lower.includes("type")) return "type"
  if (lower.includes("enum")) return "enum"
  if (lower.includes("namespace") || lower.includes("module")) return "namespace"
  return "const"
}

function extractTreeSitterDeclarationName(node: any, content: string): string | undefined {
  const fields = ["name", "declarator", "identifier", "function", "class", "type"]
  for (const field of fields) {
    const byField = node?.childForFieldName?.(field)
    const name = extractTreeSitterNodeName(byField, content)
    if (name) return name
  }
  return extractTreeSitterNodeName(node, content)
}

function extractTreeSitterCallTarget(node: any, content: string): { callee: string; qualifier?: string } | undefined {
  if (!TREE_SITTER_CALL_NODE_TYPES.has(String(node?.type))) return undefined
  const target =
    node?.childForFieldName?.("function") ??
    node?.childForFieldName?.("name") ??
    node?.childForFieldName?.("callee") ??
    (Array.isArray(node?.namedChildren) ? node.namedChildren[0] : undefined)
  const raw = sliceTreeSitterNodeText(target, content)
  const segments = raw.match(/[A-Za-z_][A-Za-z0-9_]*/g)
  if (segments && segments.length > 0) {
    const callee = segments[segments.length - 1]
    const qualifier = segments.length > 1 ? segments[0] : undefined
    return {
      callee,
      qualifier: qualifier && !["this", "self", "super", "cls"].includes(qualifier) ? qualifier : undefined,
    }
  }

  const callee = extractTreeSitterNodeName(target, content)
  if (!callee) return undefined
  return { callee }
}

function extractTreeSitterImportSpecifiers(node: any, content: string): string[] {
  const nodeType = String(node?.type ?? "")
  if (!nodeType) return []

  if (
    !nodeType.includes("import") &&
    nodeType !== "use_declaration" &&
    nodeType !== "preproc_include" &&
    nodeType !== "include_directive"
  ) {
    return []
  }

  const byField = ["source", "module", "path", "name", "value", "library"]
    .map((field) => node?.childForFieldName?.(field))
    .filter(Boolean)

  const snippets = [
    ...byField.map((item) => sliceTreeSitterNodeText(item, content)),
    sliceTreeSitterNodeText(node, content),
  ]

  const imports = new Set<string>()
  for (const snippet of snippets) {
    for (const specifier of extractImportSpecifiersFromSnippet(snippet)) {
      const normalized = normalizeImportSpecifier(specifier)
      if (normalized) imports.add(normalized)
    }
  }

  return [...imports]
}

function extractTreeSitterInstantiationName(
  node: any,
  content: string,
  language: TreeSitterLanguage,
): string | undefined {
  if (TREE_SITTER_INSTANTIATION_NODE_TYPES.has(String(node?.type))) {
    const target =
      node?.childForFieldName?.("type") ??
      node?.childForFieldName?.("class") ??
      node?.childForFieldName?.("name") ??
      node?.childForFieldName?.("constructor") ??
      (Array.isArray(node?.namedChildren) ? node.namedChildren[0] : undefined)
    return extractTreeSitterNodeName(target, content)
  }

  if (language === "python" && TREE_SITTER_CALL_NODE_TYPES.has(String(node?.type))) {
    const callee = extractTreeSitterCallTarget(node, content)?.callee
    if (callee && /^[A-Z]/.test(callee)) return callee
  }

  return undefined
}

function extractTreeSitterNodeName(node: any, content: string): string | undefined {
  if (!node) return undefined

  const direct = sanitizeTreeSitterName(sliceTreeSitterNodeText(node, content))
  if (direct) return direct

  const queue: Array<{ node: any; depth: number }> = [{ node, depth: 0 }]
  while (queue.length > 0) {
    const current = queue.shift()!
    if (current.depth > 4) continue

    const currentType = String(current.node?.type ?? "")
    if (current.node?.isNamed && /identifier|name/.test(currentType)) {
      const value = sanitizeTreeSitterName(sliceTreeSitterNodeText(current.node, content))
      if (value) return value
    }

    const children = Array.isArray(current.node?.namedChildren) ? current.node.namedChildren : []
    for (const child of children) {
      queue.push({ node: child, depth: current.depth + 1 })
    }
  }

  return undefined
}

function sliceTreeSitterNodeText(node: any, content: string) {
  if (typeof node?.startIndex !== "number" || typeof node?.endIndex !== "number") return ""
  return content.slice(node.startIndex, node.endIndex)
}

function sanitizeTreeSitterName(raw: string | undefined) {
  if (!raw) return undefined
  const compact = raw.trim().replace(/\s+/g, " ")
  if (!compact) return undefined
  const tokens = compact.match(/[A-Za-z_][A-Za-z0-9_]*/g)
  if (!tokens || tokens.length === 0) return undefined
  const value = tokens[tokens.length - 1]
  if (!value || value.length <= 1) return undefined
  return value
}

function isLikelyTreeSitterExported(language: TreeSitterLanguage, node: any, name: string, content: string) {
  switch (language) {
    case "python":
      return !name.startsWith("_")
    case "go":
      return /^[A-Z]/.test(name)
    case "rust": {
      const snippet = sliceTreeSitterNodeText(node, content)
      return /\bpub\b/.test(snippet)
    }
    case "java":
    case "csharp":
    case "php":
    case "swift":
    case "cpp":
    case "c": {
      const snippet = sliceTreeSitterNodeText(node, content)
      return /\bpublic\b/.test(snippet)
    }
    default:
      return false
  }
}

function extractImportSpecifiersFromSnippet(snippet: string) {
  const imports: string[] = []
  if (!snippet) return imports

  const patterns = [
    /(?:import|export)\s+(?:[^\n]*?from\s+)?["']([^"']+)["']/g,
    /^\s*import\s+(?:static\s+)?([A-Za-z0-9_.*]+)\s*;?\s*$/gm,
    /^\s*using\s+([A-Za-z0-9_.]+)\s*;?\s*$/gm,
    /^\s*import\s+(?:[A-Za-z_][A-Za-z0-9_]*\s+)?"([^"]+)"\s*;?\s*$/gm,
    /^\s*"([^"]+)"\s*$/gm,
    /require\(\s*["']([^"']+)["']\s*\)/g,
    /import\(\s*["']([^"']+)["']\s*\)/g,
    /^\s*from\s+([A-Za-z0-9_.]+)\s+import\s+/gm,
    /^\s*import\s+([A-Za-z0-9_.,\s]+)\s*$/gm,
    /^\s*use\s+([A-Za-z0-9_:]+)(?:::|;|\s)/gm,
    /^\s*#include\s+[<"]([^>"]+)[>"]/gm,
  ]

  for (const regex of patterns) {
    let match: RegExpExecArray | null
    while ((match = regex.exec(snippet))) {
      imports.push(match[1])
    }
  }

  return imports
}

function normalizeImportSpecifier(raw: string | undefined) {
  if (!raw) return undefined
  const normalized = raw.trim().replace(/^['"]|['"]$/g, "").replace(/[;\s]+$/g, "")
  if (!normalized || normalized.length > 256) return undefined
  return normalized
}

function resolveSymbolNodeId(input: {
  sourceFile: string
  symbolName: string
  qualifier?: string
  symbolNodesByFile: Map<string, Map<string, string>>
  exportedSymbolNodesByFile: Map<string, Map<string, string>>
  importedInternalFilesByFile: Map<string, Set<string>>
  importedInternalHintsByFile: Map<string, Map<string, Set<string>>>
  importedSymbolAliasHintsByFile: Map<string, Map<string, Array<{ file: string; imported: string }>>>
  reExportAliasHintsByFile: Map<string, Map<string, Array<{ file: string; imported: string }>>>
  reExportAllHintsByFile: Map<string, Set<string>>
}) {
  const local = input.symbolNodesByFile.get(input.sourceFile)?.get(input.symbolName)
  if (local) return local

  const qualifier = input.qualifier?.trim()
  if (qualifier) {
    const hinted = input.importedInternalHintsByFile.get(input.sourceFile)?.get(qualifier)
    if (hinted) {
      for (const imported of hinted) {
        const resolved = resolveSymbolFromFile(input, imported, input.symbolName)
        if (resolved) return resolved
      }
    }

    const qualifierBindings = input.importedSymbolAliasHintsByFile.get(input.sourceFile)?.get(qualifier)
    if (qualifierBindings) {
      for (const binding of qualifierBindings) {
        const resolved = resolveQualifiedAliasFromImport(input, binding.file, binding.imported, input.symbolName)
        if (resolved) return resolved
      }
    }
  }

  const aliasBindings = input.importedSymbolAliasHintsByFile.get(input.sourceFile)?.get(input.symbolName)
  if (aliasBindings) {
    for (const binding of aliasBindings) {
      const resolved = resolveSymbolFromFile(input, binding.file, binding.imported)
      if (resolved) return resolved
    }
  }

  const importedFiles = input.importedInternalFilesByFile.get(input.sourceFile)
  if (importedFiles) {
    for (const imported of importedFiles) {
      const resolved = resolveSymbolFromFile(input, imported, input.symbolName)
      if (resolved) return resolved
    }
  }

  for (const file of input.exportedSymbolNodesByFile.keys()) {
    const matched = resolveSymbolFromFile(input, file, input.symbolName)
    if (matched) return matched
  }

  for (const [file, symbols] of input.symbolNodesByFile.entries()) {
    const matched = symbols.get(input.symbolName) ?? resolveSymbolFromFile(input, file, input.symbolName)
    if (matched) return matched
  }

  return undefined
}

function resolveSymbolFromFile(
  input: {
    symbolNodesByFile: Map<string, Map<string, string>>
    exportedSymbolNodesByFile: Map<string, Map<string, string>>
    reExportAliasHintsByFile: Map<string, Map<string, Array<{ file: string; imported: string }>>>
    reExportAllHintsByFile: Map<string, Set<string>>
  },
  file: string,
  symbolName: string,
  visited = new Set<string>(),
): string | undefined {
  const key = `${file}:${symbolName}`
  if (visited.has(key)) return undefined
  visited.add(key)

  const reExportBindings = input.reExportAliasHintsByFile.get(file)?.get(symbolName)
  if (reExportBindings) {
    for (const binding of reExportBindings) {
      if (binding.imported === "*") continue
      const resolved = resolveSymbolFromFile(input, binding.file, binding.imported, visited)
      if (resolved) return resolved
    }
  }

  const reExportAllTargets = input.reExportAllHintsByFile.get(file)
  if (reExportAllTargets) {
    for (const targetFile of reExportAllTargets) {
      const resolved = resolveSymbolFromFile(input, targetFile, symbolName, visited)
      if (resolved) return resolved
    }
  }

  const exported = input.exportedSymbolNodesByFile.get(file)?.get(symbolName)
  if (exported) return exported

  const local = input.symbolNodesByFile.get(file)?.get(symbolName)
  if (local) return local

  return undefined
}

function resolveQualifiedAliasFromImport(
  input: {
    symbolNodesByFile: Map<string, Map<string, string>>
    exportedSymbolNodesByFile: Map<string, Map<string, string>>
    reExportAliasHintsByFile: Map<string, Map<string, Array<{ file: string; imported: string }>>>
    reExportAllHintsByFile: Map<string, Set<string>>
  },
  file: string,
  importedName: string,
  symbolName: string,
  visited = new Set<string>(),
): string | undefined {
  const key = `${file}:${importedName}->${symbolName}`
  if (visited.has(key)) return undefined
  visited.add(key)

  if (importedName === "*" || importedName === "default") {
    return resolveSymbolFromFile(input, file, symbolName)
  }

  const namespaceBindings = input.reExportAliasHintsByFile.get(file)?.get(importedName)
  if (namespaceBindings) {
    for (const binding of namespaceBindings) {
      if (binding.imported === "*") {
        const resolved = resolveSymbolFromFile(input, binding.file, symbolName)
        if (resolved) return resolved
        continue
      }

      const resolved = resolveQualifiedAliasFromImport(input, binding.file, binding.imported, symbolName, visited)
      if (resolved) return resolved
    }
  }

  if (importedName === symbolName) {
    const resolved = resolveSymbolFromFile(input, file, symbolName)
    if (resolved) return resolved
  }

  return undefined
}

function addImportedInternalHints(
  hintsByFile: Map<string, Map<string, Set<string>>>,
  sourceFile: string,
  specifier: string,
  resolvedFile: string,
) {
  const tokens = extractImportHintTokens(specifier)
  if (tokens.length === 0) return

  for (const token of tokens) {
    addImportedInternalHintToken(hintsByFile, sourceFile, token, resolvedFile)
  }
}

function addImportedInternalHintToken(
  hintsByFile: Map<string, Map<string, Set<string>>>,
  sourceFile: string,
  token: string,
  resolvedFile: string,
) {
  const normalizedToken = token.trim()
  if (!normalizedToken) return

  let sourceHints = hintsByFile.get(sourceFile)
  if (!sourceHints) {
    sourceHints = new Map<string, Set<string>>()
    hintsByFile.set(sourceFile, sourceHints)
  }

  let files = sourceHints.get(normalizedToken)
  if (!files) {
    files = new Set<string>()
    sourceHints.set(normalizedToken, files)
  }
  files.add(resolvedFile)
}

function addImportedSymbolAliasHint(
  hintsByFile: Map<string, Map<string, Array<{ file: string; imported: string }>>>,
  sourceFile: string,
  alias: string,
  resolvedFile: string,
  imported: string,
) {
  const normalizedAlias = alias.trim()
  const normalizedImported = imported.trim()
  if (!normalizedAlias || !normalizedImported) return

  let sourceHints = hintsByFile.get(sourceFile)
  if (!sourceHints) {
    sourceHints = new Map<string, Array<{ file: string; imported: string }>>()
    hintsByFile.set(sourceFile, sourceHints)
  }

  let bindings = sourceHints.get(normalizedAlias)
  if (!bindings) {
    bindings = []
    sourceHints.set(normalizedAlias, bindings)
  }

  if (!bindings.some((item) => item.file === resolvedFile && item.imported === normalizedImported)) {
    bindings.push({ file: resolvedFile, imported: normalizedImported })
  }
}

function addReExportAliasHint(
  hintsByFile: Map<string, Map<string, Array<{ file: string; imported: string }>>>,
  sourceFile: string,
  alias: string,
  resolvedFile: string,
  imported: string,
) {
  const normalizedAlias = alias.trim()
  const normalizedImported = imported.trim()
  if (!normalizedAlias || !normalizedImported) return

  let sourceHints = hintsByFile.get(sourceFile)
  if (!sourceHints) {
    sourceHints = new Map<string, Array<{ file: string; imported: string }>>()
    hintsByFile.set(sourceFile, sourceHints)
  }

  let bindings = sourceHints.get(normalizedAlias)
  if (!bindings) {
    bindings = []
    sourceHints.set(normalizedAlias, bindings)
  }

  if (!bindings.some((item) => item.file === resolvedFile && item.imported === normalizedImported)) {
    bindings.push({ file: resolvedFile, imported: normalizedImported })
  }
}

function addReExportAllHint(
  hintsByFile: Map<string, Set<string>>,
  sourceFile: string,
  resolvedFile: string,
) {
  let sourceHints = hintsByFile.get(sourceFile)
  if (!sourceHints) {
    sourceHints = new Set<string>()
    hintsByFile.set(sourceFile, sourceHints)
  }
  sourceHints.add(resolvedFile)
}

function extractImportHintTokens(specifier: string) {
  const normalized = normalizeImportSpecifier(specifier)
  if (!normalized) return []

  const base = normalized
    .replace(/\*+$/g, "")
    .replace(/\.$/, "")
    .replace(/^\//, "")
  const segments = base.split(/[/:.\\-]+/).filter(Boolean)
  if (segments.length === 0) return []

  const interesting = [segments[segments.length - 1], segments[0]]
    .filter(Boolean)
    .filter((value) => !["import", "from", "pkg"].includes(value.toLowerCase()))

  return [...new Set(interesting)]
}

function extractExportedSymbols(content: string): Array<{ name: string; kind: SymbolKind }> {
  const symbols: Array<{ name: string; kind: SymbolKind }> = []
  const seen = new Set<string>()

  const patterns: Array<[RegExp, SymbolKind]> = [
    [/^export\s+(?:async\s+)?function\s*\*?\s*(\w+)/gm, "function"],
    [/^export\s+(?:abstract\s+)?class\s+(\w+)/gm, "class"],
    [/^export\s+interface\s+(\w+)/gm, "interface"],
    [/^export\s+type\s+(\w+)\s*[=<{\[]/gm, "type"],
    [/^export\s+enum\s+(\w+)/gm, "enum"],
    [/^export\s+namespace\s+(\w+)/gm, "namespace"],
    // Arrow-function consts: export const foo = () => / export const foo = async () =>
    [/^export\s+const\s+(\w+)\s*[=:][^;]*=>/gm, "function"],
    // Non-function consts (no arrow, no function keyword on the right side)
    [/^export\s+const\s+(\w+)\s*(?::[^=]*)?=\s*(?!(?:async\s+)?(?:function|\([^)]*\)\s*=>|\w+\s*=>))/gm, "const"],
    // let / var exports
    [/^export\s+(?:let|var)\s+(\w+)/gm, "const"],
    // default function/class
    [/^export\s+default\s+(?:async\s+)?function\s+(\w+)/gm, "function"],
    [/^export\s+default\s+class\s+(\w+)/gm, "class"],
  ]

  // Re-exports: export { Foo, Bar as Baz }
  const reExportRe = /^export\s+\{([^}]+)\}/gm
  let reMatch: RegExpExecArray | null
  while ((reMatch = reExportRe.exec(content)) !== null) {
    for (const item of reMatch[1].split(",")) {
      const aliasMatch = /\bas\s+(\w+)/.exec(item)
      const nameMatch = aliasMatch ?? /(\w+)\s*$/.exec(item.trim())
      const name = nameMatch?.[1]
      if (name && name.length > 1 && !seen.has(name) && name !== "default") {
        seen.add(name)
        symbols.push({ name, kind: "const" })
      }
    }
  }

  for (const [regex, kind] of patterns) {
    let match: RegExpExecArray | null
    while ((match = regex.exec(content)) !== null) {
      const name = match[1]
      if (name && name.length > 1 && !seen.has(name)) {
        seen.add(name)
        symbols.push({ name, kind })
      }
    }
  }

  return symbols
}

/**
 * Extract non-exported (internal/private) symbols from a source file.
 * Matches top-level `function`, `class`, `const`, `let`, `var` declarations
 * that do NOT begin with the `export` keyword.
 */
function extractInternalSymbols(content: string): Array<{ name: string; kind: SymbolKind }> {
  const symbols: Array<{ name: string; kind: SymbolKind }> = []
  const seen = new Set<string>()

  const patterns: Array<[RegExp, SymbolKind]> = [
    // Non-exported top-level function declarations (including async/generator)
    [/^(?!export\s)(?:async\s+)?function\s*\*?\s*([A-Za-z_$]\w*)\s*\(/gm, "function"],
    // Non-exported top-level class declarations
    [/^(?!export\s)(?:abstract\s+)?class\s+([A-Za-z_$]\w*)/gm, "class"],
    // Non-exported const/let/var arrow functions
    [/^(?!export\s)const\s+([A-Za-z_$]\w*)\s*[=:][^;]*=>/gm, "function"],
    // Non-exported plain consts (not arrow)
    [/^(?!export\s)const\s+([A-Za-z_$]\w*)\s*(?::[^=]*)?=\s*(?!(?:async\s+)?(?:function|\([^)]*\)\s*=>|\w+\s*=>))/gm, "const"],
  ]

  for (const [regex, kind] of patterns) {
    let match: RegExpExecArray | null
    while ((match = regex.exec(content)) !== null) {
      const name = match[1]
      if (name && name.length > 1 && !seen.has(name)) {
        seen.add(name)
        symbols.push({ name, kind })
      }
    }
  }

  return symbols
}

/**
 * Extract function-call relationships within a file.
 * Returns pairs { caller, callee } where `caller` is an identifiable function/method
 * in the same file and `callee` is the called function identifier.
 *
 * Strategy: scan each function body delimited by a simple heuristic (next top-level
 * function declaration) and collect all `identifier(` call sites inside it.
 */
function extractFunctionCalls(content: string): Array<{ caller: string; callee: string; qualifier?: string }> {
  const calls: Array<{ caller: string; callee: string; qualifier?: string }> = []
  const functionBoundaryRe = /^(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$]\w*)\s*\(/gm
  const callSiteRe = /\b([A-Za-z_$]\w*)\s*\(/g

  const JS_KEYWORDS = new Set([
    "if", "for", "while", "switch", "catch", "return", "typeof", "instanceof",
    "new", "delete", "void", "throw", "await", "yield", "import", "require",
  ])

  let match: RegExpExecArray | null
  const boundaries: Array<{ name: string; start: number }> = []
  while ((match = functionBoundaryRe.exec(content)) !== null) {
    boundaries.push({ name: match[1], start: match.index })
  }

  for (let i = 0; i < boundaries.length; i++) {
    const { name: caller, start } = boundaries[i]
    const end = boundaries[i + 1]?.start ?? content.length
    const body = content.slice(start, Math.min(end, start + 4000))
    // Reset the call-site regex for each body scan
    callSiteRe.lastIndex = 0
    let callMatch: RegExpExecArray | null
    const seen = new Set<string>()
    while ((callMatch = callSiteRe.exec(body)) !== null) {
      const callee = callMatch[1]
      if (callee === caller || JS_KEYWORDS.has(callee) || seen.has(callee)) continue
      seen.add(callee)
      calls.push({ caller, callee })
    }
  }

  return calls
}

/**
 * Extract `new ClassName(` instantiation relationships.
 * Returns pairs { caller, className } where `caller` is the enclosing function/method.
 */
function extractInstantiations(content: string): Array<{ caller: string; className: string }> {
  const insts: Array<{ caller: string; className: string }> = []
  const functionBoundaryRe = /^(?:export\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$]\w*)\s*\(/gm
  const newRe = /\bnew\s+([A-Za-z_$]\w*)\s*\(/g

  let match: RegExpExecArray | null
  const boundaries: Array<{ name: string; start: number }> = []
  while ((match = functionBoundaryRe.exec(content)) !== null) {
    boundaries.push({ name: match[1], start: match.index })
  }

  for (let i = 0; i < boundaries.length; i++) {
    const { name: caller, start } = boundaries[i]
    const end = boundaries[i + 1]?.start ?? content.length
    const body = content.slice(start, Math.min(end, start + 4000))
    newRe.lastIndex = 0
    let newMatch: RegExpExecArray | null
    const seen = new Set<string>()
    while ((newMatch = newRe.exec(body)) !== null) {
      const className = newMatch[1]
      if (seen.has(className)) continue
      seen.add(className)
      insts.push({ caller, className })
    }
  }

  return insts
}

function extractImports(content: string) {
  const imports = new Set<string>()
  for (const specifier of extractImportSpecifiersFromSnippet(content)) {
    const normalized = normalizeImportSpecifier(specifier)
    if (normalized) imports.add(normalized)
  }
  return [...imports]
}

function isInternalImportSpecifier(specifier: string) {
  return (
    specifier.startsWith(".") ||
    specifier.startsWith("/") ||
    specifier.startsWith("@/") ||
    specifier.startsWith("crate::") ||
    specifier.startsWith("self::") ||
    specifier.startsWith("super::")
  )
}

function buildSourceIndex(rootDir: string, files: string[]) {
  const index = new Map<string, string>()
  for (const file of files) {
    const rel = path.relative(rootDir, file).replaceAll("\\", "/")
    index.set(rel, rel)
    const withoutExt = rel.replace(/\.[^.]+$/, "")
    index.set(withoutExt, rel)
    if (/\/(index)\.[^.]+$/.test(rel)) {
      index.set(withoutExt.replace(/\/index$/, ""), rel)
    }
  }
  return index
}

type ImportResolveContext = {
  goModulePath?: string
}

async function buildImportResolveContext(rootDir: string): Promise<ImportResolveContext> {
  const goMod = await fs.readFile(path.join(rootDir, "go.mod"), "utf8").catch(() => undefined)
  const goModulePath = goMod
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line.startsWith("module "))
    ?.slice("module ".length)
    .trim()

  return {
    goModulePath: goModulePath || undefined,
  }
}

function resolveInternalImport(
  sourceRel: string,
  specifier: string,
  sourceIndex: Map<string, string>,
  context: ImportResolveContext,
) {
  const normalizedSource = sourceRel.replaceAll("\\", "/")
  const sourceDir = path.posix.dirname(normalizedSource)
  const normalizedSpecifier = specifier.replaceAll("\\", "/")
  const resolvedSpecifier = (() => {
    if (context.goModulePath && normalizedSpecifier === context.goModulePath) {
      return "."
    }
    if (context.goModulePath && normalizedSpecifier.startsWith(`${context.goModulePath}/`)) {
      return normalizedSpecifier.slice(context.goModulePath.length + 1)
    }
    if (normalizedSpecifier.startsWith("crate::")) {
      return normalizedSpecifier.slice("crate::".length).replaceAll("::", "/")
    }
    if (normalizedSpecifier.startsWith("self::")) {
      const local = normalizedSpecifier.slice("self::".length).replaceAll("::", "/")
      return path.posix.join(sourceDir, local)
    }
    if (normalizedSpecifier.startsWith("super::")) {
      const local = normalizedSpecifier.slice("super::".length).replaceAll("::", "/")
      return path.posix.join(path.posix.dirname(sourceDir), local)
    }
    if (normalizedSpecifier.startsWith("@/")) {
      return normalizedSpecifier.slice(2)
    }
    if (normalizedSpecifier.startsWith("./") || normalizedSpecifier.startsWith("../") || normalizedSpecifier.startsWith("/")) {
      return path.posix.join(sourceDir, normalizedSpecifier)
    }
    return path.posix.join(sourceDir, normalizedSpecifier)
  })()

  const fromSource = path.posix.normalize(resolvedSpecifier)
  const fromRoot = path.posix.normalize(normalizedSpecifier.replace(/^\//, ""))
  const dotted = normalizedSpecifier
    .replace(/\*+$/g, "")
    .replace(/\.$/, "")
    .replace(/::/g, "/")
    .replace(/\./g, "/")
  const dottedFromSource = path.posix.normalize(path.posix.join(sourceDir, dotted))
  const dottedFromRoot = path.posix.normalize(dotted.replace(/^\//, ""))

  const variants = (base: string) => [
    base,
    `${base}.ts`,
    `${base}.tsx`,
    `${base}.js`,
    `${base}.jsx`,
    `${base}.mjs`,
    `${base}.cjs`,
    `${base}.py`,
    `${base}.rs`,
    `${base}.go`,
    `${base}.java`,
    `${base}.c`,
    `${base}.h`,
    `${base}.cpp`,
    `${base}.cc`,
    `${base}.cxx`,
    `${base}.hpp`,
    `${base}.cs`,
    `${base}.rb`,
    `${base}.php`,
    `${base}.scala`,
    `${base}.swift`,
    `${base}/index.ts`,
    `${base}/index.tsx`,
    `${base}/index.js`,
    `${base}/index.jsx`,
    `${base}/index.py`,
    `${base}/index.rs`,
    `${base}/index.go`,
    `${base}/index.java`,
  ]

  const candidates = [...variants(fromSource), ...variants(fromRoot), ...variants(dottedFromSource), ...variants(dottedFromRoot)]
  for (const candidate of candidates) {
    const resolved = sourceIndex.get(candidate)
    if (resolved) return resolved
  }

  const directoryBases = [fromSource, fromRoot, dottedFromSource, dottedFromRoot]
  for (const base of directoryBases) {
    if (!base || base === ".") continue
    const directoryMatch = resolveDirectoryImport(base, sourceIndex)
    if (directoryMatch) return directoryMatch
  }

  return undefined
}

function resolveDirectoryImport(base: string, sourceIndex: Map<string, string>) {
  const prefix = `${base}/`
  const matches = [...sourceIndex.entries()]
    .filter(([key]) => key.startsWith(prefix))
    .map(([, value]) => value)
    .sort((a, b) => a.length - b.length)
  return matches[0]
}

function extractMarkdownHeadings(content: string) {
  const result: { title: string; anchor: string; level: number }[] = []
  for (const line of content.split(/\n+/)) {
    const match = /^(#{1,6})\s+(.+?)\s*$/.exec(line.trim())
    if (!match) continue
    const title = match[2].trim()
    const anchor = slugifyHeading(title)
    if (!anchor) continue
    result.push({
      title,
      anchor,
      level: match[1].length,
    })
  }
  return result
}

function slugifyHeading(value: string) {
  return value
    .toLowerCase()
    .replace(/[`*_~]/g, "")
    .replace(/[^a-z0-9\s-]/g, " ")
    .trim()
    .replace(/\s+/g, "-")
    .replace(/-+/g, "-")
}

function ensureNode(graph: KnowledgeGraph, key: string, input: Parameters<KnowledgeGraph["addNode"]>[0]) {
  const existing = graph.query({ text: input.name, limit: 10 }).find((item) => item.metadata?.derivedKey === key)
  if (existing) return existing.id
  return graph.addNode({
    ...input,
    metadata: {
      ...input.metadata,
      derivedKey: key,
    },
  })
}

function ensureEdge(graph: KnowledgeGraph, sourceId: string, targetId: string, relation: string, metadata: Record<string, unknown> = {}) {
  const exists = graph.getEdges(sourceId, "out").some((edge) => edge.targetId === targetId && edge.relation === relation)
  if (!exists) graph.addEdge(sourceId, targetId, relation, 1, metadata)
}

export async function refreshDerivedKnowledgeGraphSafe(graph: KnowledgeGraph, rootDir?: string) {
  await refreshDerivedKnowledgeGraph(graph, rootDir).catch((error) => {
    log.warn("failed to refresh derived knowledge graph", { rootDir, error: String(error) })
  })
}