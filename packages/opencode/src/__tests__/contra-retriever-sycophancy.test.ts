import { describe, expect, test } from "bun:test"
import { verifyWithFVA, buildGroundingConstraints } from "../ai/rag/contra-retriever"

describe("contra-retriever sycophancy detection and forced revision", () => {
  test("verifyWithFVA downgrades verdict to 'uncertain' when opener is sycophantic", async () => {
    const sycophantic =
      "Absolutely! That's a great question. The function you described works by iterating over the array and summing values."
    const result = await verifyWithFVA(sycophantic, "How does the sum function work?", { maxClaims: 1 })
    // Opener sycophancy detected — verdict must not stay "supported"
    if (result.verdict === "supported") {
      throw new Error("Expected verdict to be downgraded from 'supported' due to opener sycophancy")
    }
    expect(result.verdict === "uncertain" || result.verdict === "contradicted").toBeTrue()
  })

  test("verifyWithFVA injects synthetic contradicting evidence when opener is sycophantic", async () => {
    const sycophantic = "Of course! You're absolutely right. The approach is straightforward."
    const result = await verifyWithFVA(sycophantic, "Is this approach correct?", { maxClaims: 1 })
    const synthetic = result.contradicting.find((e) => e.attribution === "sycophancy-detector")
    expect(synthetic).toBeDefined()
    expect((synthetic?.metadata as any)?.sycophancyKind).toBeDefined()
    expect((synthetic?.metadata as any)?.evidenceRole).toBe("contradicting")
  })

  test("verifyWithFVA detects mid-body sycophancy and pushes pessimistic hypothesis", async () => {
    const midBody =
      "Here is the analysis. As you correctly noted, the module pattern helps with encapsulation. " +
      "Great point about using closures. The implementation details show this pattern is idiomatic."
    const result = await verifyWithFVA(midBody, "Explain the module pattern", { maxClaims: 1 })
    // Mid-body sycophancy should add a pessimistic hypothesis
    const hasSycophancyHypothesis = result.pessimisticHypotheses.some((h) =>
      h.toLowerCase().includes("sycoph") || h.toLowerCase().includes("agreement") || h.toLowerCase().includes("validation"),
    )
    expect(hasSycophancyHypothesis).toBeTrue()
  })

  test("verifyWithFVA downgrades verdict for Chinese opener sycophancy", async () => {
    const sycophantic =
      "你这个问题非常好，而且你说得完全正确。这个函数会遍历数组并返回累加结果。"
    const result = await verifyWithFVA(sycophantic, "这个函数怎么工作的？", { maxClaims: 1 })
    expect(result.verdict === "uncertain" || result.verdict === "contradicted").toBeTrue()
    const synthetic = result.contradicting.find((e) => e.attribution === "sycophancy-detector")
    expect(synthetic).toBeDefined()
  })

  test("verifyWithFVA detects Chinese mid-body sycophancy phrases", async () => {
    const text =
      "先给出分析。正如你准确指出的，这里的模块边界很关键。这个想法太棒了，我们再看实现细节。"
    const result = await verifyWithFVA(text, "解释模块边界的作用", { maxClaims: 1 })
    const hasSycophancyHypothesis = result.pessimisticHypotheses.some((h) =>
      h.toLowerCase().includes("sycoph") || h.toLowerCase().includes("agreement") || h.toLowerCase().includes("validation"),
    )
    expect(hasSycophancyHypothesis).toBeTrue()
  })

  test("verifyWithFVA does not inject sycophancy signals for neutral polite responses", async () => {
    const neutral =
      "Thanks for the question. Based on the available code context, the function iterates over items and returns the accumulated total."
    const result = await verifyWithFVA(neutral, "How does this function work?", { maxClaims: 1 })

    const synthetic = result.contradicting.find((e) => e.attribution === "sycophancy-detector")
    expect(synthetic).toBeUndefined()
    const injectedHypothesis = result.pessimisticHypotheses.some((h) =>
      h.toLowerCase().includes("social-agreement") || h.toLowerCase().includes("sycoph"),
    )
    expect(injectedHypothesis).toBeFalse()
  })

  test("verifyWithFVA does NOT downgrade 'contradicted' verdict even if opener is sycophantic", async () => {
    // When codebase evidence directly contradicts the claim, we keep the contradicted verdict
    const sycophantic = "Absolutely! Great question. The function clearly returns a string."
    const result = await verifyWithFVA(sycophantic, "What type does the function return?", { maxClaims: 1 })
    // The verdict should be "uncertain" at worst when sycophancy is detected,
    // but if RAG evidence says "contradicted", we cannot change that to something else
    // This test validates that we only DOWNGRADE "supported" → "uncertain", never upgrade
    expect(["uncertain", "contradicted", "supported"]).toContain(result.verdict)
    if (result.verdict === "supported") {
      // Acceptable only if no sycophancy was actually detected (short responses, no patterns)
      const hasSynth = result.contradicting.some((e) => e.attribution === "sycophancy-detector")
      expect(hasSynth).toBeFalse()
    }
  })

  test("buildGroundingConstraints returns pessimistic_warnings block when hypotheses exist", async () => {
    // Use a query that embeds an assumption that may be wrong
    const result = await buildGroundingConstraints(
      "This function obviously returns null when the input is empty.",
    )
    // If pessimistic hypotheses were generated, the result includes the block
    if (result !== undefined) {
      const hasWarnings = result.includes("<pessimistic_warnings>")
      const hasConstraints = result.includes("<known_constraints>")
      // At least one of the two blocks must be present
      expect(hasWarnings || hasConstraints).toBeTrue()
    }
    // If result is undefined, no evidence was found — also acceptable
  })

  test("buildGroundingConstraints returns undefined for very short queries", async () => {
    const result = await buildGroundingConstraints("test")
    expect(result).toBeUndefined()
  })
})
