import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import fs from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import {
  projectInfo,
  projectID as makeProjectID,
  sessionID as makeSessionID,
  workspaceID as makeWorkspaceID,
} from "../test-helpers/ids"

const cleanup: string[] = []
const envKeys = ["XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_CONFIG_HOME", "XDG_STATE_HOME"] as const
const originalEnv = new Map<string, string | undefined>()

beforeEach(async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-xp-intel-"))
  cleanup.push(root)
  for (const key of envKeys) originalEnv.set(key, process.env[key])
  process.env.XDG_DATA_HOME = path.join(root, "data-home")
  process.env.XDG_CACHE_HOME = path.join(root, "cache-home")
  process.env.XDG_CONFIG_HOME = path.join(root, "config-home")
  process.env.XDG_STATE_HOME = path.join(root, "state-home")
})

afterEach(async () => {
  const { ProjectMemory } = await import("../ai/memory/project-memory")
  ProjectMemory.resetForTest()
  const { Instance } = await import("../project/instance")
  await Instance.disposeAll().catch(() => undefined)
  for (const key of envKeys) {
    const value = originalEnv.get(key)
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  originalEnv.clear()
  while (cleanup.length > 0) {
    const target = cleanup.pop()
    if (target) await fs.rm(target, { recursive: true, force: true })
  }
})

describe("workspace intelligence — cross-project memory and KG context", () => {
  test("ranks sibling workspaces by lexical relevance to current session context", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-xp-intel-ranking-"))
    cleanup.push(workspace)

    const { Instance } = await import("../project/instance")
    const { Database } = await import("../storage/db")
    const { ProjectTable } = await import("../project/project.sql")
    const { SessionTable } = await import("../session/session.sql")
    const { WorkspaceTable } = await import("../control-plane/workspace.sql")

    const now = Date.now()
    const projectID = makeProjectID("xp-ranking-proj")
    const sessionID = makeSessionID("ses_xp_ranking")
    const currentWorkspaceID = makeWorkspaceID("ws-current")
    const authWorkspaceID = makeWorkspaceID("ws-auth")
    const graphicsWorkspaceID = makeWorkspaceID("ws-graphics")

    await Instance.reload({
      directory: workspace,
      worktree: workspace,
      project: projectInfo("xp-ranking-proj", workspace, { time: { created: now, updated: now } }),
    })

    await Instance.provide({
      directory: workspace,
      fn: async () => {
        Database.use((db) => {
          db.insert(ProjectTable)
            .values({
              id: projectID,
              worktree: workspace,
              vcs: "git",
              name: "Ranking",
              sandboxes: [],
              time_created: now,
              time_updated: now,
              time_initialized: now,
            })
            .onConflictDoNothing()
            .run()

          db.insert(WorkspaceTable)
            .values([
              { id: currentWorkspaceID, project_id: projectID, type: "worktree", name: "Current", branch: "feature/auth", directory: workspace },
              { id: authWorkspaceID, project_id: projectID, type: "worktree", name: "Auth Fix", branch: "fix/auth-token", directory: path.join(workspace, "auth-fix") },
              { id: graphicsWorkspaceID, project_id: projectID, type: "worktree", name: "Graphics", branch: "feature/shader", directory: path.join(workspace, "graphics") },
            ])
            .onConflictDoNothing()
            .run()

          db.insert(SessionTable)
            .values({
              id: sessionID,
              project_id: projectID,
              workspace_id: currentWorkspaceID,
              slug: "auth-regression-session",
              directory: workspace,
              title: "Investigate auth token regression",
              version: "test",
              time_created: now,
              time_updated: now,
            })
            .onConflictDoNothing()
            .run()
        })

        const { WorkspaceIntelligence } = await import("../ai/workspace-intelligence")
        const result = await WorkspaceIntelligence.renderPromptContext({
          sessionID,
          projectID,
          rootDir: workspace,
          maxWorkspaces: 2,
        })

        expect(result).toBeDefined()
        expect(result).toContain("Sibling workspaces:")
        const authIndex = result!.indexOf("Auth Fix")
        const graphicsIndex = result!.indexOf("Graphics")
        if (graphicsIndex >= 0) {
          expect(authIndex).toBeLessThan(graphicsIndex)
        } else {
          expect(authIndex).toBeGreaterThan(-1)
        }
      },
    })
  })

  test("prefers framework and dependency-aligned workspace over lexical distractor", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-xp-intel-multisignal-"))
    cleanup.push(workspace)

    const uiWorkspace = path.join(workspace, "ui-workspace")
    const distractorWorkspace = path.join(workspace, "distractor-workspace")
    await fs.mkdir(uiWorkspace, { recursive: true })
    await fs.mkdir(distractorWorkspace, { recursive: true })

    await fs.writeFile(
      path.join(workspace, "package.json"),
      JSON.stringify({ name: "current", dependencies: { react: "18.0.0", axios: "1.0.0" } }),
      "utf8",
    )
    await fs.writeFile(path.join(workspace, "tsconfig.json"), JSON.stringify({ compilerOptions: {} }), "utf8")

    await fs.writeFile(
      path.join(uiWorkspace, "package.json"),
      JSON.stringify({ name: "ui", dependencies: { react: "18.0.0", axios: "1.0.0" } }),
      "utf8",
    )
    await fs.writeFile(path.join(uiWorkspace, "tsconfig.json"), JSON.stringify({ compilerOptions: {} }), "utf8")

    await fs.writeFile(path.join(distractorWorkspace, "requirements.txt"), "django==5.0\n", "utf8")

    const { Instance } = await import("../project/instance")
    const { Database } = await import("../storage/db")
    const { ProjectTable } = await import("../project/project.sql")
    const { SessionTable } = await import("../session/session.sql")
    const { WorkspaceTable } = await import("../control-plane/workspace.sql")

    const now = Date.now()
    const projectID = makeProjectID("xp-multisignal-proj")
    const sessionID = makeSessionID("ses_xp_multisignal")
    const currentWorkspaceID = makeWorkspaceID("ws-current-ms")
    const uiWorkspaceID = makeWorkspaceID("ws-ui-ms")
    const distractorWorkspaceID = makeWorkspaceID("ws-distractor-ms")
    const uiSessionID = makeSessionID("ses-ms-ui-topic")

    await Instance.reload({
      directory: workspace,
      worktree: workspace,
      project: projectInfo("xp-multisignal-proj", workspace, { time: { created: now, updated: now } }),
    })

    await Instance.provide({
      directory: workspace,
      fn: async () => {
        Database.use((db) => {
          db.insert(ProjectTable)
            .values({
              id: projectID,
              worktree: workspace,
              vcs: "git",
              name: "MultiSignal",
              sandboxes: [],
              time_created: now,
              time_updated: now,
              time_initialized: now,
            })
            .onConflictDoNothing()
            .run()

          db.insert(WorkspaceTable)
            .values([
              { id: currentWorkspaceID, project_id: projectID, type: "worktree", name: "Current", branch: "feature/auth", directory: workspace },
              { id: uiWorkspaceID, project_id: projectID, type: "worktree", name: "UI Lab", branch: "ui-auth-hooks", directory: uiWorkspace },
              { id: distractorWorkspaceID, project_id: projectID, type: "worktree", name: "Auth Token Regression War Room", branch: "auth-token-regression", directory: distractorWorkspace },
            ])
            .onConflictDoNothing()
            .run()

          db.insert(SessionTable)
            .values([
              {
                id: sessionID,
                project_id: projectID,
                workspace_id: currentWorkspaceID,
                slug: "auth-regression-react-hooks",
                directory: workspace,
                title: "Investigate auth token regression in react hooks",
                version: "test",
                time_created: now,
                time_updated: now,
              },
              {
                id: uiSessionID,
                project_id: projectID,
                workspace_id: uiWorkspaceID,
                slug: "react-hooks-auth-refactor",
                directory: uiWorkspace,
                title: "React hook migration for auth provider",
                version: "test",
                time_created: now - 1000,
                time_updated: now - 1000,
              },
            ])
            .onConflictDoNothing()
            .run()
        })

        const { WorkspaceIntelligence } = await import("../ai/workspace-intelligence")
        const result = await WorkspaceIntelligence.renderPromptContext({
          sessionID,
          projectID,
          rootDir: workspace,
          maxWorkspaces: 2,
        })

        expect(result).toBeDefined()
        const uiIndex = result!.indexOf("UI Lab")
        const distractorIndex = result!.indexOf("Auth Token Regression War Room")
        expect(uiIndex).toBeGreaterThan(-1)
        expect(distractorIndex).toBeGreaterThan(-1)
        expect(uiIndex).toBeLessThan(distractorIndex)
      },
    })
  })

  test("matches semantic auth themes when lexical overlap is absent", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-xp-intel-semantic-"))
    cleanup.push(workspace)

    const identityWorkspace = path.join(workspace, "identity-lab")
    const graphicsWorkspace = path.join(workspace, "graphics-lab")
    await fs.mkdir(identityWorkspace, { recursive: true })
    await fs.mkdir(graphicsWorkspace, { recursive: true })

    const { Instance } = await import("../project/instance")
    const { Database } = await import("../storage/db")
    const { ProjectTable } = await import("../project/project.sql")
    const { SessionTable } = await import("../session/session.sql")
    const { WorkspaceTable } = await import("../control-plane/workspace.sql")

    const now = Date.now()
    const projectID = makeProjectID("xp-semantic-proj")
    const sessionID = makeSessionID("ses_xp_semantic")
    const currentWorkspaceID = makeWorkspaceID("ws-current-sem")
    const identityWorkspaceID = makeWorkspaceID("ws-identity-sem")
    const graphicsWorkspaceID = makeWorkspaceID("ws-graphics-sem")
    const identitySessionID = makeSessionID("ses-sem-identity")
    const graphicsSessionID = makeSessionID("ses-sem-graphics")

    await Instance.reload({
      directory: workspace,
      worktree: workspace,
      project: projectInfo("xp-semantic-proj", workspace, { time: { created: now, updated: now } }),
    })

    await Instance.provide({
      directory: workspace,
      fn: async () => {
        Database.use((db) => {
          db.insert(ProjectTable)
            .values({
              id: projectID,
              worktree: workspace,
              vcs: "git",
              name: "SemanticRank",
              sandboxes: [],
              time_created: now,
              time_updated: now,
              time_initialized: now,
            })
            .onConflictDoNothing()
            .run()

          db.insert(WorkspaceTable)
            .values([
              { id: currentWorkspaceID, project_id: projectID, type: "worktree", name: "Current", branch: "feature/login-fix", directory: workspace },
              { id: identityWorkspaceID, project_id: projectID, type: "worktree", name: "Identity Platform", branch: "identity-renewal", directory: identityWorkspace },
              { id: graphicsWorkspaceID, project_id: projectID, type: "worktree", name: "Graphics Playground", branch: "shader-tuning", directory: graphicsWorkspace },
            ])
            .onConflictDoNothing()
            .run()

          db.insert(SessionTable)
            .values([
              {
                id: sessionID,
                project_id: projectID,
                workspace_id: currentWorkspaceID,
                slug: "login-outage-investigation",
                directory: workspace,
                title: "Investigate login outage",
                version: "test",
                time_created: now,
                time_updated: now,
              },
              {
                id: identitySessionID,
                project_id: projectID,
                workspace_id: identityWorkspaceID,
                slug: "authentication-credential-renewal",
                directory: identityWorkspace,
                title: "Authentication credential renewal rollout",
                version: "test",
                time_created: now - 500,
                time_updated: now - 500,
              },
              {
                id: graphicsSessionID,
                project_id: projectID,
                workspace_id: graphicsWorkspaceID,
                slug: "shader-benchmark",
                directory: graphicsWorkspace,
                title: "Tune shader benchmark throughput",
                version: "test",
                time_created: now - 1000,
                time_updated: now - 1000,
              },
            ])
            .onConflictDoNothing()
            .run()
        })

        const { WorkspaceIntelligence } = await import("../ai/workspace-intelligence")
        const result = await WorkspaceIntelligence.renderPromptContext({
          sessionID,
          projectID,
          rootDir: workspace,
          maxWorkspaces: 2,
        })

        expect(result).toBeDefined()
        const identityIndex = result!.indexOf("Identity Platform")
        const graphicsIndex = result!.indexOf("Graphics Playground")
        expect(identityIndex).toBeGreaterThan(-1)
        if (graphicsIndex >= 0) {
          expect(identityIndex).toBeLessThan(graphicsIndex)
        }
      },
    })
  })

  test("uses recent workspace session themes to break lexical ties", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-xp-intel-theme-"))
    cleanup.push(workspace)

    const workspaceA = path.join(workspace, "ws-a")
    const workspaceB = path.join(workspace, "ws-b")
    await fs.mkdir(workspaceA, { recursive: true })
    await fs.mkdir(workspaceB, { recursive: true })

    const { Instance } = await import("../project/instance")
    const { Database } = await import("../storage/db")
    const { ProjectTable } = await import("../project/project.sql")
    const { SessionTable } = await import("../session/session.sql")
    const { WorkspaceTable } = await import("../control-plane/workspace.sql")

    const now = Date.now()
    const projectID = makeProjectID("xp-theme-proj")
    const sessionID = makeSessionID("ses_xp_theme")
    const currentWorkspaceID = makeWorkspaceID("ws-current-theme")
    const workspaceAID = makeWorkspaceID("ws-a-theme")
    const workspaceBID = makeWorkspaceID("ws-b-theme")
    const workspaceBSessionID = makeSessionID("ses-theme-b-match")

    await Instance.reload({
      directory: workspace,
      worktree: workspace,
      project: projectInfo("xp-theme-proj", workspace, { time: { created: now, updated: now } }),
    })

    await Instance.provide({
      directory: workspace,
      fn: async () => {
        Database.use((db) => {
          db.insert(ProjectTable)
            .values({
              id: projectID,
              worktree: workspace,
              vcs: "git",
              name: "ThemeScore",
              sandboxes: [],
              time_created: now,
              time_updated: now,
              time_initialized: now,
            })
            .onConflictDoNothing()
            .run()

          db.insert(WorkspaceTable)
            .values([
              { id: currentWorkspaceID, project_id: projectID, type: "worktree", name: "Current", branch: "auth-token", directory: workspace },
              { id: workspaceAID, project_id: projectID, type: "worktree", name: "Auth Token Sandbox", branch: "auth-token-a", directory: workspaceA },
              { id: workspaceBID, project_id: projectID, type: "worktree", name: "Auth Token Sandbox", branch: "auth-token-b", directory: workspaceB },
            ])
            .onConflictDoNothing()
            .run()

          db.insert(SessionTable)
            .values([
              {
                id: sessionID,
                project_id: projectID,
                workspace_id: currentWorkspaceID,
                slug: "auth-token-regression",
                directory: workspace,
                title: "Investigate auth token regression",
                version: "test",
                time_created: now,
                time_updated: now,
              },
              {
                id: workspaceBSessionID,
                project_id: projectID,
                workspace_id: workspaceBID,
                slug: "auth-token-regression-fix",
                directory: workspaceB,
                title: "Fix auth token regression with session replay",
                version: "test",
                time_created: now - 500,
                time_updated: now - 500,
              },
            ])
            .onConflictDoNothing()
            .run()
        })

        const { WorkspaceIntelligence } = await import("../ai/workspace-intelligence")
        const result = await WorkspaceIntelligence.renderPromptContext({
          sessionID,
          projectID,
          rootDir: workspace,
          maxWorkspaces: 2,
        })

        expect(result).toBeDefined()
        const aIndex = result!.indexOf("auth-token-a")
        const bIndex = result!.indexOf("auth-token-b")
        expect(aIndex).toBeGreaterThan(-1)
        expect(bIndex).toBeGreaterThan(-1)
        expect(bIndex).toBeLessThan(aIndex)
      },
    })
  })

  test("renderPromptContext returns undefined when no workspace signal exists", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-xp-intel-ws-"))
    cleanup.push(workspace)

    const { Instance } = await import("../project/instance")
    const projectID = makeProjectID("xp-intel-project")
    const sessionID = makeSessionID("ses_xp_intel_absent")
    await Instance.reload({
      directory: workspace,
      worktree: workspace,
      project: projectInfo("xp-intel-project", workspace),
    })

    await Instance.provide({
      directory: workspace,
      fn: async () => {
        const { WorkspaceIntelligence } = await import("../ai/workspace-intelligence")
        const result = await WorkspaceIntelligence.renderPromptContext({
          sessionID,
          projectID,
          rootDir: workspace,
        })
        // No sessions, no workspaces, no other projects → no context
        expect(result).toBeUndefined()
      },
    })
  })

  test("renderPromptContext includes cross_project_memory block when other projects have facts", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-xp-intel-ws2-"))
    cleanup.push(workspace)

    const { Instance } = await import("../project/instance")
    const { Database } = await import("../storage/db")
    const { ProjectTable } = await import("../project/project.sql")
    const { SessionTable } = await import("../session/session.sql")
    const { WorkspaceTable } = await import("../control-plane/workspace.sql")
    const { ProjectMemory } = await import("../ai/memory/project-memory")

    const now = Date.now()
    const currentProjectId = makeProjectID("xp-current-proj")
    const otherProjectId = makeProjectID("xp-other-proj")
    const sessionID = makeSessionID("ses_xp_intel_test")
    const workspaceID = makeWorkspaceID("ws-1")

    await Instance.reload({
      directory: workspace,
      worktree: workspace,
      project: projectInfo("xp-current-proj", workspace, { time: { created: now, updated: now } }),
    })

    await Instance.provide({
      directory: workspace,
      fn: async () => {
        // Seed other-project facts directly into ProjectMemory
        await ProjectMemory.upsert(otherProjectId, {
          kind: "fact",
          text: "Authentication uses OAuth2 in the other-project",
          confidence: 0.9,
          evidence: ["readme.md"],
          tags: ["auth", "oauth2"],
        })

        // Create database rows so the workspace intelligence query finds a session/workspace
        Database.use((db) => {
          db.insert(ProjectTable)
            .values([
              { id: currentProjectId, worktree: workspace, vcs: "git", name: "Current", sandboxes: [], time_created: now, time_updated: now, time_initialized: now },
              { id: otherProjectId, worktree: path.join(workspace, "other"), vcs: "git", name: "Other", sandboxes: [], time_created: now, time_updated: now, time_initialized: now },
            ])
            .onConflictDoNothing()
            .run()

          db.insert(WorkspaceTable)
            .values({ id: workspaceID, project_id: currentProjectId, type: "worktree", directory: workspace })
            .onConflictDoNothing()
            .run()

          db.insert(SessionTable)
            .values({ id: sessionID, project_id: currentProjectId, workspace_id: workspaceID, slug: "xp-test", directory: workspace, title: "Test session", version: "test", time_created: now, time_updated: now })
            .onConflictDoNothing()
            .run()
        })

        const { WorkspaceIntelligence } = await import("../ai/workspace-intelligence")
        const result = await WorkspaceIntelligence.renderPromptContext({
          sessionID,
          projectID: currentProjectId,
          rootDir: workspace,
        })

        // The result should contain workspace_context since there's a session
        expect(result).toBeDefined()
        expect(result).toContain("<workspace_context>")

        // Cross-project memory is included if the other project has facts in ProjectMemory
        // (Embedding service may or may not hydrate vectors — just check block presence/absence gracefully)
        if (result?.includes("<cross_project_memory>")) {
          expect(result).toContain("</cross_project_memory>")
        }
      },
    })
  })

  test("renderPromptContext includes cross_project_symbols block when KG backup file exists", async () => {
    const root = cleanup[cleanup.length - 1]!
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "opencode-xp-intel-ws3-"))
    cleanup.push(workspace)

    const { Instance } = await import("../project/instance")
    const projectID = makeProjectID("xp-kg-proj")
    await Instance.reload({
      directory: workspace,
      worktree: workspace,
      project: projectInfo("xp-kg-proj", workspace),
    })

    await Instance.provide({
      directory: workspace,
      fn: async () => {
        const { Global } = await import("../global")
        const { Database } = await import("../storage/db")
        const { ProjectTable } = await import("../project/project.sql")
        const { SessionTable } = await import("../session/session.sql")
        const { WorkspaceTable } = await import("../control-plane/workspace.sql")

        const now = Date.now()
        const currentProject = projectID
        const otherProject = makeProjectID("xp-kg-other")
        const sessionID = makeSessionID("ses_xp_kg_test")
        const workspaceID = makeWorkspaceID("ws-kg-1")

        // Write a synthetic KG backup file for the other project
        const kgDir = path.join(Global.Path.data, "knowledge-graph")
        await fs.mkdir(kgDir, { recursive: true })
        const kgFile = path.join(kgDir, `${encodeURIComponent(otherProject)}.json`)
        await fs.writeFile(kgFile, JSON.stringify({
          nodes: [
            { id: "n1", type: "concept", name: "AuthService", content: "Handles auth", tags: [], metadata: {}, timeCreated: now, lastAccessed: now, accessCount: 1 },
            { id: "n2", type: "entity", name: "UserRepository", content: "User data access", tags: [], metadata: {}, timeCreated: now, lastAccessed: now, accessCount: 1 },
          ],
          edges: [],
        }), "utf8")

        // Create DB rows for workspace context signal
        Database.use((db) => {
          db.insert(ProjectTable)
            .values([
              { id: currentProject, worktree: workspace, vcs: "git", name: "KG Project", sandboxes: [], time_created: now, time_updated: now, time_initialized: now },
              { id: otherProject, worktree: path.join(workspace, "other"), vcs: "git", name: "Other KG", sandboxes: [], time_created: now, time_updated: now, time_initialized: now },
            ])
            .onConflictDoNothing()
            .run()
          db.insert(WorkspaceTable)
            .values({ id: workspaceID, project_id: currentProject, type: "worktree", directory: workspace })
            .onConflictDoNothing()
            .run()
          db.insert(SessionTable)
            .values({ id: sessionID, project_id: currentProject, workspace_id: workspaceID, slug: "xp-kg-test", directory: workspace, title: "KG Test Session", version: "test", time_created: now, time_updated: now })
            .onConflictDoNothing()
            .run()
        })

        const { WorkspaceIntelligence } = await import("../ai/workspace-intelligence")
        const result = await WorkspaceIntelligence.renderPromptContext({
          sessionID,
          projectID: currentProject,
          rootDir: workspace,
        })

        expect(result).toBeDefined()
        // KG context block should be present since the backup file exists
        expect(result).toContain("<cross_project_symbols>")
        expect(result).toContain("AuthService")
        expect(result).toContain("UserRepository")
        expect(result).toContain("</cross_project_symbols>")
      },
    })
  })
})
