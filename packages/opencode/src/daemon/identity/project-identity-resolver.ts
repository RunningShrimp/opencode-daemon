import path from "node:path"
import { Project } from "@/project/project"
import type { ProjectID } from "@/project/schema"
import {
  type ProjectRepositoryIdentity,
  type ProjectRuntimeIdentity,
  resolveProjectRepositoryIdentity,
  resolveProjectRuntimeIdentity,
} from "./project-identity"
import type { RuntimeBoundaryInput } from "./runtime-key"
import { Filesystem } from "@/util/filesystem"

export interface ProjectIdentityResolutionInput {
  namespaceID: string
  directory: string
  runtimeBoundary?: RuntimeBoundaryInput
}

export interface ResolveFromProjectInput {
  namespaceID: string
  directory: string
  project: Pick<Project.Info, "id" | "worktree" | "vcs" | "sandboxes">
  runtimeBoundary?: RuntimeBoundaryInput
}

export interface ProjectIdentityResolutionOutput {
  directory: string
  sandboxRoot: string
  worktreeRoot: string
  repository: ProjectRepositoryIdentity
  runtime: ProjectRuntimeIdentity
}

function uniquePaths(values: string[]) {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const normalized = Filesystem.resolve(value)
    if (seen.has(normalized)) continue
    seen.add(normalized)
    result.push(normalized)
  }
  return result
}

function selectSandboxRoot(input: { directory: string; worktree: string; sandboxes: string[] }) {
  const directory = Filesystem.resolve(input.directory)
  const candidates = uniquePaths([input.worktree, ...input.sandboxes])
    .filter((candidate) => directory === candidate || directory.startsWith(candidate + path.sep))
    .sort((left, right) => right.length - left.length)

  return candidates[0] ?? Filesystem.resolve(input.worktree)
}

async function inferRuntimeBoundary(directory: string): Promise<RuntimeBoundaryInput> {
  const cwd = Filesystem.resolve(directory)
  const packageJsonPath = path.join(cwd, "package.json")
  const cargoPath = path.join(cwd, "Cargo.toml")
  const goPath = path.join(cwd, "go.mod")
  const pyPath = path.join(cwd, "pyproject.toml")

  let language = "generic"
  let runtime = "unknown"

  if (await Filesystem.exists(packageJsonPath)) {
    language = (await Filesystem.exists(path.join(cwd, "tsconfig.json"))) ? "typescript" : "javascript"
    runtime = process.versions.bun ? "bun" : "node"
  } else if (await Filesystem.exists(cargoPath)) {
    language = "rust"
    runtime = "cargo"
  } else if (await Filesystem.exists(goPath)) {
    language = "go"
    runtime = "go"
  } else if (await Filesystem.exists(pyPath)) {
    language = "python"
    runtime = "python"
  }

  const projectEnv: Record<string, string | undefined> = {
    NODE_ENV: process.env.NODE_ENV,
    OPENCODE_MODE: process.env.OPENCODE_MODE,
    OPENCODE_PROFILE: process.env.OPENCODE_PROFILE,
  }

  const toolchainEnv: Record<string, string> = {}
  for (const [key, value] of Object.entries(process.env)) {
    if (!value) continue
    if (key.startsWith("OPENCODE_TOOLCHAIN_")) {
      toolchainEnv[key] = value
    }
  }

  return {
    projectEnv,
    toolchain: {
      language,
      runtime,
      version: process.versions.bun || process.version,
      env: toolchainEnv,
    },
  }
}

export class ProjectIdentityResolver {
  async resolve(input: ProjectIdentityResolutionInput): Promise<ProjectIdentityResolutionOutput> {
    const directory = Filesystem.resolve(input.directory)
    const resolved = await Project.fromDirectory(directory)
    return this.resolveFromProject({
      namespaceID: input.namespaceID,
      directory,
      project: resolved.project,
      runtimeBoundary: input.runtimeBoundary,
    })
  }

  async resolveFromProject(input: ResolveFromProjectInput): Promise<ProjectIdentityResolutionOutput> {
    const directory = Filesystem.resolve(input.directory)
    const worktreeRoot = Filesystem.resolve(input.project.worktree)
    const sandboxRoot = selectSandboxRoot({
      directory,
      worktree: worktreeRoot,
      sandboxes: input.project.sandboxes,
    })

    const repository = resolveProjectRepositoryIdentity({
      projectID: input.project.id as ProjectID,
      repoRoot: sandboxRoot,
      vcs: input.project.vcs,
    })

    const runtime = resolveProjectRuntimeIdentity({
      namespaceID: input.namespaceID,
      repository,
      worktree: worktreeRoot,
      runtimeBoundary: input.runtimeBoundary ?? (await inferRuntimeBoundary(sandboxRoot)),
    })

    return {
      directory,
      sandboxRoot,
      worktreeRoot,
      repository,
      runtime,
    }
  }
}
