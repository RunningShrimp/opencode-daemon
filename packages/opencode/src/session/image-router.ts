import { Log } from "@/util/log"
import { Config } from "@/config/config"
import { getImageAnalyzer, type ImageFeature } from "./image-analyzer"
import { getImageMCPRouter, type ImageMCPRouter } from "./image-mcp-router"
import { getMultimodalSelector, type MultimodalModelSelector, type CostBudget } from "@/provider/multimodal-selector"
import { Provider } from "@/provider/provider"
import type { ModelID, ProviderID } from "@/provider/schema"
import { ModelID as ModelIDSchema, ProviderID as ProviderIDSchema } from "@/provider/schema"
import { getGlobalMCPRouter, getMCPRouter } from "@/util/smart-router"
import { withMcpLimit } from "@/util/concurrency-limiter"
import type { SessionID } from "./schema"

const log = Log.create({ service: "image.router" })

/**
 * Image understanding strategy types
 */
export type ImageStrategyType = "mcp" | "multimodal_model" | "text_fallback"

/**
 * Image understanding strategy with selected provider
 */
export interface ImageStrategy {
  /** Strategy type */
  type: ImageStrategyType
  /** Provider ID (for multimodal model) */
  providerID?: ProviderID
  /** Model ID (for multimodal model) */
  modelID?: ModelID
  /** MCP tool name (for MCP strategy) */
  mcpToolName?: string
  /** MCP server name (for MCP strategy) */
  mcpServerName?: string
  /** Human-readable reason for selection */
  reason: string
  /** Confidence score (0-1) */
  confidence: number
  /** Estimated cost */
  estimatedCost?: {
    input: number
    output: number
  }
  /** Session ID for router metrics */
  sessionID?: SessionID
}

/**
 * Image interpretation result
 */
export interface ImageInterpretationResult {
  /** The interpreted text */
  text: string
  /** Strategy used */
  strategy: ImageStrategy
  /** Processing time in milliseconds */
  processingTime: number
  /** Whether the result is a fallback */
  isFallback: boolean
}

/**
 * User context for routing decisions
 */
export interface RoutingContext {
  /** Current model being used */
  currentModel?: {
    providerID: ProviderID
    modelID: ModelID
  }
  /** Whether user prefers MCP */
  preferMcp?: boolean
  /** Cost budget setting */
  budget?: CostBudget
  /** Session ID for tracking */
  sessionID?: SessionID
}

/**
 * Configuration for image understanding
 */
export interface ImageUnderstandingConfig {
  /** Whether image understanding is enabled */
  enabled: boolean
  /** Whether to prefer MCP over multimodal models */
  preferMcp: boolean
  /** Cost budget level */
  budget: CostBudget
  /** Maximum image size in bytes */
  maxImageSize: number
  /** MCP timeout in milliseconds */
  mcpTimeout: number
  /** Model timeout in milliseconds */
  modelTimeout: number
}

/**
 * ImageRouter coordinates between MCP tools and multimodal models for image understanding
 */
export class ImageRouter {
  private analyzer: ReturnType<typeof getImageAnalyzer>
  private mcpRouter: ImageMCPRouter
  private multimodalSelector: MultimodalModelSelector
  private config: ImageUnderstandingConfig | null = null

  /**
   * Create a new ImageRouter instance
   */
  constructor() {
    this.analyzer = getImageAnalyzer()
    this.mcpRouter = getImageMCPRouter()
    this.multimodalSelector = getMultimodalSelector()
  }

  /**
   * Load configuration from Config
   */
  private async loadConfig(): Promise<ImageUnderstandingConfig> {
    if (this.config) {
      return this.config
    }

    const cfg = await Config.get()
    const imageConfig = (cfg as any).imageUnderstanding

    this.config = {
      enabled: imageConfig?.enabled ?? true,
      preferMcp: imageConfig?.preferMcp ?? true,
      budget: imageConfig?.budget ?? "medium",
      maxImageSize: imageConfig?.maxImageSize ?? 10 * 1024 * 1024, // 10MB
      mcpTimeout: imageConfig?.mcpTimeout ?? 30000,
      modelTimeout: imageConfig?.modelTimeout ?? 60000,
    }

    return this.config
  }

