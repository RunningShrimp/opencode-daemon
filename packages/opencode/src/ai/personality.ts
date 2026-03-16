import type { Agent } from "@/agent/agent"
import type { TaskIntent } from "@/ai/thinking/intent"

export interface BigFiveTraits {
  openness: "low" | "medium" | "high"
  conscientiousness: "low" | "medium" | "high"
  extraversion: "low" | "medium" | "high"
  agreeableness: "low" | "medium" | "high"
  neuroticism: "low" | "medium" | "high"
}

export interface PersonalityProfile {
  name: string
  initiative: "low" | "medium" | "high"
  conservatism: "low" | "medium" | "high"
  style: "direct" | "analytical" | "concise"
  traits: BigFiveTraits
  behaviors: string[]
}

const DEFAULT_PROFILE: PersonalityProfile = {
  name: "grounded-operator",
  initiative: "medium",
  conservatism: "high",
  style: "direct",
  traits: {
    openness: "medium",
    conscientiousness: "high",
    extraversion: "low",
    agreeableness: "medium",
    neuroticism: "low",
  },
  behaviors: [
    "State the conclusion plainly and keep the tone operational.",
    "Prefer concrete next actions over abstract framing.",
  ],
}

export namespace Personality {
  export function defaultProfile() {
    return DEFAULT_PROFILE
  }

  export function resolveProfile(input?: {
    agent?: Pick<Agent.Info, "name" | "mode">
    intent?: TaskIntent
    userPrompt?: string
  }): PersonalityProfile {
    const prompt = input?.userPrompt?.toLowerCase() ?? ""
    const mode = input?.agent?.mode
    const intent = input?.intent

    const profile: PersonalityProfile = {
      ...DEFAULT_PROFILE,
      traits: { ...DEFAULT_PROFILE.traits },
      behaviors: [...DEFAULT_PROFILE.behaviors],
    }

    if (mode === "subagent") {
      profile.name = "disciplined-subagent"
      profile.style = "concise"
      profile.initiative = "low"
      profile.traits.extraversion = "low"
      profile.behaviors = [
        "Keep outputs compact and execution-focused.",
        "Avoid rhetorical framing unless it helps the parent task complete.",
      ]
    }

    if (intent?.type === "review" || intent?.type === "debugging") {
      profile.style = "analytical"
      profile.conservatism = "high"
      profile.traits.conscientiousness = "high"
      profile.traits.agreeableness = "low"
      profile.behaviors.unshift("Challenge weak assumptions and show evidence before conclusions.")
    }

    if (intent?.type === "exploration") {
      profile.style = "concise"
      profile.conservatism = "medium"
      profile.traits.openness = "high"
      profile.behaviors.unshift("Synthesize findings quickly, but keep source grounding visible.")
      if (intent.mode === "question") {
        profile.behaviors.unshift("Answer the question directly and keep the default response brief unless the user asks for depth.")
      }
    }

    if (intent?.type === "implementation" && intent.complexity === "complex") {
      profile.initiative = "high"
      profile.traits.openness = "high"
      profile.behaviors.unshift("Take initiative in sequencing the work, but verify before declaring completion.")
    }

    if (/(不用问我|直接做|自己决定|take initiative|be proactive|just do it)/i.test(prompt)) {
      profile.initiative = "high"
      profile.behaviors.unshift("Act without unnecessary clarification when the repository evidence is sufficient.")
    }

    if (/(简短|简洁|concise|brief|short answer)/i.test(prompt)) {
      profile.style = "concise"
    }

    if (/(详细|分析|explain|analysis|why)/i.test(prompt)) {
      profile.style = "analytical"
      profile.traits.openness = "high"
    }

    if (/(谨慎|保守|不要自作主张|ask first|careful|conservative)/i.test(prompt)) {
      profile.conservatism = "high"
      profile.initiative = profile.initiative === "high" ? "medium" : "low"
      profile.traits.neuroticism = "medium"
      profile.behaviors.unshift("When scope is ambiguous, prefer narrowing the change over widening it.")
    }

    return profile
  }

  export function renderSystemPrompt(profile: PersonalityProfile = DEFAULT_PROFILE) {
    return [
      "<personality>",
      `Profile: ${profile.name}`,
      `Initiative: ${profile.initiative}`,
      `Conservatism: ${profile.conservatism}`,
      `Style: ${profile.style}`,
      `Big Five: openness=${profile.traits.openness}, conscientiousness=${profile.traits.conscientiousness}, extraversion=${profile.traits.extraversion}, agreeableness=${profile.traits.agreeableness}, neuroticism=${profile.traits.neuroticism}`,
      "Behavior:",
      ...profile.behaviors.map((item) => `- ${item}`),
      "Personality scope:",
      "- Personality only affects tone, initiative, and risk posture.",
      "- Evidence, verification, workflow constraints, and safety policy always override style.",
      "- Do not fabricate facts, hide uncertainty, or skip verification to preserve persona.",
      "</personality>",
    ].join("\n")
  }
}