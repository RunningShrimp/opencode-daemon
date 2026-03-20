import type { Project } from "@/project/project"
import { WorkspaceID } from "@/control-plane/schema"
import { ProjectID } from "@/project/schema"
import { ModelID, ProviderID } from "@/provider/schema"
import { MessageID, PartID, SessionID } from "@/session/schema"

export const projectID = (id: string) => ProjectID.make(id)
export const workspaceID = (id: string) => WorkspaceID.make(id)
export const sessionID = (id: string) => SessionID.make(id)
export const messageID = (id: string) => MessageID.make(id)
export const partID = (id: string) => PartID.make(id)
export const providerID = (id: string) => ProviderID.make(id)
export const modelID = (id: string) => ModelID.make(id)

type ProjectInfoOptions = Omit<Project.Info, "id" | "worktree" | "time" | "sandboxes"> & {
  time?: Partial<Project.Info["time"]>
  sandboxes?: Project.Info["sandboxes"]
}

export function projectInfo(id: string, worktree: string, options: ProjectInfoOptions = {}): Project.Info {
  const now = Date.now()
  return {
    id: projectID(id),
    worktree,
    vcs: options.vcs ?? "git",
    name: options.name,
    icon: options.icon,
    commands: options.commands,
    time: {
      created: now,
      updated: now,
      ...options.time,
    },
    sandboxes: options.sandboxes ?? [],
  }
}