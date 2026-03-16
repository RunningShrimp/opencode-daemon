import { describe, expect, test } from "bun:test"
import {
  extractAutoGroundingQueryFromParts,
  formatAutoGroundingSystemPrompt,
  shouldAutoGroundQuery,
} from "../ai/rag/auto-context-format"
import { EvidenceSource } from "../ai/thinking/evidence"

describe("rag auto context", () => {
  test("extracts only non-synthetic text parts", () => {
    const query = extractAutoGroundingQueryFromParts([
      { type: "text", text: "", synthetic: false },
      { type: "text", text: "find the auth middleware flow", synthetic: false },
      { type: "text", text: "ignored", ignored: true },
      { type: "text", text: "system reminder", synthetic: true },
      { type: "file" },
    ])

    expect(query).toBe("find the auth middleware flow")
  })

  test("formats retrieved evidence with file ranges", () => {
    const prompt = formatAutoGroundingSystemPrompt("auth flow", [
      {
        id: "e1",
        source: EvidenceSource.CODEBASE,
        filePath: "/repo/src/auth.ts",
        startLine: 12,
        endLine: 18,
        quote: "export function auth() {}",
        content: "export function auth() {}",
        score: 0.91,
        modality: "text",
        attribution: "/repo/src/auth.ts:12-18",
      },
    ])

    expect(prompt).toContain("<retrieved_context>")
    expect(prompt).toContain("/repo/src/auth.ts:12-18")
    expect(prompt).toContain("score=0.91")
  })

  test("filters out trivial or synthetic-only queries", () => {
    expect(shouldAutoGroundQuery("hi")).toBeFalse()
    expect(shouldAutoGroundQuery("<system-reminder>continue</system-reminder>")).toBeFalse()
    expect(shouldAutoGroundQuery("/help")).toBeFalse()
    expect(shouldAutoGroundQuery("trace how the auth middleware reaches the session loader")).toBeTrue()
  })
})