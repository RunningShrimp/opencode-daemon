import type { Argv } from "yargs"
import { cmd } from "./cmd"
import { DaemonInfoService } from "@/daemon/master/daemon-info"

function printHumanReadable(snapshot: Awaited<ReturnType<DaemonInfoService["collect"]>>) {
  const lines = [
    `Namespace: ${snapshot.namespaceID}`,
    `Captured At: ${new Date(snapshot.capturedAt).toISOString()}`,
    `Master: ${snapshot.master.active ? "active" : "inactive"}`,
  ]

  if (snapshot.master.active) {
    lines.push(`Master PID: ${snapshot.master.pid ?? "n/a"}`)
    lines.push(`Master Endpoint: ${snapshot.master.endpoint ?? "n/a"}`)
    lines.push(`Master Epoch: ${snapshot.master.epoch ?? "n/a"}`)
  }

  if (snapshot.publicListener) {
    lines.push(`Public Listener: ${snapshot.publicListener.active ? "active" : "inactive"}`)
    if (snapshot.publicListener.active) {
      lines.push(`Public Listener URL: ${snapshot.publicListener.url ?? "n/a"}`)
    }
  }

  lines.push(`Workers: ${snapshot.metrics.workers.total}`)
  lines.push(
    `  byState cold=${snapshot.metrics.workers.byState.cold} starting=${snapshot.metrics.workers.byState.starting} hot=${snapshot.metrics.workers.byState.hot} warm-idle=${snapshot.metrics.workers.byState["warm-idle"]} draining=${snapshot.metrics.workers.byState.draining} terminated=${snapshot.metrics.workers.byState.terminated}`,
  )
  lines.push(`  reclaimCandidates=${snapshot.metrics.workers.reclaimCandidates.length}`)

  lines.push(`Lanes: ${snapshot.metrics.lanes.total}`)
  lines.push(
    `  byState active=${snapshot.metrics.lanes.byState.active} released=${snapshot.metrics.lanes.byState.released} cancelled=${snapshot.metrics.lanes.byState.cancelled} rebuilding=${snapshot.metrics.lanes.byState.rebuilding}`,
  )
  lines.push(`  resumableTokens=${snapshot.metrics.lanes.resumableTokenCount}`)

  lines.push(`Cells: ${snapshot.metrics.cells.total}`)
  lines.push(
    `  byState active=${snapshot.metrics.cells.byState.active} suspended=${snapshot.metrics.cells.byState.suspended} recycled=${snapshot.metrics.cells.byState.recycled}`,
  )
  lines.push(`  idle=${snapshot.metrics.cells.idleCount} recyclable=${snapshot.metrics.cells.recyclableCount}`)

  if (snapshot.watchdog) {
    lines.push(`Watchdog ticks=${snapshot.watchdog.ticks} reclaimedWorkers=${snapshot.watchdog.reclaimedWorkers}`)
    lines.push(
      `  reclaimedByReason idle-timeout=${snapshot.watchdog.reclaimedByReason["idle-timeout-exceeded"]} warm-idle-budget=${snapshot.watchdog.reclaimedByReason["warm-idle-budget-exceeded"]} over-max=${snapshot.watchdog.reclaimedByReason["over-max-workers"]}`,
    )
    lines.push(
      `  orphan scans=${snapshot.watchdog.orphanScans} entries=${snapshot.watchdog.orphanEntriesScanned} actions adopt=${snapshot.watchdog.orphanActions.adopt} reap=${snapshot.watchdog.orphanActions.reap} reap-and-respawn=${snapshot.watchdog.orphanActions["reap-and-respawn"]}`,
    )
  }

  console.log(lines.join("\n"))
}

export const StatusCommand = cmd({
  command: "status",
  describe: "show daemon status and diagnostics",
  builder: (yargs: Argv) =>
    yargs
      .option("namespace", {
        describe: "daemon namespace id",
        type: "string",
        default: "local",
      })
      .option("json", {
        describe: "emit full JSON payload",
        type: "boolean",
        default: false,
      }),
  handler: async (args) => {
    const service = new DaemonInfoService()
    const snapshot = await service.collect(args.namespace as string)
    if (args.json) {
      console.log(JSON.stringify(snapshot, null, 2))
      return
    }

    printHumanReadable(snapshot)
  },
})
