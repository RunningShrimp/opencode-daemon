import { z } from "zod"
import { Log } from "@/util/log"

const log = Log.create({ service: "image.analyzer" })

/**
 * Check if a MIME type is an image
 */
function isImageMimeType(mimeType: string): boolean {
  return mimeType.startsWith("image/")
}

/**
 * Image complexity levels based on expected visual content
 */
export type ImageComplexity = "low" | "medium" | "high"

/**
 * Image feature extracted from an image part
 */
export interface ImageFeature {
  /** Unique identifier for this image */
  id: string
  /** MIME type of the image */
  mimeType: string
  /** File size in bytes */
  size: number
  /** Original filename if available */
  filename?: string
  /** Image dimensions if available */
  dimensions?: {
    width: number
    height: number
  }
  /** Estimated complexity of image content */
  complexity: ImageComplexity
  /** Base64 encoded image data (if available for analysis) */
  base64?: string
  /** URL to the image (if available) */
  url?: string
}

/**
 * Result of image analysis including interpretation
 */
export interface ImageAnalysisResult {
  /** The analyzed image feature */
  feature: ImageFeature
  /** Text description of the image content */
  description?: string
  /** Detected text in the image (OCR) */
  extractedText?: string
  /** Any errors encountered during analysis */
  error?: string
}

/**
 * Input image part types supported by the analyzer
 */
export const ImagePartInput = z.object({
  type: z.literal("file"),
  mime: z.string(),
  filename: z.string().optional(),
  url: z.string().optional(),
})
export type ImagePartInput = z.infer<typeof ImagePartInput>

/**
 * ImageAnalyzer handles detection and feature extraction for images in user messages
 */
export class ImageAnalyzer {
  /**
   * Detect all image parts from a list of message parts
   * @param parts - Array of message parts to scan for images
   * @returns Array of detected image parts with their index positions
   */
  detectImages(
    parts: Array<{ type: string; mime?: string; url?: string; filename?: string }>,
  ): Array<{
    part: { type: string; mime?: string; url?: string; filename?: string }
    index: number
  }> {
    const imageParts: Array<{
      part: { type: string; mime?: string; url?: string; filename?: string }
      index: number
    }> = []

    for (let i = 0; i < parts.length; i++) {
      const part = parts[i]
      if (part.type === "file" && part.mime && isImageMimeType(part.mime)) {
        imageParts.push({ part, index: i })
      }
    }

    log.debug("detected images", { count: imageParts.length })
    return imageParts
  }

  /**
   * Analyze features of a single image
   * @param imagePart - The image part to analyze
   * @returns ImageFeature with extracted features
   */
  async analyzeFeature(imagePart: { mime?: string; url?: string; filename?: string }): Promise<ImageFeature> {
    const mimeType = imagePart.mime || "image/unknown"
    const filename = imagePart.filename || "unknown"

    // Estimate complexity based on filename hints and mime type
    const complexity = this.estimateComplexity(filename, mimeType)

    const feature: ImageFeature = {
      id: `img_${Date.now()}_${Math.random().toString(36).substring(7)}`,
      mimeType,
      size: 0, // Will be updated if we can get file size
      filename,
      complexity,
    }

    if (imagePart.url) {
      feature.url = imagePart.url
    }

    log.debug("analyzed image feature", {
      filename: feature.filename,
      mimeType: feature.mimeType,
      complexity: feature.complexity,
    })

    return feature
  }

  /**
   * Estimate image complexity based on filename patterns and mime type
   * @param filename - Original filename
   * @param mimeType - MIME type of the image
   * @returns Estimated complexity level
   */
  private estimateComplexity(filename: string, mimeType: string): ImageComplexity {
    const lower = filename.toLowerCase()

    // Screenshots and diagrams are typically medium complexity
    if (lower.includes("screenshot") || lower.includes("screen") || lower.includes("capture")) {
      return "medium"
    }

    // Charts, graphs, and diagrams are typically medium to high complexity
    if (
      lower.includes("chart") ||
      lower.includes("graph") ||
      lower.includes("diagram") ||
      lower.includes("flowchart")
    ) {
      return "medium"
    }

    // Photos are typically high complexity due to detail
    if (lower.includes("photo") || lower.includes("image") || mimeType === "image/jpeg") {
      return "high"
    }

    // Icons, logos, and simple graphics are typically low complexity
    if (lower.includes("icon") || lower.includes("logo") || lower.includes("avatar")) {
      return "low"
    }

    // SVGs can vary but are often simpler
    if (mimeType === "image/svg+xml") {
      return "low"
    }

    // Default to medium complexity
    return "medium"
  }

  /**
   * Check if a MIME type represents an image
   * @param mimeType - MIME type to check
   * @returns true if the MIME type is an image
   */
  isImage(mimeType: string): boolean {
    return isImageMimeType(mimeType)
  }

  /**
   * Get supported image MIME types
   * @returns Array of supported MIME type prefixes
   */
  getSupportedMimeTypes(): string[] {
    return [
      "image/png",
      "image/jpeg",
      "image/jpg",
      "image/gif",
      "image/bmp",
      "image/webp",
      "image/svg+xml",
      "image/tiff",
      "image/avif",
      "image/heic",
    ]
  }

  /**
   * Validate that an image meets size requirements
   * @param feature - Image feature to validate
   * @param maxSizeBytes - Maximum allowed size in bytes
   * @returns true if the image is within size limits
   */
  validateSize(feature: ImageFeature, maxSizeBytes: number): boolean {
    return feature.size <= maxSizeBytes
  }
}

/**
 * Singleton instance of ImageAnalyzer for reuse across the application
 */
let imageAnalyzerInstance: ImageAnalyzer | null = null

/**
 * Get the singleton ImageAnalyzer instance
 * @returns ImageAnalyzer instance
 */
export function getImageAnalyzer(): ImageAnalyzer {
  if (!imageAnalyzerInstance) {
    imageAnalyzerInstance = new ImageAnalyzer()
  }
  return imageAnalyzerInstance
}