  /**
   * Detect images in message parts
   * @param parts - Array of message parts
   * @returns Array of detected image features
   */
  async detectImages(
    parts: Array<{ type: string; mime?: string; url?: string; filename?: string }>,
  ): Promise<ImageFeature[]> {
    const detectedParts = this.analyzer.detectImages(parts)
    const features: ImageFeature[] = []

    for (const { part } of detectedParts) {
      const feature = await this.analyzer.analyzeFeature(part)
      features.push(feature)
    }

    log.debug("detected images", { count: features.length })
    return features
  }

  /**
   * Select the best strategy for image understanding
   * @param features - Image features to analyze
   * @param context - Routing context
   * @returns Selected strategy
   */
  async selectStrategy(features: ImageFeature[], context: RoutingContext = {}): Promise<ImageStrategy> {
    const config = await this.loadConfig()
    const shouldBiasTowardMcp = features.some((feature) =>
      (feature.hints ?? []).some((hint) => ["error", "diagram", "chart", "document", "code"].includes(hint)),
    )

    if (!config.enabled) {
      return {
        type: "text_fallback",
        reason: "Image understanding is disabled in configuration",
        confidence: 0,
      }
    }

    // Check if MCP tools are preferred and available
    if (config.preferMcp || context.preferMcp || shouldBiasTowardMcp) {
      const hasMcpTools = await this.mcpRouter.hasImageTools(context.sessionID)
      if (hasMcpTools) {
        const bestTool = await this.mcpRouter.selectBestTool(features, context.sessionID)
        if (bestTool) {
          log.info("selected MCP strategy", { tool: bestTool.name, server: bestTool.serverName })
          return {
            type: "mcp",
            mcpToolName: bestTool.name,
            mcpServerName: bestTool.serverName,
            sessionID: context.sessionID,
            reason: `Selected MCP tool "${bestTool.name}" for image understanding`,
            confidence: 0.9,
          }
        }
      }
    }

    // Fall back to multimodal model
    const imageComplexity =
      features.some((feature) => feature.complexity === "high")
        ? "high"
        : features.some((feature) => feature.complexity === "medium")
          ? "medium"
          : "low"
    const modelResult = await this.multimodalSelector.selectForImageComplexity(imageComplexity, {
      budget: context.budget || config.budget,
      preferredProvider: context.currentModel?.providerID,
    })

    if (modelResult.model) {
      log.info("selected multimodal model strategy", {
        model: modelResult.model.modelID,
        provider: modelResult.model.providerID,
      })
      return {
        type: "multimodal_model",
        providerID: ProviderIDSchema.make(modelResult.model.providerID),
        modelID: ModelIDSchema.make(modelResult.model.modelID),
        sessionID: context.sessionID,
        reason: modelResult.reason,
        confidence: modelResult.isFallback ? 0.5 : 0.85,
        estimatedCost: {
          input: modelResult.model.cost.input,
          output: modelResult.model.cost.output,
        },
      }
    }

    // No suitable option found
    return {
      type: "text_fallback",
      reason: "No suitable image understanding tool or model found",
      confidence: 0,
    }
  }

  /**
   * Execute image understanding using the selected strategy
   * @param strategy - Selected strategy
   * @param features - Image features to analyze
   * @param prompt - User prompt about the image
   * @returns Interpretation result
   */
  async execute(strategy: ImageStrategy, features: ImageFeature[], prompt: string): Promise<ImageInterpretationResult> {
    const startTime = Date.now()
    let text = ""
    let isFallback = false

    try {
      switch (strategy.type) {
        case "mcp":
          text = await this.executeMCPStrategy(strategy, features, prompt)
          break
        case "multimodal_model":
          text = await this.executeModelStrategy(strategy, features, prompt)
          break
        case "text_fallback":
          text = this.generateFallbackMessage(features, prompt)
          isFallback = true
          break
      }
    } catch (error) {
      log.error("image interpretation failed", { error, strategy: strategy.type })
      text = `Image understanding failed: ${error instanceof Error ? error.message : "Unknown error"}`
      isFallback = true
    }

    const processingTime = Date.now() - startTime

    log.info("image interpretation complete", {
      strategy: strategy.type,
      processingTime,
      textLength: text.length,
      isFallback,
    })

    return {
      text,
      strategy,
      processingTime,
      isFallback,
    }
  }

