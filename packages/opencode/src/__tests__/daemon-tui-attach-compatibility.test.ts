import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

describe("tui attach compatibility", () => {
  const tuiMock = mock(async (_input: unknown) => {})
  const findHealthyMasterMock = mock(async () => ({
    endpoint: "http://127.0.0.1:4096",
  }))
  const provideMock = mock(async (input: { fn: () => Promise<unknown> | unknown }) => input.fn())
  const configGetMock = mock(async () => ({ theme: "default" }))

  beforeEach(() => {
    tuiMock.mockClear()
    findHealthyMasterMock.mockClear()
    provideMock.mockClear()
    configGetMock.mockClear()
    process.exitCode = undefined

    mock.module("@/cli/cmd/tui/app", () => ({
      tui: tuiMock,
    }))

    mock.module("@/cli/cmd/tui/win32", () => ({
      win32DisableProcessedInput: () => {},
      win32InstallCtrlCGuard: () => () => {},
    }))

    mock.module("@/project/instance", () => ({
      Instance: {
        provide: provideMock,
      },
    }))

    mock.module("@/config/tui", () => ({
      TuiConfig: {
        get: configGetMock,
      },
    }))

    mock.module("@/daemon/bootstrap/discovery", () => {
      class MasterDiscoveryService {
        findHealthyMaster = findHealthyMasterMock
      }

      return { MasterDiscoveryService }
    })
  })

  afterEach(() => {
    mock.restore()
    delete process.env.OPENCODE_SERVER_PASSWORD
  })

  test("discovers master endpoint when URL is omitted", async () => {
    const { AttachCommand } = await import("@/cli/cmd/tui/attach")

    await AttachCommand.handler({
      continue: true,
      fork: true,
    } as never)

    expect(findHealthyMasterMock).toHaveBeenCalledTimes(1)
    expect(tuiMock).toHaveBeenCalledTimes(1)
    const firstCall = tuiMock.mock.calls.at(0)
    expect(firstCall?.[0]).toEqual(
      expect.objectContaining({
        url: "http://127.0.0.1:4096",
        args: expect.objectContaining({
          continue: true,
          fork: true,
        }),
      }),
    )
    expect(process.exitCode).toBeUndefined()
  })

  test("uses explicit URL and auth header without discovery", async () => {
    const { AttachCommand } = await import("@/cli/cmd/tui/attach")

    await AttachCommand.handler({
      url: "http://127.0.0.1:7777",
      password: "dev-secret",
    } as never)

    expect(findHealthyMasterMock).toHaveBeenCalledTimes(0)
    expect(tuiMock).toHaveBeenCalledTimes(1)

    const firstCall = tuiMock.mock.calls.at(0)
    const call = (firstCall?.[0] ?? {}) as { url?: string; headers?: Record<string, string> }
    expect(call.url).toBe("http://127.0.0.1:7777")
    expect(call.headers?.Authorization).toMatch(/^Basic\s+/)
  })
})
