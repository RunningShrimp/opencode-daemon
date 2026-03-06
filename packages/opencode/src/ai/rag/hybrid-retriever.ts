export interface HybridRetrieverConfig {
  vectorWeight: number
  keywordWeight: number
  rrfK: number
  alpha: number
}

const DEFAULT_HYBRID_CONFIG: HybridRetrieverConfig = {
  vectorWeight: 0.6,
  keywordWeight: 0.4,
  rrfK: 60,
  alpha: 0.5,
}

export interface SearchResult {
  id: string
  content: string
  path: string
  score: number
  source: "vector" | "keyword" | "hybrid"
}

export class HybridRetriever {
  private config: HybridRetrieverConfig

  constructor(config: Partial<HybridRetrieverConfig> = {}) {
    this.config = { ...DEFAULT_HYBRID_CONFIG, ...config }
  }

  hybridSearch(vectorResults: SearchResult[], keywordResults: SearchResult[]): SearchResult[] {
    const scoreMap = new Map<string, { result: SearchResult; rrfScore: number }>()

    for (let i = 0; i < vectorResults.length; i++) {
      const result = vectorResults[i]
      const rrfScore = 1 / (this.config.rrfK + i + 1)
      scoreMap.set(result.id, {
        result,
        rrfScore: rrfScore * this.config.vectorWeight,
      })
    }

    for (let i = 0; i < keywordResults.length; i++) {
      const result = keywordResults[i]
      const rrfScore = 1 / (this.config.rrfK + i + 1)
      const existing = scoreMap.get(result.id)
      if (existing) {
        existing.rrfScore += rrfScore * this.config.keywordWeight
        existing.result.source = "hybrid"
      } else {
        scoreMap.set(result.id, {
          result,
          rrfScore: rrfScore * this.config.keywordWeight,
        })
      }
    }

    const results = Array.from(scoreMap.values())
    results.sort((a, b) => b.rrfScore - a.rrfScore)

    return results.map((r) => r.result)
  }

  reciprocalRankFusion(ranks: number[], k: number = this.config.rrfK): number[] {
    return ranks.map((rank) => 1 / (k + rank))
  }
}

export const hybridRetriever = new HybridRetriever()
