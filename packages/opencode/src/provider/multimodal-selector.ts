import { Log } from "@/util/log"
import { Provider } from "@/provider/provider"
import { snapshot } from "@/provider/models-snapshot"

const log = Log.create({ service: "multimodal.selector" })

/**
 * Cost budget levels for model selection
 */
export type CostBudget = "low" | "medium" | "high"

/**
 * Quality level for image understanding
 */
export type ImageQuality = "low" | "medium" | "high"

/**
 * Multimodal model option with capability information
 */
export interface MultimodalModelOption {
  /** Provider ID (e.g., "openai", "anthropic") */
  providerID: string
  /** Model ID (e.g., "gpt-4o") */
  modelID: string
  /** Human-readable model name */
  modelName: string
  /** Pricing information */
  cost: {
    /** Input cost per 1M tokens */
    input: number
    /** Output cost per 1M tokens */
    output: number
    /** Cache read cost per 1M tokens (if available) */
    cacheRead?: number
    /** Cache write cost per 1M tokens (if available) */
    cacheWrite?: number
  }
  /** Supported modalities */
  capabilities: {
    /** Supports image input */
    image: boolean
    /** Supports PDF input */
    pdf: boolean
    /** Supports video input */
    video: boolean
    /** Supports audio input */
    audio: boolean
  }
  /** Context window size */
  contextLimit: number
  /** Output token limit */
  outputLimit: number
  /** Image understanding quality rating */
  quality: ImageQuality
  /** Whether the model is open weights */
  openWeights: boolean
  /** Whether the model supports tool calling */
  toolCall: boolean
  /** Model release date */
  releaseDate: string
}

/**
 * Selection result with chosen model and reasoning
 */
export interface ModelSelectionResult {
  /** Selected model option */
  model: MultimodalModelOption | null
  /** Reason for selection */
  reason: string
  /** Available alternatives */
  alternatives: MultimodalModelOption[]
  /** Whether this is a fallback selection */
  isFallback: boolean
}

/**
 * Model selection options
 */
export interface ModelSelectionOptions {
  /** Cost budget constraint */
  budget?: CostBudget
  /** Preferred provider */
  preferredProvider?: string
  /** Whether to prefer open weights models */
  preferOpenWeights?: boolean
  /** Whether to require tool calling capability */
  requireToolCall?: boolean
  /** Minimum context window size */
  minContext?: number
  /** Image complexity to match quality level */
  imageComplexity?: "low" | "medium" | "high"
}

/**
 * MultimodalModelSelector selects the best multimodal model for image understanding tasks
 */
export class MultimodalModelSelector {
  private visionModelsCache: MultimodalModelOption[] | null = null

  /**
   * Get all available vision-capable models from the model snapshot
   * @returns Array of multimodal model options
   */
  async getVisionModels(): Promise<MultimodalModelOption[]> {
    if (this.visionModelsCache) {
      return this.visionModelsCache
    }

    const models: MultimodalModelOption[] = []

    // Iterate through all providers in the snapshot
    for (const [providerID, providerData] of Object.entries(snapshot)) {
      if (!providerData.models) continue

      for (const [modelID, modelData] of Object.entries(providerData.models)) {
        // Check if model supports image input
        const inputModalities = modelData.modalities?.input || []
        const supportsImage = inputModalities.includes("image")

        if (!supportsImage) continue

        models.push({
          providerID,
          modelID,
          modelName: modelData.name || modelID,
          cost: {
            input: modelData.cost?.input || 0,
            output: modelData.cost?.output || 0,
            cacheRead: modelData.cost?.cache_read,
            cacheWrite: modelData.cost?.cache_write,
          },
          capabilities: {
            image: inputModalities.includes("image"),
            pdf: inputModalities.includes("pdf"),
            video: inputModalities.includes("video"),
            audio: inputModalities.includes("audio"),
          },
          contextLimit: modelData.limit?.context || 32000,
          outputLimit: modelData.limit?.output || 4096,
          quality: this.estimateQuality(modelData),
          openWeights: modelData.open_weights || false,
          toolCall: modelData.tool_call || false,
          releaseDate: modelData.release_date || "unknown",
        })
      }
    }

    this.visionModelsCache = models
    log.debug("loaded vision models", { count: models.length })

    return models
  }

  /**
   * Estimate the image understanding quality based on model characteristics
   */
  private estimateQuality(modelData: any): ImageQuality {
    const modelName = (modelData.name || "").toLowerCase()
    const modelID = (modelData.id || "").toLowerCase()

    // Premium models typically have higher quality
    if (
      modelName.includes("pro") ||
      modelName.includes("premium") ||
      modelName.includes("advanced") ||
      modelID.includes("claude-3-5") ||
      modelID.includes("gpt-4o") ||
      modelID.includes("gemini-2") ||
      modelID.includes("2.5-pro")
    ) {
      return "high"
    }

    // Mini/Nano models are typically lower quality
    if (
      modelName.includes("mini") ||
      modelName.includes("nano") ||
      modelName.includes("small") ||
      modelName.includes("flash") ||
      modelID.includes("gpt-4o-mini") ||
      modelID.includes("gemini-2-flash") ||
      modelID.includes("haiku")
    ) {
      return "low"
    }

    // Default to medium
    return "medium"
  }

