import { afterEach, describe, expect, test, vi } from "bun:test"
import { ModuleLoader } from "../util/module-loader"
import {
  findTreeSitterScopedRange,
  findTreeSitterSyntaxHints,
  preloadMainstreamTreeSitterLanguagesInBackground,
  resetTreeSitterLanguagePreloadStateForTest,
} from "../util/tree-sitter-scope"

describe("tree-sitter syntax hints", () => {
  afterEach(() => {
    vi.restoreAllMocks()
    resetTreeSitterLanguagePreloadStateForTest()
  })

  test("returns syntax node hints for a bash window", async () => {
    const content = [
      "first() {",
      "  echo one",
      "}",
      "",
      "second() {",
      "  echo two",
      "}",
    ].join("\n")

    const hints = await findTreeSitterSyntaxHints({
      filePath: "/repo/test.sh",
      content,
      startLine: 5,
      endLine: 6,
      limit: 4,
    })

    expect(hints.length).toBeGreaterThan(0)
    expect(hints.some((hint) => hint.nodeType.includes("function"))).toBe(true)
    expect(hints.some((hint) => hint.syntaxSummary.includes("function_definition:"))).toBe(true)
    expect(hints.some((hint) => hint.syntaxHint.includes("function"))).toBe(true)
    expect(hints.some((hint) => hint.syntaxHint.includes("first") || hint.syntaxHint.includes("second"))).toBe(true)
  })

  test("distinguishes sibling bash if, for, and case blocks", async () => {
    const content = [
      "run() {",
      "  if test \"$A\" = \"1\"; then",
      "    echo one",
      "  fi",
      "  if test \"$B\" = \"2\"; then",
      "    echo two",
      "  fi",
      "  for item in a b; do",
      "    echo $item",
      "  done",
      "  for value in c d; do",
      "    echo $value",
      "  done",
      "  case \"$kind\" in",
      "    foo) echo foo ;;",
      "  esac",
      "  case \"$mode\" in",
      "    bar) echo bar ;;",
      "  esac",
      "}",
    ].join("\n")

    const firstIf = await findTreeSitterScopedRange({
      filePath: "/repo/test.sh",
      content,
      oldString: ["if test \"$A\" = \"1\"; then", "    echo one", "  fi"].join("\n"),
      startLine: 2,
      endLine: 4,
    })
    const secondIf = await findTreeSitterScopedRange({
      filePath: "/repo/test.sh",
      content,
      oldString: ["if test \"$B\" = \"2\"; then", "    echo two", "  fi"].join("\n"),
      startLine: 5,
      endLine: 7,
    })
    const firstFor = await findTreeSitterScopedRange({
      filePath: "/repo/test.sh",
      content,
      oldString: ["for item in a b; do", "    echo $item", "  done"].join("\n"),
      startLine: 8,
      endLine: 10,
    })
    const secondFor = await findTreeSitterScopedRange({
      filePath: "/repo/test.sh",
      content,
      oldString: ["for value in c d; do", "    echo $value", "  done"].join("\n"),
      startLine: 11,
      endLine: 13,
    })
    const firstCase = await findTreeSitterScopedRange({
      filePath: "/repo/test.sh",
      content,
      oldString: ['case "$kind" in', '    foo) echo foo ;;', '  esac'].join("\n"),
      startLine: 14,
      endLine: 16,
    })
    const secondCase = await findTreeSitterScopedRange({
      filePath: "/repo/test.sh",
      content,
      oldString: ['case "$mode" in', '    bar) echo bar ;;', '  esac'].join("\n"),
      startLine: 17,
      endLine: 19,
    })

    expect(firstIf?.syntaxSummary).not.toBe(secondIf?.syntaxSummary)
    expect(firstIf?.syntaxHint).not.toBe(secondIf?.syntaxHint)
    expect(firstFor?.syntaxSummary).not.toBe(secondFor?.syntaxSummary)
    expect(firstFor?.syntaxHint).not.toBe(secondFor?.syntaxHint)
    expect(firstCase?.syntaxSummary).not.toBe(secondCase?.syntaxSummary)
    expect(firstCase?.syntaxHint).not.toBe(secondCase?.syntaxHint)
    expect(firstIf?.syntaxSummary).toContain("if_statement:")
    expect(firstFor?.syntaxSummary).toContain("for_statement:")
    expect(firstCase?.syntaxSummary).toContain("case_statement:")
  })

  test("promotes python wrapper blocks to semantic function and if nodes", async () => {
    const content = [
      "class UserService:",
      "    def fetch_user(self, user_id: str):",
      "        if user_id:",
      "            return user_id",
      "",
    ].join("\n")

    const functionRange = await findTreeSitterScopedRange({
      filePath: "/repo/test.py",
      content,
      oldString: [
        "def fetch_user(self, user_id: str):",
        "        if user_id:",
        "            return user_id",
      ].join("\n"),
      startLine: 2,
      endLine: 4,
    })
    const ifRange = await findTreeSitterScopedRange({
      filePath: "/repo/test.py",
      content,
      oldString: ["if user_id:", "            return user_id"].join("\n"),
      startLine: 3,
      endLine: 4,
    })

    expect(functionRange?.nodeType).toBe("function_definition")
    expect(functionRange?.syntaxSummary).toBe("function_definition:fetch_user")
    expect(functionRange?.syntaxHint).toContain("function_definition(fetch_user)")

    expect(ifRange?.nodeType).toBe("if_statement")
    expect(ifRange?.syntaxSummary).toBe("if_statement:user_id")
    expect(ifRange?.syntaxHint).toContain("if_statement(user_id)")
  })

  test("returns readable JavaScript, TypeScript, and Python summaries for visible windows", async () => {
    const jsContent = [
      "function fetchUser(userId) {",
      "  if (userId) {",
      "    return userId",
      "  }",
      "}",
    ].join("\n")
    const tsContent = [
      "class UserService {",
      "  fetchUser(userId: string) {",
      "    if (userId.length > 0) {",
      "      return userId",
      "    }",
      "  }",
      "}",
    ].join("\n")
    const pyContent = [
      "class UserService:",
      "    def fetch_user(self, user_id: str):",
      "        if user_id:",
      "            return user_id",
      "",
    ].join("\n")

    const jsHints = await findTreeSitterSyntaxHints({
      filePath: "/repo/test.js",
      content: jsContent,
      startLine: 1,
      endLine: 4,
      limit: 8,
    })
    const tsHints = await findTreeSitterSyntaxHints({
      filePath: "/repo/test.ts",
      content: tsContent,
      startLine: 2,
      endLine: 4,
      limit: 8,
    })
    const pyHints = await findTreeSitterSyntaxHints({
      filePath: "/repo/test.py",
      content: pyContent,
      startLine: 2,
      endLine: 4,
      limit: 8,
    })

    expect(jsHints.some((hint) => hint.syntaxSummary === "function_declaration:fetchUser")).toBe(true)
    expect(jsHints.some((hint) => hint.syntaxSummary === "if_statement:userId")).toBe(true)
    expect(tsHints.some((hint) => hint.syntaxSummary === "method_definition:fetchUser")).toBe(true)
    expect(tsHints.some((hint) => hint.syntaxSummary === "if_statement:userId.length_0")).toBe(true)
    expect(pyHints.some((hint) => hint.syntaxSummary === "function_definition:fetch_user")).toBe(true)
    expect(pyHints.some((hint) => hint.syntaxSummary === "if_statement:user_id")).toBe(true)
    expect(pyHints.some((hint) => hint.syntaxSummary.startsWith("block:"))).toBe(false)
    expect(pyHints.some((hint) => hint.syntaxHint.includes("block("))).toBe(false)
  })

  test("preloads missing mainstream grammars in background without scheduling already installed ones", async () => {
    const loader = ModuleLoader.getInstance()
    vi.spyOn(loader, "getNodeModulesPath").mockImplementation((name: string) => `/__tree_sitter_missing__/${name}`)
    const installSpy = vi.spyOn(loader, "installInBackground").mockImplementation(() => {})

    await preloadMainstreamTreeSitterLanguagesInBackground()

    const scheduledPackages = installSpy.mock.calls.map((call) => call[0]?.name)

    expect(scheduledPackages).toContain("tree-sitter-go")
    expect(scheduledPackages).toContain("tree-sitter-rust")
    expect(scheduledPackages).toContain("tree-sitter-java")
    expect(scheduledPackages).toContain("tree-sitter-c")
    expect(scheduledPackages).toContain("tree-sitter-cpp")
    expect(scheduledPackages).toContain("tree-sitter-c-sharp")
    expect(scheduledPackages).toContain("tree-sitter-php")
    expect(scheduledPackages).toContain("tree-sitter-ruby")
    expect(scheduledPackages).toContain("tree-sitter-html")
    expect(scheduledPackages).toContain("tree-sitter-css")
    expect(scheduledPackages).toContain("tree-sitter-json")
    expect(scheduledPackages).toContain("tree-sitter-yaml")

    expect(scheduledPackages).not.toContain("tree-sitter-bash")
    expect(scheduledPackages).not.toContain("tree-sitter-javascript")
    expect(scheduledPackages).not.toContain("tree-sitter-typescript")
    expect(scheduledPackages).not.toContain("tree-sitter-python")
  })
})