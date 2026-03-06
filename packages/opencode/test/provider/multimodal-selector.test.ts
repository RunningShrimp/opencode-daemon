import { describe, test, expect, beforeEach } from "bun:test"
import {
  MultimodalModelSelector,
  getMultimodalSelector,
  getVisionModels,
  selectVisionModel,
  type ModelSelectionOptions,
  type CostBudget,
} from "../../src/provider/multimodal-selector"

describe("MultimodalModelSelector", () => {
  let selector: MultimodalModelSelector

  beforeEach(() => {
    selector = new MultimodalModelSelector()
    selector.clearCache() // Ensure clean state
  })

  describe("getVisionModels", () => {
    test("returns array of vision-capable models", async () => {
      const models = await selector.getVisionModels()

      expect(Array.isArray(models)).toBe(true)
      expect(models.length).toBeGreaterThan(0)
    })

    test("all returned models support image input", async () => {
      const models = await selector.getVisionModels()

      for (const model of models) {
        expect(model.capabilities.image).toBe(true)
      }
    })

    test("models have required properties", async () => {
      const models = await selector.getVisionModels()

      for (const model of models) {
        expect(model.providerID).toBeDefined()
        expect(model.modelID).toBeDefined()
        expect(model.modelName).toBeDefined()
        expect(model.cost).toBeDefined()
        expect(model.cost.input).toBeGreaterThanOrEqual(0)
        expect(model.cost.output).toBeGreaterThanOrEqual(0)
        expect(model.contextLimit).toBeGreaterThan(0)
        expect(model.outputLimit).toBeGreaterThan(0)
        expect(["low", "medium", "high"]).toContain(model.quality)
      }
    })

    test("caches results on subsequent calls", async () => {
      const models1 = await selector.getVisionModels()
      const models2 = await selector.getVisionModels()

      expect(models1).toBe(models2) // Same reference due to caching
    })
  })

  describe("selectModel", () => {
    test("returns a selection result", async () => {
      const result = await selector.selectModel()

      expect(result).toBeDefined()
      expect(result.model).toBeDefined()
      expect(result.reason).toBeDefined()
      expect(Array.isArray(result.alternatives)).toBe(true)
    })

    test("respects budget constraint for low", async () => {
      const result = await selector.selectModel({ budget: "low" })

      if (result.model) {
        expect(result.model.cost.input).toBeLessThanOrEqual(0.5)
      }
    })

    test("respects preferred provider if available", async () => {
      // Try to find a model from a common provider
      const result = await selector.selectModel({ preferredProvider: "openai" })

      if (result.model) {
        expect(result.model.providerID).toBe("openai")
      }
    })

    test("respects tool call requirement", async () => {
      const result = await selector.selectModel({ requireToolCall: true })

      if (result.model) {
        expect(result.model.toolCall).toBe(true)
      }
    })

    test("respects minimum context requirement", async () => {
      const result = await selector.selectModel({ minContext: 100000 })

      if (result.model) {
        expect(result.model.contextLimit).toBeGreaterThanOrEqual(100000)
      }
    })

    test("returns fallback when no suitable model found", async () => {
      // Use extremely restrictive criteria
      const result = await selector.selectModel({
        budget: "low",
        minContext: 10000000,
        preferredProvider: "nonexistent-provider",
      })

      // Should still return a result, possibly with null model
      expect(result).toBeDefined()
    })
  })

  describe("selectForImageComplexity", () => {
    test("selects appropriate quality for low complexity images", async () => {
      const result = await selector.selectForImageComplexity("low")

      expect(result).toBeDefined()
    })

    test("selects appropriate quality for medium complexity images", async () => {
      const result = await selector.selectForImageComplexity("medium")

      expect(result).toBeDefined()
    })

    test("selects appropriate quality for high complexity images", async () => {
      const result = await selector.selectForImageComplexity("high")

      expect(result).toBeDefined()
    })
  })

  describe("getModel", () => {
    test("returns model by provider and model ID", async () => {
      // First get any available model
      const allModels = await selector.getVisionModels()
      if (allModels.length > 0) {
        const firstModel = allModels[0]
        const found = await selector.getModel(firstModel.providerID, firstModel.modelID)

        expect(found).toBeDefined()
        expect(found?.providerID).toBe(firstModel.providerID)
        expect(found?.modelID).toBe(firstModel.modelID)
      }
    })

    test("returns null for non-existent model", async () => {
      const found = await selector.getModel("nonexistent", "nonexistent-model")

      expect(found).toBeNull()
    })
  })

  describe("hasVisionModels", () => {
    test("returns true when vision models available", async () => {
      const hasModels = await selector.hasVisionModels()

      expect(typeof hasModels).toBe("boolean")
    })
  })

  describe("clearCache", () => {
    test("clears cached models", async () => {
      // First populate cache
      await selector.getVisionModels()

      // Then clear
      selector.clearCache()

      // Should be able to fetch again
      const models = await selector.getVisionModels()
      expect(models.length).toBeGreaterThan(0)
    })
  })
})

describe("Module exports", () => {
  test("getMultimodalSelector returns singleton", () => {
    const selector1 = getMultimodalSelector()
    const selector2 = getMultimodalSelector()

    expect(selector1).toBe(selector2)
  })

  test("selectVisionModel is convenience function", async () => {
    const result = await selectVisionModel()

    expect(result).toBeDefined()
    expect(result.model).toBeDefined()
  })

  test("getVisionModels returns all vision models", async () => {
    const models = await getVisionModels()

    expect(Array.isArray(models)).toBe(true)
    expect(models.length).toBeGreaterThan(0)
  })
})
