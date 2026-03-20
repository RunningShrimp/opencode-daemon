import { SelfSpawner } from "@/daemon/bootstrap/self-spawn"
import { type RuntimeBoundaryInput } from "@/daemon/identity/runtime-key"
import { ProjectIdentityResolver } from "@/daemon/identity/project-identity-resolver"
import { WorkerID } from "@/daemon/identity/ids"
import { FencingEpochGenerator } from "@/daemon/protocol/fencing-epoch"
import { ProjectWorkerLeaseRegistry } from "@/daemon/worker/project-worker-lease-registry"
import type { ProjectWorkerDescriptor } from "@/daemon/worker/worker-descriptor"

export interface EnsureWorkerInput {
  namespaceID: string
  directory: string
  runtimeBoundary?: RuntimeBoundaryInput
  spawnArgs?: string[]
  spawnCwd?: string
  detached?: boolean
  forceRestart?: boolean
}

export interface AttachedWorkerResult {
  mode: "attached"
  descriptor: ProjectWorkerDescriptor
}

export interface SpawnedWorkerResult {
  mode: "spawned"
  descriptor: ProjectWorkerDescriptor
  command: string[]
}

export type EnsureWorkerResult = AttachedWorkerResult | SpawnedWorkerResult

export interface WorkerSupervisorOptions {
  identityResolver?: Pick<ProjectIdentityResolver, "resolve">
  leaseRegistry?: Pick<ProjectWorkerLeaseRegistry, "get" | "put" | "delete">
  spawner?: Pick<SelfSpawner, "spawn">
  epochGenerator?: FencingEpochGenerator
  now?: () => number
  isProcessAlive?: (pid: number) => boolean
}

function defaultProcessAlive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function shouldAttachExistingWorker(
  descriptor: ProjectWorkerDescriptor,
  isProcessAlive: (pid: number) => boolean,
  forceRestart: boolean,
) {
  if (forceRestart) return false
  if (descriptor.state === "terminated") return false
  if (!descriptor.pid || descriptor.pid <= 0) return false
  return isProcessAlive(descriptor.pid)
}

export class WorkerSupervisor {
  private readonly identityResolver: Pick<ProjectIdentityResolver, "resolve">
  private readonly leaseRegistry: Pick<ProjectWorkerLeaseRegistry, "get" | "put" | "delete">
  private readonly spawner: Pick<SelfSpawner, "spawn">
  private readonly epochGenerator: FencingEpochGenerator
  private readonly now: () => number
  private readonly isProcessAlive: (pid: number) => boolean

  constructor(options: WorkerSupervisorOptions = {}) {
    this.identityResolver = options.identityResolver ?? new ProjectIdentityResolver()
    this.leaseRegistry = options.leaseRegistry ?? new ProjectWorkerLeaseRegistry()
    this.spawner = options.spawner ?? new SelfSpawner()
    this.epochGenerator = options.epochGenerator ?? new FencingEpochGenerator()
    this.now = options.now ?? (() => Date.now())
    this.isProcessAlive = options.isProcessAlive ?? defaultProcessAlive
  }

  async ensureWorker(input: EnsureWorkerInput): Promise<EnsureWorkerResult> {
    const resolved = await this.identityResolver.resolve({
      namespaceID: input.namespaceID,
      directory: input.directory,
      runtimeBoundary: input.runtimeBoundary,
    })

    const existing = await this.leaseRegistry.get(resolved.runtime.runtimeKey)
    if (existing && shouldAttachExistingWorker(existing, this.isProcessAlive, input.forceRestart === true)) {
      const attached: ProjectWorkerDescriptor = {
        ...existing,
        lastActiveAt: this.now(),
      }
      await this.leaseRegistry.put(attached)
      return {
        mode: "attached",
        descriptor: attached,
      }
    }

    if (existing) {
      await this.leaseRegistry.delete(existing.runtime.runtimeKey)
    }

    const spawnResult = this.spawner.spawn({
      mode: "worker",
      namespaceID: input.namespaceID,
      args: input.spawnArgs,
      cwd: input.spawnCwd ?? resolved.sandboxRoot,
      detached: input.detached ?? true,
      env: {
        OPENCODE_WORKER_RUNTIME_KEY: resolved.runtime.runtimeKey,
        OPENCODE_WORKER_REPO_ROOT: resolved.repository.canonicalRepoRoot,
        OPENCODE_WORKER_WORKTREE_ROOT: resolved.worktreeRoot,
        OPENCODE_WORKER_ENV_FINGERPRINT: resolved.runtime.envFingerprint,
      },
    })

    const now = this.now()
    const descriptor: ProjectWorkerDescriptor = {
      workerID: WorkerID.random(),
      runtime: resolved.runtime,
      state: "starting",
      pid: spawnResult.pid > 0 ? spawnResult.pid : undefined,
      startupEpoch: this.epochGenerator.next(now),
      startedAt: now,
      lastActiveAt: now,
      laneCount: 0,
      toolchainCellCount: 0,
    }

    await this.leaseRegistry.put(descriptor)

    return {
      mode: "spawned",
      descriptor,
      command: spawnResult.command,
    }
  }
}
