import { createMemo, onCleanup } from "solid-js"
import { Keybind } from "@/util/keybind"
import { pipe, mapValues } from "remeda"
import type { TuiConfig } from "@/config/tui"
import type { ParsedKey, Renderable } from "@opentui/core"
import { createStore } from "solid-js/store"
import { useKeyboard, useRenderer } from "@opentui/solid"
import { createSimpleContext } from "./helper"
import { useTuiConfig } from "./tui-config"

export type KeybindKey = keyof NonNullable<TuiConfig.Info["keybinds"]> & string

export const { use: useKeybind, provider: KeybindProvider } = createSimpleContext({
  name: "Keybind",
  init: () => {
    const config = useTuiConfig()
    const keybinds = createMemo<Record<string, Keybind.Info[]>>(() => {
      return pipe(
        (config.keybinds ?? {}) as Record<string, string>,
        mapValues((value) => Keybind.parse(value)),
      )
    })
    const [store, setStore] = createStore({
      leader: false,
    })
    const renderer = useRenderer()

    let focus: Renderable | null
    let timeout: NodeJS.Timeout | undefined

    // Cleanup function to clear timeout when context is destroyed
    const cleanup = () => {
      if (timeout) {
        clearTimeout(timeout)
        timeout = undefined
      }
    }

    function leader(active: boolean) {
      if (active) {
        setStore("leader", true)
        focus = renderer.currentFocusedRenderable
        focus?.blur()
        // Clear any existing timeout before creating new one
        if (timeout) clearTimeout(timeout)
        // Use unref() to prevent timeout from blocking process exit
        timeout = setTimeout(() => {
          if (!store.leader) return
          leader(false)
          if (!focus || focus.isDestroyed) return
          focus.focus()
        }, 2000)
        // @ts-expect-error - unref is a valid method on NodeJS.Timeout in Bun
        timeout?.unref?.()
        return
      }

      if (!active) {
        if (focus && !renderer.currentFocusedRenderable) {
          focus.focus()
        }
        setStore("leader", false)
        // Clear timeout when leader mode is deactivated
        if (timeout) {
          clearTimeout(timeout)
          timeout = undefined
        }
      }
    }

    useKeyboard(async (evt) => {
      if (!store.leader && result.match("leader", evt)) {
        leader(true)
        return
      }

      if (store.leader && evt.name) {
        setImmediate(() => {
          if (focus && renderer.currentFocusedRenderable === focus) {
            focus.focus()
          }
          leader(false)
        })
      }
    })

    const result = {
      // Expose cleanup function for external use when context is disposed
      cleanup,
      get all() {
        return keybinds()
      },
      get leader() {
        return store.leader
      },
      parse(evt: ParsedKey): Keybind.Info {
        // Handle special case for Ctrl+Underscore (represented as \x1F)
        if (evt.name === "\x1F") {
          return Keybind.fromParsedKey({ ...evt, name: "_", ctrl: true }, store.leader)
        }
        return Keybind.fromParsedKey(evt, store.leader)
      },
      match(key: KeybindKey, evt: ParsedKey) {
        const keybind = keybinds()[key]
        if (!keybind) return false
        const parsed: Keybind.Info = result.parse(evt)
        for (const key of keybind) {
          if (Keybind.match(key, parsed)) {
            return true
          }
        }
      },
      print(key: KeybindKey) {
        const keybindList = keybinds()
        const leaderKeybinds = keybindList.leader
        const first = keybindList[key]?.at(0)
        if (!first) return ""
        const result = Keybind.toString(first)
        return result.replace("<leader>", leaderKeybinds ? Keybind.toString(leaderKeybinds[0]!) : "<leader>")
      },
    }
    return result
  },
})
