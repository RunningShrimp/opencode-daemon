import { describe, test, expect, beforeEach, afterEach } from "bun:test"
import {
  ImageAnalyzer,
  getImageAnalyzer,
  type ImageFeature,
} from "../../src/session/image-analyzer"

describe("ImageAnalyzer", () => {
  let analyzer: ImageAnalyzer

  beforeEach(() => {
    analyzer = new ImageAnalyzer()
  })

  describe("detectImages", () => {
    test("detects image parts from mixed parts array", () => {
      const parts = [
        { type: "text", text: "Hello" },
        { type: "file", mime: "image/png", filename: "test.png", url: "file://test.png" },
        { type: "file", mime: "text/plain", filename: "readme.txt", url: "file://readme.txt" },
        { type: "file", mime: "image/jpeg", filename: "photo.jpg", url: "file://photo.jpg" },
      ]

      const result = analyzer.detectImages(parts)

      expect(result).toHaveLength(2)
      expect(result[0].index).toBe(1)
      expect(result[1].index).toBe(3)
    })

    test("returns empty array when no images present", () => {
      const parts = [
        { type: "text", text: "Hello" },
        { type: "file", mime: "text/plain", filename: "readme.txt", url: "file://readme.txt" },
      ]

      const result = analyzer.detectImages(parts)

      expect(result).toHaveLength(0)
    })

    test("detects various image MIME types", () => {
      const imageTypes = [
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/bmp",
        "image/webp",
        "image/svg+xml",
        "image/tiff",
      ]

      const parts = imageTypes.map((mime, index) => ({
        type: "file",
        mime,
        filename: `image${index}.${mime.split("/")[1]}`,
        url: `file://image${index}`,
      }))

      const result = analyzer.detectImages(parts)

      expect(result).toHaveLength(imageTypes.length)
    })

    test("handles empty parts array", () => {
      const result = analyzer.detectImages([])
      expect(result).toHaveLength(0)
    })
  })

  describe("analyzeFeature", () => {
    test("analyzes image feature with basic properties", async () => {
      const imagePart = {
        mime: "image/png",
        filename: "test.png",
        url: "file://test.png",
      }

      const result = await analyzer.analyzeFeature(imagePart)

      expect(result).toBeDefined()
      expect(result.mimeType).toBe("image/png")
      expect(result.filename).toBe("test.png")
      expect(result.url).toBe("file://test.png")
      expect(result.complexity).toBeDefined()
      expect(["low", "medium", "high"]).toContain(result.complexity)
    })

    test("estimates high complexity for photos", async () => {
      const imagePart = {
        mime: "image/jpeg",
        filename: "photo.jpg",
        url: "file://photo.jpg",
      }

      const result = await analyzer.analyzeFeature(imagePart)

      expect(result.complexity).toBe("high")
    })

    test("estimates low complexity for icons and logos", async () => {
      const imagePart = {
        mime: "image/png",
        filename: "logo.png",
        url: "file://logo.png",
      }

      const result = await analyzer.analyzeFeature(imagePart)

      expect(result.complexity).toBe("low")
    })

    test("estimates medium complexity for screenshots", async () => {
      const imagePart = {
        mime: "image/png",
        filename: "screenshot.png",
        url: "file://screenshot.png",
      }

      const result = await analyzer.analyzeFeature(imagePart)

      expect(result.complexity).toBe("medium")
    })

    test("handles missing filename gracefully", async () => {
      const imagePart = {
        mime: "image/png",
      }

      const result = await analyzer.analyzeFeature(imagePart)

      expect(result.filename).toBe("unknown")
      expect(result.complexity).toBe("medium")
    })
  })

  describe("isImage", () => {
    test("returns true for image MIME types", () => {
      expect(analyzer.isImage("image/png")).toBe(true)
      expect(analyzer.isImage("image/jpeg")).toBe(true)
      expect(analyzer.isImage("image/gif")).toBe(true)
      expect(analyzer.isImage("image/webp")).toBe(true)
    })

    test("returns false for non-image MIME types", () => {
      expect(analyzer.isImage("text/plain")).toBe(false)
      expect(analyzer.isImage("application/json")).toBe(false)
      expect(analyzer.isImage("video/mp4")).toBe(false)
    })
  })

  describe("getSupportedMimeTypes", () => {
    test("returns array of supported MIME types", () => {
      const types = analyzer.getSupportedMimeTypes()

      expect(types).toContain("image/png")
      expect(types).toContain("image/jpeg")
      expect(types).toContain("image/gif")
      expect(types).toContain("image/webp")
    })
  })

  describe("validateSize", () => {
    test("validates image size within limit", () => {
      const feature: ImageFeature = {
        id: "test",
        mimeType: "image/png",
        size: 1024 * 1024, // 1MB
        complexity: "medium",
      }

      expect(analyzer.validateSize(feature, 10 * 1024 * 1024)).toBe(true) // 10MB limit
    })

    test("rejects image size over limit", () => {
      const feature: ImageFeature = {
        id: "test",
        mimeType: "image/png",
        size: 15 * 1024 * 1024, // 15MB
        complexity: "medium",
      }

      expect(analyzer.validateSize(feature, 10 * 1024 * 1024)).toBe(false) // 10MB limit
    })
  })

  describe("getImageAnalyzer singleton", () => {
    test("returns singleton instance", () => {
      const instance1 = getImageAnalyzer()
      const instance2 = getImageAnalyzer()

      expect(instance1).toBe(instance2)
    })
  })
})