  /**
   * Execute image understanding using MCP tool
   */
  private async executeMCPStrategy(strategy: ImageStrategy, features: ImageFeature[], prompt: string): Promise<string> {
    if (!strategy.mcpToolName || !strategy.mcpServerName) {
      throw new Error("Invalid MCP strategy: missing tool or server name")
    }

    const toolName = strategy.mcpToolName
    const serverName = strategy.mcpServerName
    const toolID = `${serverName.replace(/[^a-zA-Z0-9_-]/g, "_")}_${toolName.replace(/[^a-zA-Z0-9_-]/g, "_")}`
    const router = strategy.sessionID ? getMCPRouter(strategy.sessionID) : getGlobalMCPRouter()

    // Prepare image data for MCP tool
    const imageData = features.map((f) => ({
      url: f.url,
      base64: f.base64,
      mimeType: f.mimeType,
    }))

    log.debug("executing MCP tool", {
      tool: strategy.mcpToolName,
      server: strategy.mcpServerName,
      imageCount: imageData.length,
    })

    try {
      // Get MCP clients
      const { MCP } = await import("@/mcp")
      const clients = await MCP.clients()
      const client = clients[serverName]

      if (!client) {
        throw new Error(`MCP client not found: ${serverName}`)
      }

      // Call the tool with image data
      const started = Date.now()
      const result = await withMcpLimit(() =>
        client.callTool({
          name: toolName,
          arguments: {
            images: imageData,
            prompt: this.buildAnalysisPrompt(features, prompt),
          },
        }),
      )
      router.recordToolCall(toolID, true, Date.now() - started, strategy.sessionID)

      // Extract text content from result
      if (result.content && Array.isArray(result.content)) {
        const textContent = result.content
          .filter((c: any) => c.type === "text")
          .map((c: any) => c.text)
          .join("\n")

        if (textContent) {
          return textContent
        }
      }

      // If no text content, return a generic success message
      return `[Image analysis completed using ${strategy.mcpToolName}]`
    } catch (error) {
      router.recordToolCall(toolID, false, 0, strategy.sessionID)
      log.error("MCP tool execution failed", {
        tool: toolName,
        server: serverName,
        error,
      })
      throw error
    }
  }

  /**
   * Execute image understanding using multimodal model
   */
  private async executeModelStrategy(
    strategy: ImageStrategy,
    features: ImageFeature[],
    prompt: string,
  ): Promise<string> {
    if (!strategy.providerID || !strategy.modelID) {
      throw new Error("Invalid model strategy: missing provider or model ID")
    }

    const config = await this.loadConfig()

    log.debug("executing multimodal model", {
      provider: strategy.providerID,
      model: strategy.modelID,
      imageCount: features.length,
    })

    try {
      // Get the model from provider
      const model = await Provider.getModel(strategy.providerID, strategy.modelID)
      if (!model) {
        throw new Error(`Failed to get model: ${strategy.providerID}/${strategy.modelID}`)
      }

      // Prepare image content for the model
      const imageContents = await Promise.all(
        features.map(async (feature) => {
          // If we have base64 data, use it directly
          if (feature.base64) {
            return {
              type: "image" as const,
              image: feature.base64,
              mimeType: feature.mimeType,
            }
          }

          // If we have a URL, we need to fetch it
          if (feature.url) {
            try {
              const response = await fetch(feature.url)
              const buffer = await response.arrayBuffer()
              const base64 = Buffer.from(buffer).toString("base64")
              return {
                type: "image" as const,
                image: base64,
                mimeType: feature.mimeType,
              }
            } catch {
              // If fetch fails, skip this image
              return null
            }
          }

          return null
        }),
      )

      // Filter out null values
      const validContents = imageContents.filter((c): c is NonNullable<typeof c> => c !== null)

      if (validContents.length === 0) {
        throw new Error("No valid image content available for analysis")
      }

      // Use AI SDK to call the model with image content
      const { generateText } = await import("ai")

      const result = await generateText({
        model: model as any,
        messages: [
          {
            role: "user",
            content: [
              ...validContents,
              {
                type: "text",
                text: this.buildAnalysisPrompt(features, prompt),
              },
            ],
          },
        ],
        abortSignal: AbortSignal.timeout(config.modelTimeout),
      } as any)

      // Return the text result
      return result.text
    } catch (error) {
      log.error("multimodal model execution failed", {
        provider: strategy.providerID,
        model: strategy.modelID,
        error,
      })
      throw error
    }
  }

