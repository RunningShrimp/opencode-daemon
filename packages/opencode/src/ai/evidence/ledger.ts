import { Storage } from "@/storage/storage"
import { Log } from "@/util/log"
import {
  EvidenceSource,
  createClaimRecord,
  createEvidenceItem,
  createEvidenceLedgerSnapshot,
  type ClaimRecord,
  type Evidence,
  type EvidenceItem,
  type EvidenceLedgerSnapshot,
} from "@/ai/thinking/evidence"
import { type GroundingBundle, type GroundingEvidence } from "@/ai/rag/evidence"

const log = Log.create({ service: "evidence.ledger" })
const MAX_CLAIMS = 40

export namespace EvidenceLedger {
  const cache = new Map<string, EvidenceLedgerSnapshot>()

  function key(sessionID: string) {
    return ["evidence", sessionID]
  }

  function fingerprint(record: ClaimRecord) {
    const support = record.evidence.map((item) => item.attribution.label).sort().join("|")
    const counter = record.counterEvidence.map((item) => item.attribution.label).sort().join("|")
    return `${record.source}:${record.claim}:${support}:${counter}`
  }

  function dedupeClaims(claims: ClaimRecord[]) {
    const seen = new Set<string>()
    const result: ClaimRecord[] = []
    for (const claim of [...claims].sort((a, b) => b.updatedAt - a.updatedAt)) {
      const id = fingerprint(claim)
      if (seen.has(id)) continue
      seen.add(id)
      result.push(claim)
      if (result.length >= MAX_CLAIMS) break
    }
    return result.sort((a, b) => a.createdAt - b.createdAt)
  }

  async function persist(snapshot: EvidenceLedgerSnapshot) {
    cache.set(snapshot.sessionID, snapshot)
    await Storage.write(key(snapshot.sessionID), snapshot).catch((error) => {
      log.warn("failed to persist evidence ledger", { sessionID: snapshot.sessionID, error: String(error) })
    })
  }

  export async function read(sessionID: string, projectID?: string) {
    const cached = cache.get(sessionID)
    if (cached) return cached

    const restored = await Storage.read<EvidenceLedgerSnapshot>(key(sessionID))
      .then((value) => createEvidenceLedgerSnapshot(value))
      .catch(() => undefined)

    if (restored) {
      cache.set(sessionID, restored)
      return restored
    }

    const snapshot = createEvidenceLedgerSnapshot({
      sessionID,
      projectID: projectID ?? "unknown",
      claims: [],
    })
    cache.set(sessionID, snapshot)
    return snapshot
  }

  export async function append(sessionID: string, projectID: string, claim: ClaimRecord) {
    const snapshot = await read(sessionID, projectID)
    const next = createEvidenceLedgerSnapshot({
      sessionID,
      projectID: snapshot.projectID === "unknown" ? projectID : snapshot.projectID,
      claims: dedupeClaims([...snapshot.claims, claim]),
    })
    await persist(next)
    return next
  }

  function itemFromGroundingEvidence(item: GroundingEvidence, contradicts = false): EvidenceItem {
    const location =
      typeof item.startLine === "number"
        ? `${item.filePath}:${item.startLine}${typeof item.endLine === "number" && item.endLine !== item.startLine ? `-${item.endLine}` : ""}`
        : item.filePath
    return createEvidenceItem({
      source: item.source,
      content: item.content,
      quote: item.quote,
      relevance: item.score,
      contradicts,
      attribution: {
        kind: item.source === EvidenceSource.WEB ? "web" : item.source === EvidenceSource.SEARCH ? "search" : "file",
        label: item.attribution,
        filePath: item.filePath,
        startLine: item.startLine,
        endLine: item.endLine,
        location,
      },
      metadata: item.metadata,
    })
  }

  function itemFromLegacyEvidence(item: Evidence): EvidenceItem {
    const label = item.location ?? item.quote ?? item.content.slice(0, 80)
    return createEvidenceItem({
      source: item.source,
      content: item.content,
      quote: item.quote,
      relevance: item.relevance,
      contradicts: item.contradicts,
      attribution: {
        kind: item.source === EvidenceSource.WEB ? "web" : item.source === EvidenceSource.SEARCH ? "search" : "unknown",
        label,
        location: item.location,
      },
      metadata: item.metadata,
    })
  }

  export function claimFromGroundingBundle(input: {
    bundle: GroundingBundle
    source: ClaimRecord["source"]
    metadata?: Record<string, unknown>
  }) {
    return createClaimRecord({
      claim: input.bundle.claim,
      confidence: input.bundle.confidence,
      evidence: input.bundle.evidence.map((item) => itemFromGroundingEvidence(item, false)),
      counterEvidence: input.bundle.counterEvidence.map((item) => itemFromGroundingEvidence(item, true)),
      source: input.source,
      metadata: input.metadata,
    })
  }

  export function claimFromEvidenceList(input: {
    hypothesis: string
    evidence: Evidence[]
    confidence: number
    source: ClaimRecord["source"]
    metadata?: Record<string, unknown>
  }) {
    return createClaimRecord({
      claim: input.hypothesis,
      confidence: input.confidence,
      evidence: input.evidence.filter((item) => !item.contradicts).map(itemFromLegacyEvidence),
      counterEvidence: input.evidence.filter((item) => item.contradicts).map(itemFromLegacyEvidence),
      source: input.source,
      metadata: input.metadata,
    })
  }

  export async function recordGrounding(input: {
    sessionID: string
    projectID: string
    bundle: GroundingBundle
    source: ClaimRecord["source"]
    metadata?: Record<string, unknown>
  }) {
    return append(input.sessionID, input.projectID, claimFromGroundingBundle(input))
  }

  export async function recordEvidenceCollection(input: {
    sessionID: string
    projectID: string
    hypothesis: string
    evidence: Evidence[]
    confidence: number
    source: ClaimRecord["source"]
    metadata?: Record<string, unknown>
  }) {
    return append(input.sessionID, input.projectID, claimFromEvidenceList(input))
  }

  export function formatPromptContext(snapshot: EvidenceLedgerSnapshot, maxClaims = 3, maxEvidencePerClaim = 2) {
    const claims = [...snapshot.claims].sort((a, b) => b.updatedAt - a.updatedAt).slice(0, maxClaims)
    if (claims.length === 0) return undefined

    const lines = [
      "<evidence_ledger>",
      "Recent evidence gathered in this session. Reuse it when relevant, but prefer fresher evidence if the repository has changed.",
    ]

    for (const claim of claims) {
      lines.push("")
      lines.push(`Claim: ${claim.claim}`)
      lines.push(`Confidence: ${claim.confidence.toFixed(2)} Source: ${claim.source}`)
      for (const item of claim.evidence.slice(0, maxEvidencePerClaim)) {
        lines.push(`- support ${item.attribution.label} (${item.relevance.toFixed(2)}): ${item.quote ?? item.content.slice(0, 160)}`)
      }
      for (const item of claim.counterEvidence.slice(0, maxEvidencePerClaim)) {
        lines.push(`- counter ${item.attribution.label} (${item.relevance.toFixed(2)}): ${item.quote ?? item.content.slice(0, 160)}`)
      }
    }

    lines.push("</evidence_ledger>")
    return lines.join("\n")
  }

  export async function renderPromptContext(sessionID: string, projectID?: string, maxClaims = 3, maxEvidencePerClaim = 2) {
    const snapshot = await read(sessionID, projectID)
    return formatPromptContext(snapshot, maxClaims, maxEvidencePerClaim)
  }

  export function resetForTest() {
    cache.clear()
  }
}