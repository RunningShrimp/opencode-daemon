import { RGBA } from "@opentui/core"

export namespace Terminal {
  export type Colors = Awaited<ReturnType<typeof colors>>
  /**
   * Query terminal colors including background, foreground, and palette (0-15).
   * Uses OSC escape sequences to retrieve actual terminal color values.
   *
   * Note: OSC 4 (palette) queries may not work through tmux as responses are filtered.
   * OSC 10/11 (foreground/background) typically work in most environments.
   *
   * Returns an object with background, foreground, and colors array.
   * Any query that fails will be null/empty.
   */
  export async function colors(): Promise<{
    background: RGBA | null
    foreground: RGBA | null
    colors: RGBA[]
  }> {
    if (!process.stdin.isTTY) return { background: null, foreground: null, colors: [] }

    return new Promise((resolve) => {
      let background: RGBA | null = null
      let foreground: RGBA | null = null
      const paletteColors: RGBA[] = []
      let timeout: NodeJS.Timeout

      const cleanup = () => {
        process.stdin.setRawMode(false)
        process.stdin.removeListener("data", handler)
        clearTimeout(timeout)
      }

      const handler = (data: Buffer) => {
        const str = data.toString()
        const match = str.match(/\x1b](\d+);([^\x07\x1b]+)/g)
        if (match) {
          cleanup()
          for (const m of match) {
            const match2 = m.match(/\x1b](\d+);([^\x07\x1b]+)/)
            if (!match2) continue
            const [, code, colors] = match2
            if (code === "11") {
              // background color
              const [r, g, b] = colors.split(";").map((c) => parseInt(c, 10))
              background = RGBA.fromInts(r, g, b, 255)
            } else if (code === "10") {
              // foreground color
              const [r, g, b] = colors.split(";").map((c) => parseInt(c, 10))
              foreground = RGBA.fromInts(r, g, b, 255)
            } else if (code === "4") {
              // palette colors
              const [index, r, g, b] = colors.split(";").map((c) => parseInt(c, 10))
              if (!isNaN(index) && !isNaN(r) && !isNaN(g) && !isNaN(b)) {
                paletteColors[index] = RGBA.fromInts(r, g, b, 255)
              }
            }
          }
        }

        // Resolve with whatever we have (may be incomplete)
        resolve({ background, foreground, colors: paletteColors })
      }

      // First, set raw mode so we can read the response
      process.stdin.setRawMode(true)
      process.stdin.on("data", handler)

      // Query foreground color ( OSC 10 )
      process.stdout.write("\x1b]10;?\x07")
      // Query background color ( OSC 11 )
      process.stdout.write("\x1b]11;?\x07")
      // Query palette colors ( OSC 4 )
      for (let i = 0; i < 16; i++) {
        process.stdout.write(`\x1b]4;${i};?\x07`)
      }

      // Wait for responses for a bit, then give up
      timeout = setTimeout(() => {
        cleanup()
        resolve({ background, foreground, colors: paletteColors })
      }, 1000)
    })
  }
}
