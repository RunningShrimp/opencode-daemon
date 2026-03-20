import { Log } from "@/util/log"
import { MCPSmartRouter, getGlobalMCPRouter, getMCPRouter, type MCPToolCapability, type RoutingDecision } from "@/util/smart-router"
import { MCP } from "@/mcp"
import type { ImageFeature } from "./image-analyzer"

const log = Log.create({ service: "image.mcp.router" })

/**
 * Image-related task keywords for tool discovery
 */
const IMAGE_TASK_KEYWORDS = [
  "analyze image",
  "describe image",
  "screenshot analysis",
  "OCR text extraction",
  "visual understanding",
  "image description",
  "diagram recognition",
  "image recognition",
  "vision",
  "screenshot",
  "screen capture",
  "visual",
  "picture",
  "photo",
]

/**
 * ImageMCPRouter wraps MCPSmartRouter to provide specialized image understanding capabilities
 * by discovering and routing to MCP tools that support image analysis
 */
export class ImageMCPRouter {
  private router?: MCPSmartRouter

  /**
   * Create a new ImageMCPRouter instance
   * @param router - Optional existing MCPSmartRouter instance to wrap
   */
  constructor(router?: MCPSmartRouter) {
    this.router = router
  }

  private getRouter(sessionID?: string) {
    if (this.router) return this.router
    return sessionID ? getMCPRouter(sessionID) : getGlobalMCPRouter()
  }

  /**
   * Initialize the router with available MCP tools
   * This should be called before using the router
   */
  async initialize(sessionID?: string): Promise<void> {
    await MCP.capabilities({ sessionID, preferredCategory: "image" })
    log.info("ImageMCPRouter initialized", { sessionID })
  }

  /**
   * Extract server name from tool ID
   * Tool IDs are formatted as "serverName_toolName"
   */
  private extractServerName(toolId: string): string {
    const parts = toolId.split("_")
    return parts.length > 1 ? parts[0] : "unknown"
  }

  /**
   * Extract image-related tags from tool description
   */
  private extractImageTags(description: string): string[] {
    const tags: string[] = []
    const lower = description.toLowerCase()

    if (lower.includes("screenshot") || lower.includes("screen")) {
      tags.push("screenshot")
    }
    if (lower.includes("ocr") || lower.includes("text extraction") || lower.includes("文字识别")) {
      tags.push("ocr")
    }
    if (lower.includes("diagram") || lower.includes("chart") || lower.includes("graph")) {
      tags.push("diagram")
    }
    if (lower.includes("visual") || lower.includes("vision") || lower.includes("image")) {
      tags.push("vision")
    }

    return tags
  }

  /**
   * Find all MCP tools that could be used for image analysis
   * @returns Array of image-capable MCP tools
   */
  async findImageTools(sessionID?: string): Promise<MCPToolCapability[]> {
    await this.initialize(sessionID)

    const allTools = this.getRouter(sessionID).getAllTools()
    return allTools.filter((tool) => {
      // Check if tool has image-related tags or categories
      const hasImageTag = tool.tags.some((tag) =>
        ["image", "vision", "screenshot", "ocr", "diagram"].includes(tag.toLowerCase()),
      )
      const hasImageCategory = tool.category.toLowerCase().includes("image")
      const hasImageTaskType = tool.suitableTaskTypes.some((type) =>
        ["image", "vision", "screenshot"].includes(type.toLowerCase()),
      )

      return hasImageTag || hasImageCategory || hasImageTaskType
    })
  }

  /**
   * Use MCPSmartRouter to find the best tool for an image understanding task
   * @param task - Description of the image understanding task
   * @returns Routing decision with selected tool and alternatives
   */
  async routeImageTask(task: string, sessionID?: string): Promise<RoutingDecision> {
    const imageTask = `analyze and describe this image: ${task}`
    await MCP.capabilities({
      sessionID,
      task: imageTask,
      preferredCategory: "image",
    })
    const ranked = this.getRouter(sessionID).rankTools(imageTask, {
      category: "image",
      limit: 4,
    })
    const [selectedTool = null, ...alternatives] = ranked
    const decision: RoutingDecision = {
      selectedTool,
      alternatives,
      reason: selectedTool
        ? `Selected image MCP tool \"${selectedTool.name}\" for task \"${task}\"`
        : `No suitable image MCP tool found for \"${task}\"`,
      confidence: selectedTool ? 0.9 : 0,
      strategy: "direct",
    }

    log.info("routed image task", {
      task,
      selectedTool: decision.selectedTool?.name,
      confidence: decision.confidence,
      strategy: decision.strategy,
    })

    return decision
  }

  /**
   * Select the best tool for analyzing specific image features
   * @param features - Array of image features to analyze
   * @returns Best tool for the task, or null if no suitable tool found
   */
  async selectBestTool(features: ImageFeature[], sessionID?: string): Promise<MCPToolCapability | null> {
    const primary = features[0]
    const mimeType = primary?.mimeType || ""
    const hints = primary?.hints ?? []

    let task = "analyze image content"
    if (hints.includes("error")) {
      task = "analyze error screenshot, extract text, identify stack traces, and explain likely fixes"
    } else if (hints.includes("diagram")) {
      task = "analyze technical diagram and explain components, labels, and relationships"
    } else if (hints.includes("chart")) {
      task = "analyze chart or graph, read labels, and summarize key trends"
    } else if (hints.includes("document") || hints.includes("code")) {
      task = "analyze image with dense text and extract the important visible content accurately"
    } else if (mimeType.includes("png") || mimeType.includes("screenshot")) {
      task = "analyze screenshot and describe UI elements"
    } else if (mimeType.includes("jpeg") || mimeType.includes("jpg")) {
      task = "analyze photo and describe content"
    }

    const decision = await this.routeImageTask(task, sessionID)
    return decision.selectedTool
  }

  /**
   * Get alternative tools for fallback
   * @param primaryTool - The primary selected tool
   * @returns Array of alternative tools
   */
  async getAlternativeTools(primaryTool: MCPToolCapability, sessionID?: string): Promise<MCPToolCapability[]> {
    const allImageTools = await this.findImageTools(sessionID)
    return allImageTools.filter((tool) => tool.toolId !== primaryTool.toolId)
  }

  /**
   * Check if there are any available MCP image tools
   * @returns true if MCP image tools are available
   */
  async hasImageTools(sessionID?: string): Promise<boolean> {
    const tools = await this.findImageTools(sessionID)
    return tools.length > 0
  }

  /**
   * Get router statistics
   */
  getStats(sessionID?: string) {
    return this.getRouter(sessionID).getStats()
  }
}

/**
 * Singleton instance of ImageMCPRouter
 */
let imageMcpRouterInstance: ImageMCPRouter | null = null

/**
 * Get the singleton ImageMCPRouter instance
 * @returns ImageMCPRouter instance
 */
export function getImageMCPRouter(): ImageMCPRouter {
  if (!imageMcpRouterInstance) {
    imageMcpRouterInstance = new ImageMCPRouter()
  }
  return imageMcpRouterInstance
}

/**
 * Discover and return all image-capable MCP tools
 * This is a convenience function for quick tool discovery
 * @returns Array of image-capable MCP tools
 */
export async function discoverImageTools(): Promise<MCPToolCapability[]> {
  const router = getImageMCPRouter()
  await router.initialize()
  return await router.findImageTools()
}
