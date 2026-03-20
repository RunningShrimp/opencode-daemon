import { describe, expect, test } from "bun:test"
import { getImageAnalyzer } from "../session/image-analyzer"

describe("ImageAnalyzer", () => {
  test("classifies error screenshots as text-dense UI artifacts", async () => {
    const analyzer = getImageAnalyzer()
    const feature = await analyzer.analyzeFeature({
      mime: "image/png",
      filename: "error-stacktrace-screenshot.png",
    })

    expect(feature.hints).toContain("error")
    expect(feature.hints).toContain("ui")
    expect(feature.textDensity).toBe("high")
    expect(feature.complexity).toBe("high")
  })

  test("classifies charts separately from generic photos", async () => {
    const analyzer = getImageAnalyzer()
    const feature = await analyzer.analyzeFeature({
      mime: "image/png",
      filename: "revenue-dashboard-chart.png",
    })

    expect(feature.hints).toContain("chart")
    expect(feature.textDensity).toBe("high")
    expect(feature.complexity).toBe("medium")
  })
})