  /**
   * Generate fallback message when no suitable tool or model is available
   */
  private generateFallbackMessage(features: ImageFeature[], prompt: string): string {
    const imageCount = features.length
    const imageInfo = features.map((f) => f.filename || f.mimeType).join(", ")

    return `I see you've shared ${imageCount} image(s) (${imageInfo}), but I'm currently unable to analyze images because:
- No MCP tools with image understanding capabilities are available
- No multimodal models are configured

To enable image analysis, please either:
1. Configure an MCP server with image understanding tools
2. Add a multimodal model provider (e.g., OpenAI GPT-4V, Claude Vision, Google Gemini)

${prompt ? `Your question: ${prompt}` : ""}`
  }

  private buildAnalysisPrompt(features: ImageFeature[], prompt: string): string {
    const hints = [...new Set(features.flatMap((feature) => feature.hints))]
    const textDense = features.some((feature) => feature.textDensity === "high")
    const sections = [
      "Analyze the provided image carefully and ground the answer in visible evidence.",
      prompt ? `User request: ${prompt}` : "User request: Interpret the image and explain the important visible content.",
    ]

    if (hints.includes("error")) {
      sections.push("Prioritize extracting the exact error text, stack trace fragments, failing subsystem, and the most likely fix path.")
    }
    if (hints.includes("diagram")) {
      sections.push("Explain the diagram type, major components, arrows, labels, and the main flow or dependency structure.")
    }
    if (hints.includes("chart")) {
      sections.push("Read chart titles, axes, legends, and summarize the main quantitative trend instead of only describing colors or shapes.")
    }
    if (hints.includes("ui")) {
      sections.push("Describe the screen hierarchy, visible controls, current state, and any important text shown in the interface.")
    }
    if (hints.includes("document") || hints.includes("code") || textDense) {
      sections.push("Extract the most important visible text verbatim before summarizing it.")
    }
    if (hints.includes("photo") && !hints.includes("ui")) {
      sections.push("Describe the primary subjects, setting, actions, and anything unusual or relevant to the user's request.")
    }

    sections.push("When uncertain, say what is visible versus what is inferred.")
    return sections.join("\n")
  }

  /**
   * Process images in a message and return interpretation
   * @param parts - Message parts containing potential images
   * @param prompt - User prompt about the images
   * @param context - Routing context
   * @returns Interpretation result or null if no images found
   */
  async process(
    parts: Array<{ type: string; mime?: string; url?: string; filename?: string }>,
    prompt: string,
    context: RoutingContext = {},
  ): Promise<ImageInterpretationResult | null> {
    // Detect images
    const features = await this.detectImages(parts)

    if (features.length === 0) {
      return null
    }

    // Select strategy
    const strategy = await this.selectStrategy(features, context)

    // Execute strategy
    const result = await this.execute(strategy, features, prompt)

    return result
  }

  /**
   * Check if image understanding is available
   * @returns true if any image understanding capability is available
   */
  async isAvailable(): Promise<boolean> {
    const hasMcpTools = await this.mcpRouter.hasImageTools()
    const hasVisionModels = await this.multimodalSelector.hasVisionModels()

    return hasMcpTools || hasVisionModels
  }

  /**
   * Get available image understanding options
   */
  async getOptions(): Promise<{
    mcpTools: number
    visionModels: number
  }> {
    const mcpTools = await this.mcpRouter.findImageTools()
    const visionModels = await this.multimodalSelector.getVisionModels()

    return {
      mcpTools: mcpTools.length,
      visionModels: visionModels.length,
    }
  }
}

/**
 * Singleton instance of ImageRouter
 */
let routerInstance: ImageRouter | null = null

/**
 * Get the singleton ImageRouter instance
 * @returns ImageRouter instance
 */
export function getImageRouter(): ImageRouter {
  if (!routerInstance) {
    routerInstance = new ImageRouter()
  }
  return routerInstance
}

/**
 * Convenience function to process images in message parts
 * @param parts - Message parts
 * @param prompt - User prompt
 * @param context - Routing context
 * @returns Interpretation result or null
 */
export async function processImages(
  parts: Array<{ type: string; mime?: string; url?: string; filename?: string }>,
  prompt: string,
  context?: RoutingContext,
): Promise<ImageInterpretationResult | null> {
  const router = getImageRouter()
  return router.process(parts, prompt, context)
}
