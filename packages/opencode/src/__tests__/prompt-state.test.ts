import { afterEach, describe, expect, test } from "bun:test"
import { createRoot, createSignal } from "solid-js"
import { usePromptState } from "../cli/cmd/tui/component/prompt/use-prompt-state"

describe("usePromptState", () => {
  const originalRandom = Math.random

  afterEach(() => {
    Math.random = originalRandom
  })

  test("resets prompt content and extmarks while preserving mode and interrupt", () => {
    let dispose = () => {}

    createRoot((rootDispose) => {
      dispose = rootDispose
      const [sessionID] = createSignal("session-1")
      const state = usePromptState(() => sessionID(), { placeholderCount: 4 })

      state.setPrompt({ input: "hello", parts: [] })
      state.replaceExtmarkToPartIndex(new Map([[7, 1]]))
      state.setMode("shell")
      state.incrementInterrupt()
      state.incrementInterrupt()
      state.reset()

      expect(state.store.prompt).toEqual({ input: "", parts: [] })
      expect(Array.from(state.store.extmarkToPartIndex.entries())).toEqual([])
      expect(state.store.mode).toBe("shell")
      expect(state.store.interrupt).toBe(2)
    })

    dispose()
  })

  test("supports prompt mutation helpers for runtime consumers", () => {
    let dispose = () => {}

    createRoot((rootDispose) => {
      dispose = rootDispose
      const [sessionID] = createSignal("session-1")
      const state = usePromptState(() => sessionID(), { placeholderCount: 3 })

      state.setPromptInput("draft")
      state.updatePrompt((prompt) => {
        prompt.input += " updated"
      })
      state.updateExtmarkToPartIndex((map) => new Map(map).set(3, 2))
      state.incrementInterrupt()
      state.resetInterrupt()

      expect(state.store.prompt.input).toBe("draft updated")
      expect(Array.from(state.store.extmarkToPartIndex.entries())).toEqual([[3, 2]])
      expect(state.store.interrupt).toBe(0)
    })

    dispose()
  })

  test("rotates placeholder using configured bounds", () => {
    Math.random = () => 0.9

    let dispose = () => {}

    createRoot((rootDispose) => {
      dispose = rootDispose
      const [sessionID] = createSignal("session-1")
      const state = usePromptState(() => sessionID(), { placeholderCount: 4 })

      expect(state.store.placeholder).toBe(3)
      Math.random = () => 0.1
      state.rotatePlaceholder()
      expect(state.store.placeholder).toBe(0)
    })

    dispose()
  })
})