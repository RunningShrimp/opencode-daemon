import { createStore, produce, type SetStoreFunction } from "solid-js/store"
import { createEffect, on, onMount, onCleanup } from "solid-js"
import type { PromptInfo } from "../prompt/history"

export interface PromptState {
  prompt: PromptInfo
  mode: "normal" | "shell"
  extmarkToPartIndex: Map<number, number>
  interrupt: number
  placeholder: number
}

const PLACEHOLDERS = ["Fix a TODO in codebase", "What is tech stack of this project?", "Fix broken tests"]
const SHELL_PLACEHOLDERS = ["ls -la", "git status", "pwd"]

export function usePromptState(sessionID: () => string | undefined, onPromptChange: (state: PromptState) => void) {
  const [store, setStore] = createStore<PromptState>({
    placeholder: Math.floor(Math.random() * PLACEHOLDERS.length),
    prompt: {
      input: "",
      parts: [],
    },
    mode: "normal",
    extmarkToPartIndex: new Map(),
    interrupt: 0,
  })

  createEffect(
    on(
      sessionID,
      () => {
        setStore("placeholder", Math.floor(Math.random() * PLACEHOLDERS.length))
      },
      { defer: true },
    ),
  )

  createEffect(() => {
    onPromptChange(store)
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

  const setPlaceholder = (placeholder: number) => {
    setStore("placeholder", placeholder)
  }

  const setInterrupt = (interrupt: number) => {
    setStore("interrupt", interrupt)
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
    setPlaceholder,
    setInterrupt,
    updateExtmarkToPartIndex,
  }
}
