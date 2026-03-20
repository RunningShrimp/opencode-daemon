import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { Installation } from "@/installation"
import { buildSelfSpawnCommand } from "@/daemon/bootstrap/self-spawn"

afterEach(() => {
  mock.restore()
})

describe("single-file bootstrap", () => {
  test("uses the same packaged executable for master/worker/ai-runtime modes", () => {
    const executable = "/opt/opencode/bin/opencoded"
    const executableSpy = spyOn(Installation, "executablePath").mockReturnValue(executable)

    const modes = ["master", "worker", "ai-runtime"] as const
    for (const mode of modes) {
      const spec = buildSelfSpawnCommand({
        mode,
        namespaceID: "local",
      })

      expect(spec.command[0]).toBe(executable)
      expect(spec.env.OPENCODE_DAEMON_MODE).toBe(mode)
      expect(spec.env.OPENCODE_DAEMON_NAMESPACE).toBe("local")
      expect(spec.command.some((segment) => /opencode-(master|worker|ai-runtime)/.test(segment))).toBe(false)
    }

    expect(executableSpy).toHaveBeenCalledTimes(3)
  })
})
