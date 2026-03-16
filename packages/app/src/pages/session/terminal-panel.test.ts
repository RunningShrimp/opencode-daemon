import { describe, expect, test, vi, beforeEach, afterEach } from "bun:test"
import { terminalTabLabel } from "./terminal-label"
import { createRoot } from "solid-js"
import { createSizing, focusTerminalById, getTabReorderIndex } from "./helpers"

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

// ============================================================================
// Task 8: TerminalPanel Component Behavior Tests
// ============================================================================
// These tests verify the createEffect-based behaviors in terminal-panel.tsx:
// - Auto-create terminal when none exists (lines 62-71)
// - Panel auto-close when last terminal removed (lines 73-82)
// - Resize handling (lines 47-60)
// - Focus recovery after terminal closes
//
// NOTE: All behaviors use SolidJS createEffect which doesn't trigger properly
// in HappyDOM test environment. These tests are skipped pending a solution
// for testing SolidJS reactivity in unit tests.
// ============================================================================

describe("TerminalPanel behaviors", () => {
  // TODO: SolidJS createEffect doesn't trigger in HappyDOM test environment
  // See terminal-panel.tsx lines 62-71 for implementation
  test.skip("auto-creates terminal when none exists and panel becomes visible", async () => {
    // Expected behavior: When terminalIDs signal is empty and panel is visible,
    // createTerminal() should be called once
  })

  // TODO: SolidJS createEffect doesn't trigger in HappyDOM test environment
  // See terminal-panel.tsx lines 73-82 for implementation
  test.skip("auto-closes panel when last terminal is removed", async () => {
    // Expected behavior: When terminalIDs becomes empty, setPanelOpen(false)
    // should be called after a short delay
  })

  // TODO: SolidJS createEffect doesn't trigger in HappyDOM test environment
  // See terminal-panel.tsx lines 47-60 for implementation
  test.skip("handles resize correctly with debounce", async () => {
    // Expected behavior: When panel resizes, sizing.touch() should be called
    // to trigger terminal resize via onResize callback
  })

  // TODO: SolidJS createEffect doesn't trigger in HappyDOM test environment
  // See terminal-panel.tsx lines 84-116 for implementation
  test.skip("focuses appropriate terminal after one closes", async () => {
    // Expected behavior: When active terminal closes, focus should move to
    // remaining terminal (previous or first) with fallback strategies
  })

  test.skip("focus recovery uses RAF then timer fallback", async () => {
    // Expected behavior: Focus function tries requestAnimationFrame first,
    // then setTimeout(50ms) fallback, then pointerdown event dispatch
  })
})