  /**
   * Get cost tier based on budget setting
   */
  private getCostThreshold(budget: CostBudget): { maxInput: number; maxOutput: number } {
    switch (budget) {
      case "low":
        return { maxInput: 0.5, maxOutput: 1.0 }
      case "medium":
        return { maxInput: 3.0, maxOutput: 6.0 }
      case "high":
        return { maxInput: Infinity, output: Infinity }
    }
  }

  /**
   * Select the best multimodal model based on requirements
   * @param options - Selection options
   * @returns Model selection result
   */
  async selectModel(options: ModelSelectionOptions = {}): Promise<ModelSelectionResult> {
    const {
      budget = "medium",
      preferredProvider,
      preferOpenWeights = false,
      requireToolCall = false,
      minContext = 16000,
      imageComplexity = "medium",
    } = options

    const allModels = await this.getVisionModels()
    const costThreshold = this.getCostThreshold(budget)

    // Filter models based on requirements
    let candidates = allModels.filter((model) => {
      // Cost filter
      if (model.cost.input > costThreshold.maxInput || model.cost.output > costThreshold.maxOutput) {
        return false
      }

      // Provider filter
      if (preferredProvider && model.providerID !== preferredProvider) {
        return false
      }

      // Open weights filter
      if (preferOpenWeights && !model.openWeights) {
        return false
      }

      // Tool calling filter
      if (requireToolCall && !model.toolCall) {
        return false
      }

      // Context minimum filter
      if (model.contextLimit < minContext) {
        return false
      }

      return true
    })

    // If no candidates, try with relaxed budget
    if (candidates.length === 0) {
      const relaxedThreshold = { maxInput: Infinity, maxOutput: Infinity }
      candidates = allModels.filter(
        (model) =>
          model.cost.input <= relaxedThreshold.maxInput &&
          model.cost.output <= relaxedThreshold.maxOutput &&
          model.contextLimit >= minContext,
      )
    }

    // Sort by quality and context limit
    const qualityOrder: Record<ImageQuality, number> = { high: 3, medium: 2, low: 1 }

    candidates.sort((a, b) => {
      // First prioritize matching quality to image complexity
      const aQualityMatch = this.qualityMatchesComplexity(a.quality, imageComplexity)
      const bQualityMatch = this.qualityMatchesComplexity(b.quality, imageComplexity)
      if (aQualityMatch && !bQualityMatch) return -1
      if (!aQualityMatch && bQualityMatch) return 1

      // Then sort by quality
      const qualityDiff = qualityOrder[b.quality] - qualityOrder[a.quality]
      if (qualityDiff !== 0) return qualityDiff

      // Then by context limit
      return b.contextLimit - a.contextLimit
    })

    const selected = candidates[0] || null
    const alternatives = candidates.slice(1, 4)

    let reason = ""
    if (selected) {
      reason = `Selected ${selected.modelName} from ${selected.providerID} for ${imageComplexity} complexity image`
      if (budget !== "high") {
        reason += ` within ${budget} budget`
      }
    } else {
      reason = "No suitable vision model found"
    }

    return {
      model: selected,
      reason,
      alternatives,
      isFallback: !selected,
    }
  }

  /**
   * Check if model quality matches image complexity requirements
   */
  private qualityMatchesComplexity(modelQuality: ImageQuality, imageComplexity: "low" | "medium" | "high"): boolean {
    if (imageComplexity === "low") return true
    if (imageComplexity === "medium") return modelQuality !== "low"
    return modelQuality === "high"
  }

  /**
   * Select the best model for specific image features
   * @param imageComplexity - Complexity level of the images to process
   * @param options - Additional selection options
   * @returns Model selection result
   */
  async selectForImageComplexity(
    imageComplexity: "low" | "medium" | "high",
    options: Omit<ModelSelectionOptions, "imageComplexity"> = {},
  ): Promise<ModelSelectionResult> {
    return this.selectModel({
      ...options,
      imageComplexity,
    })
  }

  /**
   * Get a model by provider and model ID
   * @param providerID - Provider ID
   * @param modelID - Model ID
   * @returns Model option or null if not found
   */
  async getModel(providerID: string, modelID: string): Promise<MultimodalModelOption | null> {
    const allModels = await this.getVisionModels()
    return allModels.find((m) => m.providerID === providerID && m.modelID === modelID) || null
  }

  /**
   * Check if any vision models are available
   * @returns true if vision models are available
   */
  async hasVisionModels(): Promise<boolean> {
    const models = await this.getVisionModels()
    return models.length > 0
  }

  /**
   * Clear the cached vision models list
   */
  clearCache(): void {
    this.visionModelsCache = null
  }
}

/**
 * Singleton instance of MultimodalModelSelector
 */
let selectorInstance: MultimodalModelSelector | null = null

/**
 * Get the singleton MultimodalModelSelector instance
 * @returns MultimodalModelSelector instance
 */
export function getMultimodalSelector(): MultimodalModelSelector {
  if (!selectorInstance) {
    selectorInstance = new MultimodalModelSelector()
  }
  return selectorInstance
}

/**
 * Convenience function to select the best vision model
 * @param options - Selection options
 * @returns Model selection result
 */
export async function selectVisionModel(options?: ModelSelectionOptions): Promise<ModelSelectionResult> {
  const selector = getMultimodalSelector()
  return selector.selectModel(options)
}

/**
 * Get all available vision models
 * @returns Array of vision model options
 */
export async function getVisionModels(): Promise<MultimodalModelOption[]> {
  const selector = getMultimodalSelector()
  return selector.getVisionModels()
}
