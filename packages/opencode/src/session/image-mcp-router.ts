import { Log } from "@/util/log"
import {
  MCPSmartRouter,
  getGlobalMCPRouter,
  type MCPToolCapability,
  type RoutingDecision,
  type MCPRouterConfig,
} from "@/util/smart-router"
import { MCP } from "@/mcp"
import { Provider } from "@/provider/provider"
import { getImageAnalyzer, type ImageFeature } from "./image-analyzer"

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
  private router: MCPSmartRouter
  private initialized = false

  /**
   * Create a new ImageMCPRouter instance
   * @param router - Optional existing MCPSmartRouter instance to wrap
   */
  constructor(router?: MCPSmartRouter) {
    this.router = router ?? getGlobalMCPRouter()
  }

  /**
   * Initialize the router with available MCP tools
   * This should be called before using the router
   */
  async initialize(): Promise<void> {
    if (this.initialized) {
      return
    }

    this.router.initialize()
    await this.registerImageTools()
    this.initialized = true
    log.info("ImageMCPRouter initialized")
  }

  /**
   * Register all available MCP tools with image-related capabilities
   */
  private async registerImageTools(): Promise<void> {
    try {
      const mcpTools = await MCP.tools()
      const analyzer = getImageAnalyzer()

      for (const [toolId, tool] of Object.entries(mcpTools)) {
        // Check if this tool might be related to image processing
        const toolDescription = tool.description?.toLowerCase() || ""
        const toolName = toolId.toLowerCase()

        const isImageTool = IMAGE_TASK_KEYWORDS.some(
          (keyword) => toolDescription.includes(keyword) || toolName.includes(keyword.split(" ")[0]),
        )

        if (isImageTool) {
          const mcptoolCapability: MCPToolCapability = {
            toolId,
            name: tool.name || toolId,
            description: tool.description || "",
            serverName: this.extractServerName(toolId),
            serverType: "remote", // Assume remote for now
            suitableTaskTypes: ["image", "vision", "screenshot", "ocr"],
            responseTimes: [],
            successRates: [],
            errorRates: [],
            available: true,
            tags: this.extractImageTags(toolDescription),
            category: "image",
          }

          this.router.registerTool(mcptoolCapability)
          log.debug("registered image tool", { toolId, name: tool.name })
        }
      }
    } catch (error) {
      log.error("failed to register image tools", { error })
    }
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
  async findImageTools(): Promise<MCPToolCapability[]> {
    if (!this.initialized) {
      await this.initialize()
    }

    const allTools = this.router.getAllTools()
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
  async routeImageTask(task: string): Promise<RoutingDecision> {
    if (!this.initialized) {
      await this.initialize()
    }

    // Construct a detailed image analysis task description
    const imageTask = `analyze and describe this image: ${task}`
    const decision = this.router.selectTool(imageTask)

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
  async selectBestTool(features: ImageFeature[]): Promise<MCPToolCapability | null> {
    if (!this.initialized) {
      await this.initialize()
    }

    // Build task description based on image features
    const complexity = features[0]?.complexity || "medium"
    const mimeType = features[0]?.mimeType || ""

    let task = "analyze image content"
    if (mimeType.includes("png") || mimeType.includes("screenshot")) {
      task = "analyze screenshot and describe UI elements"
    } else if (mimeType.includes("jpeg") || mimeType.includes("jpg")) {
      task = "analyze photo and describe content"
    }

    const decision = await this.routeImageTask(task)
    return decision.selectedTool
  }

  /**
   * Get alternative tools for fallback
   * @param primaryTool - The primary selected tool
   * @returns Array of alternative tools
   */
  async getAlternativeTools(primaryTool: MCPToolCapability): Promise<MCPToolCapability[]> {
    if (!this.initialized) {
      await this.initialize()
    }

    const allImageTools = await this.findImageTools()
    return allImageTools.filter((tool) => tool.toolId !== primaryTool.toolId)
  }

  /**
   * Check if there are any available MCP image tools
   * @returns true if MCP image tools are available
   */
  async hasImageTools(): Promise<boolean> {
    const tools = await this.findImageTools()
    return tools.length > 0
  }

  /**
   * Get router statistics
   */
  getStats() {
    return this.router.getStats()
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
