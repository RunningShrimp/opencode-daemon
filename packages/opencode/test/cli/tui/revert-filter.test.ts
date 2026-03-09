import { describe, expect, test } from "bun:test"
import { blank, drop, keep, hide } from "../../../src/cli/cmd/tui/routes/session/revert-filter"

describe("revert filter", () => {
  test("keeps messages when anchor is missing from window", () => {
    const ids = ["m200", "m201", "m202"]
    const cut = "m100"
    expect(keep(ids, cut)).toBe(true)
    expect(hide("m201", cut, keep(ids, cut))).toBe(false)
  })

  test("hides messages at and after anchor when anchor exists", () => {
    const ids = ["m100", "m101", "m102"]
    const cut = "m100"
    expect(keep(ids, cut)).toBe(false)
    expect(hide("m100", cut, keep(ids, cut))).toBe(true)
    expect(hide("m101", cut, keep(ids, cut))).toBe(true)
    expect(hide("m099", cut, keep(ids, cut))).toBe(false)
  })

  test("detects when the anchor would blank the window", () => {
    expect(blank(["m100", "m101", "m102"], "m100")).toBe(true)
    expect(blank(["m099", "m100", "m101"], "m100")).toBe(false)
    expect(blank(["m200", "m201"], "m100")).toBe(false)
  })

  test("drops the anchor once it becomes the oldest visible message", () => {
    expect(drop(["m100", "m101", "m102"], "m100")).toBe("m100")
    expect(drop(["m099", "m100", "m101"], "m100")).toBe("m099")
    expect(drop(["m200", "m201"], "m100")).toBe("m200")
  })
})
