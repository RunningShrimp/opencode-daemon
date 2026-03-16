import { describe, expect, test } from "bun:test"
import { ExperienceLearning } from "../ai/thinking/experience-learning"

describe("ExperienceLearning", () => {
  test("matches learned patterns using contextual values", () => {
    const learning = new ExperienceLearning()

    for (let index = 0; index < 4; index++) {
      learning.recordExperience({
        situation: "implementation:apply_patch",
        action: "Apply focused TypeScript patch",
        outcome: "patch applied successfully",
        context: {
          taskType: "implementation",
          language: "typescript",
          framework: "react",
          complexity: "complex",
        },
        success: true,
        tags: ["implementation", "apply_patch", "typescript", "react"],
      })
    }

    learning.recordExperience({
      situation: "debugging:bash",
      action: "Run Python diagnostics",
      outcome: "diagnostics complete",
      context: {
        taskType: "debugging",
        language: "python",
        framework: "django",
        complexity: "moderate",
      },
      success: true,
      tags: ["debugging", "bash", "python", "django"],
    })

    const patterns = learning.getRelevantPatterns({
      taskType: "implementation",
      language: "typescript",
      framework: "react",
      complexity: "complex",
    })

    expect(patterns.length).toBeGreaterThan(0)
    expect(patterns[0]?.action).toContain("TypeScript patch")
    expect(patterns[0]?.conditions).toContain("task:implementation")
    expect(patterns[0]?.conditions).toContain("lang:typescript")
  })

  test("merges repeated experiences into a retained canonical record", () => {
    const learning = new ExperienceLearning()

    learning.recordExperience({
      situation: "implementation:apply_patch",
      action: "Apply focused TypeScript patch",
      outcome: "patched component",
      context: {
        taskType: "implementation",
        language: "typescript",
        framework: "react",
        complexity: "complex",
      },
      success: true,
      tags: ["implementation", "apply_patch"],
    })

    learning.recordExperience({
      situation: "implementation:apply_patch",
      action: "Apply focused TypeScript patch",
      outcome: "patched component with final fix",
      context: {
        taskType: "implementation",
        language: "typescript",
        framework: "react",
        complexity: "complex",
      },
      success: true,
      tags: ["implementation", "apply_patch", "react"],
      lessons: ["Keep patches focused"],
    })

    const snapshot = learning.snapshot()
    expect(snapshot.experiences).toHaveLength(1)
    expect(snapshot.experiences[0]?.timesApplied).toBe(2)
    expect(snapshot.experiences[0]?.timesSucceeded).toBe(2)
    expect(snapshot.experiences[0]?.outcome).toContain("final fix")
    expect(snapshot.experiences[0]?.tags).toContain("react")
  })
})