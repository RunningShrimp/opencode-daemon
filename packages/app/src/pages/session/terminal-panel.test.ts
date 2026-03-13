import { describe, expect, test, vi, beforeEach, afterEach } from "bun:test"
import { terminalTabLabel } from "./terminal-label"
import { createRoot, createSignal } from "solid-js"
import { createSizing, focusTerminalById, getTabReorderIndex, createPresence } from "./helpers"

const t = (key: string, vars?: Record<string, string | number | boolean>) => {
  if (key === "terminal.title.numbered") return `Terminal ${vars?.number}`
  if (key === "terminal.title") return "Terminal"
  return key
}

describe("terminalTabLabel", () => {
  test("returns custom title unchanged", () => {
    const label = terminalTabLabel({ title: "server", titleNumber: 3, t })
    expect(label).toBe("server")
  })

  test("normalizes default numbered title", () => {
    const label = terminalTabLabel({ title: "Terminal 2", titleNumber: 2, t })
    expect(label).toBe("Terminal 2")
  })

  test("falls back to generic title", () => {
    const label = terminalTabLabel({ title: "", titleNumber: 0, t })
    expect(label).toBe("Terminal")
  })
})

describe("createSizing", () => {
  test("touch keeps sizing active until debounce expires", () => {
    vi.useFakeTimers()
    try {
      let dispose = () => {}
      let sizing: ReturnType<typeof createSizing> | undefined

      createRoot((rootDispose) => {
        dispose = rootDispose
        sizing = createSizing()
      })

      sizing!.touch()
      expect(sizing!.active()).toBe(true)

      vi.advanceTimersByTime(119)
      expect(sizing!.active()).toBe(true)

      vi.advanceTimersByTime(1)
      expect(sizing!.active()).toBe(false)

      dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  test("repeated touch refreshes the debounce window", () => {
    vi.useFakeTimers()
    try {
      let dispose = () => {}
      let sizing: ReturnType<typeof createSizing> | undefined

      createRoot((rootDispose) => {
        dispose = rootDispose
        sizing = createSizing()
      })

      sizing!.touch()
      vi.advanceTimersByTime(80)
      sizing!.touch()

      vi.advanceTimersByTime(80)
      expect(sizing!.active()).toBe(true)

      vi.advanceTimersByTime(40)
      expect(sizing!.active()).toBe(false)

      dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})

describe("focusTerminalById", () => {
  test("returns false when wrapper element does not exist", () => {
    const result = focusTerminalById("nonexistent")
    expect(result).toBe(false)
  })

  test("returns false when terminal element is not an HTMLElement", () => {
    const wrapper = document.createElement("div")
    wrapper.id = "terminal-wrapper-test"
    document.body.appendChild(wrapper)

    const result = focusTerminalById("test")
    expect(result).toBe(false)

    document.body.removeChild(wrapper)
  })

  test("focuses textarea when present and returns true", () => {
    const wrapper = document.createElement("div")
    wrapper.id = "terminal-wrapper-textarea-test"
    const terminal = document.createElement("div")
    terminal.setAttribute("data-component", "terminal")
    const textarea = document.createElement("textarea")
    terminal.appendChild(textarea)
    wrapper.appendChild(terminal)
    document.body.appendChild(wrapper)

    const focusSpy = vi.spyOn(textarea, "focus")
    const result = focusTerminalById("textarea-test")

    expect(result).toBe(true)
    expect(focusSpy).toHaveBeenCalled()

    document.body.removeChild(wrapper)
  })

  test("falls back to focus and pointerdown dispatch when no textarea", () => {
    const wrapper = document.createElement("div")
    wrapper.id = "terminal-wrapper-notextarea-test"
    const terminal = document.createElement("div")
    terminal.setAttribute("data-component", "terminal")
    wrapper.appendChild(terminal)
    document.body.appendChild(wrapper)

    const focusSpy = vi.spyOn(terminal, "focus")
    const dispatchSpy = vi.spyOn(terminal, "dispatchEvent")
    const result = focusTerminalById("notextarea-test")

    expect(result).toBe(true)
    expect(focusSpy).toHaveBeenCalled()
    expect(dispatchSpy).toHaveBeenCalled()

    document.body.removeChild(wrapper)
  })
})

describe("getTabReorderIndex", () => {
  test("returns undefined when from tab not in list", () => {
    const tabs = ["a", "b", "c"]
    const result = getTabReorderIndex(tabs, "missing", "b")
    expect(result).toBeUndefined()
  })

  test("returns undefined when to tab not in list", () => {
    const tabs = ["a", "b", "c"]
    const result = getTabReorderIndex(tabs, "a", "missing")
    expect(result).toBeUndefined()
  })

  test("returns undefined when from and to are the same", () => {
    const tabs = ["a", "b", "c"]
    const result = getTabReorderIndex(tabs, "b", "b")
    expect(result).toBeUndefined()
  })

  test("returns toIndex for valid reorder", () => {
    const tabs = ["a", "b", "c", "d"]
    const result = getTabReorderIndex(tabs, "a", "c")
    expect(result).toBe(2)
  })
})

describe("createPresence", () => {
  test("initializes with show and open matching initial accessor value", () => {
    let dispose = () => {}
    let presence: ReturnType<typeof createPresence> | undefined

    createRoot((rootDispose) => {
      dispose = rootDispose
      presence = createPresence(() => true)
    })

    expect(presence!.show()).toBe(true)
    expect(presence!.open()).toBe(true)
    dispose()
  })

  test("initializes as hidden when accessor is false", () => {
    let dispose = () => {}
    let presence: ReturnType<typeof createPresence> | undefined

    createRoot((rootDispose) => {
      dispose = rootDispose
      presence = createPresence(() => false)
    })

    expect(presence!.show()).toBe(false)
    expect(presence!.open()).toBe(false)
    dispose()
  })

  // TODO: SolidJS createEffect doesn't trigger in HappyDOM test environment
  test.skip("opens: sets show=true then RAF to set open=true", async () => {
    vi.useFakeTimers()
    try {
      let dispose = () => {}
      const [signal, setSignal] = createSignal(false)
      let presence: ReturnType<typeof createPresence> | undefined

      createRoot((rootDispose) => {
        dispose = rootDispose
        presence = createPresence(signal)
      })

      expect(presence!.show()).toBe(false)
      expect(presence!.open()).toBe(false)

      setSignal(true)
      vi.runAllTimers()

      expect(presence!.show()).toBe(true)
      expect(presence!.open()).toBe(true)
      dispose()
    } finally {
      vi.useRealTimers()
    }
  })

  test.skip("closes: sets open=false, delays wait ms, then sets show=false", async () => {
    vi.useFakeTimers()
    try {
      let dispose = () => {}
      const [signal, setSignal] = createSignal(true)
      let presence: ReturnType<typeof createPresence> | undefined

      createRoot((rootDispose) => {
        dispose = rootDispose
        presence = createPresence(signal, 50)
      })

      expect(presence!.show()).toBe(true)
      expect(presence!.open()).toBe(true)

      setSignal(false)
      vi.runAllTimers()

      expect(presence!.open()).toBe(false)
      expect(presence!.show()).toBe(false)
      dispose()
    } finally {
      vi.useRealTimers()
    }
  })
})
