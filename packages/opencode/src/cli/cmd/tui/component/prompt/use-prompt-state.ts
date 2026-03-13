import { createStore, produce } from "solid-js/store"
import { createEffect } from "solid-js"
import type { PromptInfo } from "../prompt/history"

export interface PromptState {
  prompt: PromptInfo
  mode: "normal" | "shell"
  extmarkToPartIndex: Map<number, number>
  interrupt: number
  placeholder: number
}

function randomPlaceholder(count: number) {
  return Math.floor(Math.random() * Math.max(count, 1))
}

export function usePromptState(
  sessionID: () => string | undefined,
  options: {
    placeholderCount?: number
  } = {},
) {
  const placeholderCount = options.placeholderCount ?? 1
  const [store, setStore] = createStore<PromptState>({
    placeholder: randomPlaceholder(placeholderCount),
    prompt: {
      input: "",
      parts: [],
    },
    mode: "normal",
    extmarkToPartIndex: new Map(),
    interrupt: 0,
  })

  createEffect((previousSessionID?: string) => {
    const currentSessionID = sessionID()
    if (previousSessionID !== undefined && currentSessionID !== previousSessionID) {
      setStore("placeholder", randomPlaceholder(placeholderCount))
    }
    return currentSessionID
  })

  const reset = () => {
    setStore("prompt", {
      input: "",
      parts: [],
    })
    setStore("extmarkToPartIndex", new Map())
  }

  const setPrompt = (prompt: PromptInfo) => {
    setStore("prompt", prompt)
  }

  const setMode = (mode: PromptState["mode"]) => {
    setStore("mode", mode)
  }

  const updatePrompt = (updater: (prompt: PromptInfo) => void) => {
    setStore("prompt", produce(updater))
  }

  const setPromptInput = (input: string) => {
    setStore("prompt", "input", input)
  }

  const setPlaceholder = (placeholder: number) => {
    setStore("placeholder", placeholder)
  }

  const rotatePlaceholder = () => {
    setStore("placeholder", randomPlaceholder(placeholderCount))
  }

  const setInterrupt = (interrupt: number) => {
    setStore("interrupt", interrupt)
  }

  const incrementInterrupt = () => {
    setStore("interrupt", (value) => value + 1)
  }

  const resetInterrupt = () => {
    setStore("interrupt", 0)
  }

  const replaceExtmarkToPartIndex = (value: Map<number, number>) => {
    setStore("extmarkToPartIndex", value)
  }

  const updateExtmarkToPartIndex = (updater: (map: Map<number, number>) => Map<number, number>) => {
    setStore("extmarkToPartIndex", updater)
  }

  return {
    store,
    setStore,
    reset,
    setPrompt,
    setMode,
    updatePrompt,
    setPromptInput,
    setPlaceholder,
    rotatePlaceholder,
    setInterrupt,
    incrementInterrupt,
    resetInterrupt,
    replaceExtmarkToPartIndex,
    updateExtmarkToPartIndex,
  }
}
