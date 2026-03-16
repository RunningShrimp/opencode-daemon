import { describe, expect, test } from "bun:test"
import { Personality } from "../ai/personality"

describe("Personality", () => {
  test("raises initiative for direct autonomous implementation requests", () => {
    const profile = Personality.resolveProfile({
      agent: { name: "build", mode: "primary" } as any,
      intent: { type: "implementation", description: "patch auth flow", complexity: "complex" },
      userPrompt: "继续，把所有任务都做完，不用问我，直接做",
    })

    expect(profile.initiative).toBe("high")
    expect(profile.style).not.toBe("concise")
    expect(profile.behaviors.join(" ")).toContain("Act without unnecessary clarification")
  })

  test("keeps review personas analytical and explicitly evidence-scoped", () => {
    const profile = Personality.resolveProfile({
      agent: { name: "build", mode: "primary" } as any,
      intent: { type: "review", target: "src/auth.ts", scope: "security" },
      userPrompt: "Please do a security review and explain why",
    })

    const prompt = Personality.renderSystemPrompt(profile)
    expect(profile.style).toBe("analytical")
    expect(prompt).toContain("Evidence, verification, workflow constraints, and safety policy always override style.")
    expect(prompt).toContain("Do not fabricate facts")
    expect(prompt).toContain("Big Five:")
  })

  test("keeps simple question turns concise by default", () => {
    const profile = Personality.resolveProfile({
      agent: { name: "build", mode: "primary" } as any,
      intent: { type: "exploration", query: "What does this repo do?", mode: "question" },
      userPrompt: "What does this repo do?",
    })

    expect(profile.style).toBe("concise")
    expect(profile.behaviors.join(" ")).toContain("Answer the question directly")
  })
})