import { describe, expect, test } from "bun:test"
import { IntentDetection } from "../ai/thinking/intent"

describe("IntentDetection", () => {
  test("prefers debugging over review for explicit failure prompts", () => {
    const intent = IntentDetection.detect("Review why the build failed with TypeScript error in src/app.ts")
    expect(intent.type).toBe("debugging")
  })

  test("detects security review from review-style wording", () => {
    const intent = IntentDetection.detect("Inspect this authentication flow for security vulnerabilities")
    expect(intent.type).toBe("review")
    if (intent.type === "review") {
      expect(intent.scope).toBe("security")
    }
  })

  test("classifies direct questions as exploration instead of implementation", () => {
    const intent = IntentDetection.detect("What does this repo do?")
    expect(intent.type).toBe("exploration")
    if (intent.type === "exploration") {
      expect(intent.mode).toBe("question")
    }
  })

  test("keeps concrete change requests as implementation even when phrased politely", () => {
    const intent = IntentDetection.detect("Can you add a retry timeout to the client?")
    expect(intent.type).toBe("implementation")
  })

  test("classifies arithmetic prompts as direct-question exploration", () => {
    const intent = IntentDetection.detect("Calculate 123 + 456. Reply with the number only.")
    expect(intent.type).toBe("exploration")
    if (intent.type === "exploration") {
      expect(intent.mode).toBe("question")
    }
  })
})