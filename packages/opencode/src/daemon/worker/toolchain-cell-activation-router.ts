import type { ToolchainCellDescriptor } from "@/daemon/worker/toolchain-cell-descriptor"
import type { ToolchainCellRegistry } from "@/daemon/worker/toolchain-cell-registry"
import type { ToolchainRuntimeProfileInput } from "@/daemon/worker/toolchain-profile"

export type ToolchainActivationKind = "lsp" | "formatter" | "env"

export interface ToolchainActivationInput {
  workerID: string
  runtimeKey: string
  laneID: string
  directory: string
  profile: ToolchainRuntimeProfileInput
  kind: ToolchainActivationKind
}

export interface ToolchainActivationResult {
  kind: ToolchainActivationKind
  cell: ToolchainCellDescriptor
  scope: {
    runtimeKey: string
    language: string
    runtime: string
    envFingerprint: string
    directory: string
  }
}

export class ToolchainCellActivationRouter {
  constructor(private readonly registry: Pick<ToolchainCellRegistry, "ensure">) {}

  async activate(input: ToolchainActivationInput): Promise<ToolchainActivationResult> {
    const directory = input.directory.trim()
    if (!directory) throw new Error("directory is required")

    const cell = await this.registry.ensure({
      workerID: input.workerID,
      runtimeKey: input.runtimeKey,
      laneID: input.laneID,
      profile: input.profile,
    })

    return {
      kind: input.kind,
      cell,
      scope: {
        runtimeKey: cell.runtimeKey,
        language: cell.profile.language,
        runtime: cell.profile.runtime,
        envFingerprint: cell.profile.envFingerprint,
        directory,
      },
    }
  }

  activateLSP(input: Omit<ToolchainActivationInput, "kind">) {
    return this.activate({ ...input, kind: "lsp" })
  }

  activateFormatter(input: Omit<ToolchainActivationInput, "kind">) {
    return this.activate({ ...input, kind: "formatter" })
  }

  activateEnv(input: Omit<ToolchainActivationInput, "kind">) {
    return this.activate({ ...input, kind: "env" })
  }
}
