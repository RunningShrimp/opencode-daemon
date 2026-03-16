import { describe, expect, test } from "bun:test"
import { EvidenceLedger } from "../ai/evidence/ledger"
import { EvidenceSource } from "../ai/thinking/evidence"
import { GroundingBundle } from "../ai/rag/evidence"

describe("evidence ledger", () => {
  test("converts grounding bundles into unified claim records", () => {
    const claim = EvidenceLedger.claimFromGroundingBundle({
      source: "retrieval",
      bundle: GroundingBundle.parse({
        claim: "auth flow reaches session loader",
        confidence: 0.82,
        evidence: [
          {
            id: "e1",
            source: EvidenceSource.CODEBASE,
            filePath: "/repo/src/auth.ts",
            startLine: 10,
            endLine: 18,
            quote: "loadSession()",
            content: "function auth() { return loadSession() }",
            score: 0.82,
            modality: "text",
            attribution: "/repo/src/auth.ts:10-18",
          },
        ],
        counterEvidence: [],
      }),
    })

    expect(claim.claim).toBe("auth flow reaches session loader")
    expect(claim.source).toBe("retrieval")
    expect(claim.evidence[0]?.attribution.filePath).toBe("/repo/src/auth.ts")
    expect(claim.evidence[0]?.attribution.startLine).toBe(10)
  })

  test("formats recent evidence into prompt context", () => {
    const text = EvidenceLedger.formatPromptContext({
      version: 1,
      sessionID: "session_1",
      projectID: "project_1",
      updatedAt: Date.now(),
      claims: [
        {
          id: "c1",
          claim: "auth flow reaches session loader",
          confidence: 0.82,
          createdAt: Date.now(),
          updatedAt: Date.now(),
          source: "retrieval",
          metadata: {},
          evidence: [
            {
              id: "e1",
              source: EvidenceSource.CODEBASE,
              content: "function auth() { return loadSession() }",
              relevance: 0.82,
              timestamp: Date.now(),
              contradicts: false,
              quote: "loadSession()",
              attribution: {
                kind: "file",
                label: "/repo/src/auth.ts:10-18",
                filePath: "/repo/src/auth.ts",
                startLine: 10,
                endLine: 18,
              },
            },
          ],
          counterEvidence: [],
        },
      ],
    })

    expect(text).toContain("<evidence_ledger>")
    expect(text).toContain("Claim: auth flow reaches session loader")
    expect(text).toContain("/repo/src/auth.ts:10-18")
  })
})