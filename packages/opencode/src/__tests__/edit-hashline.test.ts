import { describe, expect, test } from "bun:test"
import { hashFile } from "../util/hashline"
import { replace } from "../tool/edit-core"

describe("edit hashline integration", () => {
  test("uses oldRange to disambiguate duplicate matches", () => {
    const filePath = "/repo/test.ts"
    const content = ["const x = 1", "console.log(x)", "", "const x = 1", "console.log(x)"].join("\n")
    const hashed = hashFile(filePath, content)
    const first = hashed.lines[0]

    const result = replace(content, "const x = 1", "const x = 2", false, {
      filePath,
      oldRange: `${first.number}#${first.hash}-${first.number}#${first.hash}`,
    })

    expect(result).toBe(["const x = 2", "console.log(x)", "", "const x = 1", "console.log(x)"].join("\n"))
  })

  test("limits replaceAll to the verified hashline block", () => {
    const filePath = "/repo/test.ts"
    const content = ["const x = 1", "const x = 1", "", "const x = 1"].join("\n")
    const hashed = hashFile(filePath, content)
    const first = hashed.lines[0]
    const second = hashed.lines[1]

    const result = replace(content, "const x = 1", "const y = 2", true, {
      filePath,
      oldRange: `${first.number}#${first.hash}-${second.number}#${second.hash}`,
    })

    expect(result).toBe(["const y = 2", "const y = 2", "", "const x = 1"].join("\n"))
  })

  test("fails when oldRange is stale", () => {
    const filePath = "/repo/test.ts"
    const original = ["const x = 1", "console.log(x)"].join("\n")
    const hashed = hashFile(filePath, original)
    const first = hashed.lines[0]
    const current = ["const x = 99", "console.log(x)"].join("\n")

    expect(() =>
      replace(current, "const x = 1", "const x = 2", false, {
        filePath,
        oldRange: `${first.number}#${first.hash}-${first.number}#${first.hash}`,
      }),
    ).toThrow(/Re-read the file and refresh the range/)
  })

  test("fails fast on invalid oldRange syntax", () => {
    expect(() =>
      replace("const x = 1", "const x = 1", "const x = 2", false, {
        filePath: "/repo/test.ts",
        oldRange: "invalid",
      }),
    ).toThrow(/Invalid oldRange format/)
  })
})