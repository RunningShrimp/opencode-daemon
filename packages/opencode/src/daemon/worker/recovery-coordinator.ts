import type { ProjectRuntimeKey } from "@/daemon/identity/runtime-key"
import type { ClientLaneDescriptor } from "@/daemon/worker/client-lane-descriptor"
import type { LaneController } from "@/daemon/worker/lane-controller"

export interface RecoverLanesInput {
  runtimeKey?: ProjectRuntimeKey
  sessionID?: string
}

export interface RecoverLanesResult {
  recovered: ClientLaneDescriptor[]
  skippedTokens: string[]
}

export interface RecoveryCoordinatorOptions {
  laneController: Pick<LaneController, "list" | "resume">
}

export class RecoveryCoordinator {
  constructor(private readonly options: RecoveryCoordinatorOptions) {}

  async recover(input: RecoverLanesInput = {}): Promise<RecoverLanesResult> {
    const lanes = await this.options.laneController.list()
    const scoped = lanes.filter((lane) => {
      if (input.runtimeKey && lane.runtimeKey !== input.runtimeKey) return false
      if (input.sessionID && lane.sessionID !== input.sessionID) return false
      return true
    })

    const activeTokens = new Set(
      scoped
        .filter((lane) => lane.state === "active" && lane.resumeToken)
        .map((lane) => lane.resumeToken as string),
    )

    const candidatesByToken = new Map<string, ClientLaneDescriptor>()
    for (const lane of scoped) {
      if (!lane.resumeToken) continue
      if (lane.state !== "cancelled" && lane.state !== "rebuilding") continue
      if (activeTokens.has(lane.resumeToken)) continue

      const existing = candidatesByToken.get(lane.resumeToken)
      if (!existing || (lane.lastHeartbeatAt ?? 0) > (existing.lastHeartbeatAt ?? 0)) {
        candidatesByToken.set(lane.resumeToken, lane)
      }
    }

    const recovered: ClientLaneDescriptor[] = []
    const skippedTokens: string[] = []

    for (const [resumeToken, lane] of candidatesByToken.entries()) {
      const resumed = await this.options.laneController.resume({
        resumeToken,
        directory: lane.directory,
      })
      if (!resumed) {
        skippedTokens.push(resumeToken)
        continue
      }
      recovered.push(resumed)
    }

    return {
      recovered,
      skippedTokens,
    }
  }
}
