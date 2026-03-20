import { ProjectID } from "@/project/schema"
import { Filesystem } from "@/util/filesystem"
import { NamespaceID } from "./ids"
import {
  type ProjectRuntimeKey,
  createProjectRuntimeKey,
  deriveRuntimeFingerprints,
  type RuntimeBoundaryInput,
  type RuntimeFingerprints,
} from "./runtime-key"

export interface ProjectRepositoryIdentity {
  projectID: ProjectID
  canonicalRepoRoot: string
  vcs: "git" | "none"
}

export interface ProjectRuntimeIdentity {
  namespaceID: NamespaceID
  repository: ProjectRepositoryIdentity
  worktree: string
  runtimeKey: ProjectRuntimeKey
  workerEnvScope: string
  envFingerprint: string
}

export interface ResolveProjectRepositoryIdentityInput {
  projectID: ProjectID
  repoRoot: string
  vcs?: string
}

export interface ResolveProjectRuntimeIdentityInput {
  namespaceID: string
  repository: ProjectRepositoryIdentity
  worktree: string
  runtimeBoundary: RuntimeBoundaryInput
}

export function resolveProjectRepositoryIdentity(input: ResolveProjectRepositoryIdentityInput): ProjectRepositoryIdentity {
  const vcs = input.vcs === "git" ? "git" : "none"
  return {
    projectID: input.projectID,
    canonicalRepoRoot: Filesystem.resolve(input.repoRoot),
    vcs,
  }
}

export function resolveProjectRuntimeIdentity(input: ResolveProjectRuntimeIdentityInput): ProjectRuntimeIdentity {
  const namespaceID = NamespaceID.make(input.namespaceID)
  const worktree = Filesystem.resolve(input.worktree)
  const fingerprints: RuntimeFingerprints = deriveRuntimeFingerprints(input.runtimeBoundary)

  const runtimeKey = createProjectRuntimeKey({
    namespaceID,
    projectID: input.repository.projectID,
    worktree,
    workerEnvScope: fingerprints.workerEnvScope,
  }).value

  return {
    namespaceID,
    repository: input.repository,
    worktree,
    runtimeKey,
    workerEnvScope: fingerprints.workerEnvScope,
    envFingerprint: fingerprints.envFingerprint,
  }
}
