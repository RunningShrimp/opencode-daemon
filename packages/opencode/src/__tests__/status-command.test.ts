import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test"

describe("status command", () => {
  const collectMock = mock(async () => ({
    namespaceID: "local",
    capturedAt: 1_717_171_717_000,
    master: {
      active: true,
      endpoint: "http://127.0.0.1:4096",
      pid: 1234,
      epoch: "epoch-1",
      startedAt: 1_717_171_700_000,
      updatedAt: 1_717_171_716_000,
    },
    publicListener: {
      active: true,
      url: "http://0.0.0.0:4096",
      hostname: "0.0.0.0",
      port: 4096,
    },
    metrics: {
      workers: {
        total: 3,
        byState: {
          cold: 0,
          starting: 0,
          hot: 1,
          draining: 1,
          "warm-idle": 1,
          terminated: 0,
        },
        reclaimCandidates: [],
      },
      lanes: {
        total: 2,
        byState: {
          active: 1,
          released: 0,
          cancelled: 0,
          rebuilding: 1,
        },
        resumableTokenCount: 1,
      },
      cells: {
        total: 4,
        byState: {
          active: 1,
          suspended: 2,
          recycled: 1,
        },
        idleCount: 2,
        recyclableCount: 1,
      },
    },
    watchdog: {
      ticks: 11,
      reclaimedWorkers: 2,
      reclaimedByReason: {
        "idle-timeout-exceeded": 1,
        "warm-idle-budget-exceeded": 1,
        "over-max-workers": 0,
      },
      recycledCells: 3,
      orphanScans: 5,
      orphanEntriesScanned: 7,
      orphanActions: {
        adopt: 1,
        reap: 4,
        "reap-and-respawn": 2,
      },
      lastTickAt: 1_717_171_716_500,
    },
  }))

  const logMock = mock((..._args: unknown[]) => {})
  const originalLog = console.log

  beforeEach(() => {
    collectMock.mockClear()
    logMock.mockClear()
    console.log = logMock

    mock.module("@/daemon/master/daemon-info", () => {
      class DaemonInfoService {
        collect = collectMock
      }

      return { DaemonInfoService }
    })
  })

  afterEach(() => {
    console.log = originalLog
    mock.restore()
  })

  test("prints human-readable diagnostics by default", async () => {
    const { StatusCommand } = await import("@/cli/cmd/status")
    await StatusCommand.handler({} as never)

    expect(collectMock).toHaveBeenCalledTimes(1)
    expect(logMock).toHaveBeenCalled()
    const output = logMock.mock.calls.map((call) => String(call?.[0])).join("\n")
    expect(output).toContain("Namespace: local")
    expect(output).toContain("Master: active")
    expect(output).toContain("Workers: 3")
    expect(output).toContain("Watchdog ticks=11")
  })

  test("prints json diagnostics with --json", async () => {
    const { StatusCommand } = await import("@/cli/cmd/status")
    await StatusCommand.handler({ json: true } as never)

    expect(collectMock).toHaveBeenCalledTimes(1)
    expect(logMock).toHaveBeenCalledTimes(1)
    const parsed = JSON.parse(String(logMock.mock.calls[0]?.[0]))
    expect(parsed.namespaceID).toBe("local")
    expect(parsed.master.active).toBe(true)
    expect(parsed.metrics.workers.total).toBe(3)
    expect(parsed.watchdog.ticks).toBe(11)
  })
})
