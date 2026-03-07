import { describe, expect, test } from "bun:test"
import { ProviderTransform } from "../src/provider/transform"

const createModel = (id: string, providerID: string, reasoning: boolean = true) => ({
  id: `${providerID}/${id}`,
  providerID,
  api: {
    id,
    url: `https://api.${providerID}.com`,
    npm: "@ai-sdk/openai-compatible",
  },
  name: id,
  capabilities: {
    temperature: true,
    reasoning,
    attachment: false,
    toolcall: true,
    input: { text: true, audio: false, image: false, video: false, pdf: false },
    output: { text: true, audio: false, image: false, video: false, pdf: false },
    interleaved: false,
  },
  cost: {
    input: 0.001,
    output: 0.002,
    cache: { read: 0.0001, write: 0.001 },
  },
  limit: {
    context: 200000,
    output: 128000,
  },
  status: "active" as const,
  options: {},
  headers: {},
  release_date: "2025-01-01",
})

describe("Thinking Markers Verification - minimax-m2.5 and glm-5", () => {
  test("minimax-m2.5 with reasoning=true should get variants", () => {
    const model = createModel("MiniMax-M2.5", "minimax", true)
    const result = ProviderTransform.variants(model)

    console.log("minimax-m2.5 variants:", JSON.stringify(result, null, 2))

    expect(result).not.toEqual({})
    expect(Object.keys(result).length).toBeGreaterThan(0)
    expect(result).toHaveProperty("low")
    expect(result).toHaveProperty("medium")
    expect(result).toHaveProperty("high")

    Object.values(result).forEach((variant) => {
      expect(variant).toHaveProperty("reasoningEffort")
    })
  })

  test("minimax-m2.5 with reasoning=false should not get variants", () => {
    const model = createModel("MiniMax-M2.5", "minimax", false)
    const result = ProviderTransform.variants(model)

    console.log("minimax-m2.5 (no reasoning) variants:", JSON.stringify(result, null, 2))

    expect(result).toEqual({})
  })

  test("glm-5 with reasoning=true should get variants", () => {
    const model = createModel("glm-5", "opencode", true)
    const result = ProviderTransform.variants(model)

    console.log("glm-5 variants:", JSON.stringify(result, null, 2))

    expect(result).not.toEqual({})
    expect(Object.keys(result).length).toBeGreaterThan(0)
    expect(result).toHaveProperty("low")
    expect(result).toHaveProperty("medium")
    expect(result).toHaveProperty("high")

    Object.values(result).forEach((variant) => {
      expect(variant).toHaveProperty("reasoningEffort")
    })
  })

  test("glm-4.6 with reasoning=true should get variants", () => {
    const model = createModel("glm-4.6", "opencode", true)
    const result = ProviderTransform.variants(model)

    console.log("glm-4.6 variants:", JSON.stringify(result, null, 2))

    expect(result).not.toEqual({})
    expect(Object.keys(result).length).toBeGreaterThan(0)
    expect(result).toHaveProperty("low")
    expect(result).toHaveProperty("medium")
    expect(result).toHaveProperty("high")
  })

  test("Verify thinking variants include reasoningEffort", () => {
    const models = [
      { id: "MiniMax-M2.5", provider: "minimax", reasoning: true },
      { id: "glm-5", provider: "opencode", reasoning: true },
      { id: "glm-4.6", provider: "opencode", reasoning: true },
    ]

    models.forEach(({ id, provider, reasoning }) => {
      const model = createModel(id, provider, reasoning)
      const result = ProviderTransform.variants(model)

      console.log(`\n${id} variants:`, JSON.stringify(result, null, 2))

      if (reasoning) {
        expect(result).not.toEqual({})
        expect(Object.keys(result).length).toBeGreaterThan(0)

        Object.entries(result).forEach(([level, variant]) => {
          expect(variant).toHaveProperty("reasoningEffort")
          console.log(`  ✓ ${level}: reasoningEffort = ${(variant as any).reasoningEffort}`)
        })
      } else {
        expect(result).toEqual({})
      }
    })
  })

  test("Compare before and after fix", () => {
    console.log("\n=== BEFORE FIX (hardcoded exclusion) ===")
    console.log("minimax models would return: {}")
    console.log("glm models would return: {}")

    console.log("\n=== AFTER FIX (reasoning capability-based) ===")

    const minimaxModel = createModel("MiniMax-M2.5", "minimax", true)
    const minimaxResult = ProviderTransform.variants(minimaxModel)
    console.log("minimax-m2.5 now returns:", JSON.stringify(minimaxResult, null, 2))
    expect(minimaxResult).not.toEqual({})

    const glmModel = createModel("glm-5", "opencode", true)
    const glmResult = ProviderTransform.variants(glmModel)
    console.log("glm-5 now returns:", JSON.stringify(glmResult, null, 2))
    expect(glmResult).not.toEqual({})

    console.log("\n✓ Fix verified: Models with reasoning=true now get thinking variants")
  })
})
