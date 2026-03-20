import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { Installation } from "@/installation"
import { Process } from "@/util/process"
import { SelfSpawner, buildSelfSpawnCommand } from "@/daemon/bootstrap/self-spawn"

afterEach(() => {
  mock.restore()
})

describe("daemon self spawner", () => {
  test("builds self-spawn command with daemon mode metadata", () => {
    const execSpy = spyOn(Installation, "executablePath").mockReturnValue("/tmp/opencode")

    const spec = buildSelfSpawnCommand({
      mode: "master",
      namespaceID: "local",
      args: ["serve"],
    })

    expect(execSpy).toHaveBeenCalled()
    expect(spec.command[0]).toBe("/tmp/opencode")
    expect(spec.command.slice(-1)).toEqual(["serve"])
    expect(spec.env.OPENCODE_DAEMON_MODE).toBe("master")
    expect(spec.env.OPENCODE_DAEMON_NAMESPACE).toBe("local")
    expect(spec.env.OPENCODE_DAEMON_PARENT_PID).toBe(String(process.pid))
  })

  test("spawns process with inherited stdio by default", () => {
    spyOn(Installation, "executablePath").mockReturnValue("/tmp/opencode")

    let captured: { command: string[]; opts: Parameters<typeof Process.spawn>[1] } | undefined
    const spawnSpy = spyOn(Process, "spawn").mockImplementation((command, opts) => {
      captured = { command, opts }
      return {
        pid: 12345,
        exited: Promise.resolve(0),
        unref: () => {},
      } as any
    })

    const result = new SelfSpawner().spawn({
      mode: "worker",
      namespaceID: "local",
      args: ["tui-thread"],
    })

    expect(spawnSpy).toHaveBeenCalled()
    expect(captured?.command[0]).toBe("/tmp/opencode")
    expect(captured?.opts?.stdout).toBe("inherit")
    expect(captured?.opts?.stderr).toBe("inherit")
    expect(result.pid).toBe(12345)
  })

  test("detaches spawned process when requested", () => {
    spyOn(Installation, "executablePath").mockReturnValue("/tmp/opencode")

    let unrefCalled = false
    spyOn(Process, "spawn").mockImplementation(() => {
      return {
        pid: 23456,
        exited: Promise.resolve(0),
        unref: () => {
          unrefCalled = true
        },
      } as any
    })

    new SelfSpawner().spawn({
      mode: "ai-runtime",
      namespaceID: "local",
      detached: true,
    })

    expect(unrefCalled).toBe(true)
  })
})
