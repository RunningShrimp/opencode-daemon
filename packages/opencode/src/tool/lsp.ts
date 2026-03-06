import z from "zod"
import { Tool } from "./tool"
import path from "path"
import { LSP } from "../lsp"
import DESCRIPTION from "./lsp.txt"
import { Instance } from "../project/instance"
import { pathToFileURL } from "url"
import { assertExternalDirectory } from "./external-directory"
import { Filesystem } from "../util/filesystem"

// Debounce map for LSP operations
const debounceTimers = new Map<string, ReturnType<typeof setTimeout>>()
const DEBOUNCE_MS = 150

const operations = [
  "goToDefinition",
  "findReferences",
  "hover",
  "documentSymbol",
  "workspaceSymbol",
  "goToImplementation",
  "prepareCallHierarchy",
  "incomingCalls",
  "outgoingCalls",
] as const

type LspParams = {
  operation: typeof operations[number]
  filePath: string
  line: number
  character: number
}

export const LspTool = Tool.define("lsp", {
  description: DESCRIPTION,
  parameters: z.object({
    operation: z.enum(operations).describe("The LSP operation to perform"),
    filePath: z.string().describe("The absolute or relative path to the file"),
    line: z.number().int().min(1).describe("The line number (1-based, as shown in editors)"),
    character: z.number().int().min(1).describe("The character offset (1-based, as shown in editors)"),
  }),
  execute: async (args: LspParams, ctx): Promise<{ title: string; metadata: { result: unknown[] }; output: string }> => {
    const file = path.isAbsolute(args.filePath) ? args.filePath : path.join(Instance.directory, args.filePath)
    await assertExternalDirectory(ctx, file)

    await ctx.ask({
      permission: "lsp",
      patterns: ["*"],
      always: ["*"],
      metadata: {},
    })
    const uri = pathToFileURL(file).href
    const position = {
      file,
      line: args.line - 1,
      character: args.character - 1,
    }

    const relPath = path.relative(Instance.worktree, file)
    const title = `${args.operation} ${relPath}:${args.line}:${args.character}`

    const exists = await Filesystem.exists(file)
    if (!exists) {
      throw new Error(`File not found: ${file}`)
    }

    const available = await LSP.hasClients(file)
    if (!available) {
      throw new Error("No LSP server available for this file type.")
    }

    // Debounce: cancel previous requests with same key
    const debounceKey = `${file}:${args.line}:${args.character}`
    const existingTimer = debounceTimers.get(debounceKey)
    if (existingTimer) {
      clearTimeout(existingTimer)
    }

    // Touch file without waiting for diagnostics
    await LSP.touchFile(file, false)

    // For operations that support debounce (hover, definition, references)
    if (["hover", "goToDefinition", "findReferences"].includes(args.operation)) {
      return new Promise((resolve, reject) => {
        const timer = setTimeout(async () => {
          debounceTimers.delete(debounceKey)
          try {
            const result = await runLspOperation(args.operation, uri, position) as unknown[]
            resolve({
              title,
              metadata: { result },
              output: result.length === 0
                ? `No results found for ${args.operation}`
                : JSON.stringify(result, null, 2),
            })
          } catch (err) {
            reject(err)
          }
        }, DEBOUNCE_MS)

        debounceTimers.set(debounceKey, timer)
      })
    }

    // For non-debounced operations, execute immediately
    const result = await runLspOperation(args.operation, uri, position) as unknown[]
    return {
      title,
      metadata: { result },
      output: result.length === 0
        ? `No results found for ${args.operation}`
        : JSON.stringify(result, null, 2),
    }
  },
})

async function runLspOperation(
  operation: typeof operations[number],
  uri: string,
  position: { file: string; line: number; character: number },
): Promise<unknown> {
  switch (operation) {
    case "goToDefinition":
      return LSP.definition(position)
    case "findReferences":
      return LSP.references(position)
    case "hover":
      return LSP.hover(position)
    case "documentSymbol":
      return LSP.documentSymbol(uri)
    case "workspaceSymbol":
      return LSP.workspaceSymbol("")
    case "goToImplementation":
      return LSP.implementation(position)
    case "prepareCallHierarchy":
      return LSP.prepareCallHierarchy(position)
    case "incomingCalls":
      return LSP.incomingCalls(position)
    case "outgoingCalls":
      return await LSP.outgoingCalls(position) as unknown[]
    default:
      return []
  }
}
