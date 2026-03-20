import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

describe("serve command", () => {
  const ensureMasterMock = mock(async () => ({
    mode: "attached" as const,
    endpoint: "http://127.0.0.1:4097",
    pid: 9001,
  }))

  const fetchMock = mock(async (..._args: [unknown, unknown?]) => ({
    ok: true,
    text: async () => "{}",
    json: async () => ({ url: "http://127.0.0.1:4200" }),
  }))

  const logMock = mock((..._args: unknown[]) => {})

  const originalArgv = [...process.argv]
  const originalFetch = globalThis.fetch
  const originalLog = console.log

  beforeEach(() => {
    ensureMasterMock.mockClear()
    fetchMock.mockClear()
    logMock.mockClear()

    process.argv = [...originalArgv]
    globalThis.fetch = fetchMock as unknown as typeof fetch
    console.log = logMock

    mock.module("@/daemon/bootstrap/master-bootstrap", () => {
      class MasterBootstrapCoordinator {
        ensureMaster = ensureMasterMock
      }

      return { MasterBootstrapCoordinator }
    })
  })

  afterEach(() => {
    process.argv = [...originalArgv]
    globalThis.fetch = originalFetch
    console.log = originalLog
    mock.restore()
  })

  test("attaches to existing master without reconfiguring listener by default", async () => {
    const { ServeCommand } = await import("@/cli/cmd/serve")

    await ServeCommand.handler({
      hostname: "127.0.0.1",
      port: "4100",
      timeout: "0",
      path: "/tmp/repo",
    } as never)

    expect(ensureMasterMock.mock.calls.length).toBeGreaterThanOrEqual(1)
    const publicListenerCalls = fetchMock.mock.calls.filter((call) =>
      String(call?.[0]).includes("/global/public-listener"),
    )
    expect(publicListenerCalls).toHaveLength(0)
    const output = logMock.mock.calls.map((call) => String(call?.[0])).join("\n")
    expect(output).toContain("attach mode enabled")
  })

  test("reconfigures public listener when explicit network flags are provided", async () => {
    process.argv.push("--hostname", "0.0.0.0", "--port", "4200")

    const { ServeCommand } = await import("@/cli/cmd/serve")

    await ServeCommand.handler({
      hostname: "0.0.0.0",
      port: "4200",
      timeout: "0",
      path: "/tmp/repo",
    } as never)

    expect(ensureMasterMock.mock.calls.length).toBeGreaterThanOrEqual(1)
    const publicListenerCalls = fetchMock.mock.calls.filter((call) =>
      String(call?.[0]).includes("/global/public-listener"),
    )
    expect(publicListenerCalls).toHaveLength(1)
    const request = publicListenerCalls[0]
    expect(String(request?.[0])).toContain("/global/public-listener")
    const init = (request?.[1] ?? {}) as { body?: unknown }
    const body = JSON.parse(String(init.body ?? "{}"))
    expect(body.hostname).toBe("0.0.0.0")
    expect(Number(body.port)).toBe(4200)
  })
})
