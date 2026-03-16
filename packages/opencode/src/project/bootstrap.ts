import { Plugin } from "../plugin"
import { Format } from "../format"
import { LSP } from "../lsp"
import { FileWatcher } from "../file/watcher"
import { File } from "../file"
import { Project } from "./project"
import { Bus } from "../bus"
import { Command } from "../command"
import { Instance } from "./instance"
import { Vcs } from "./vcs"
import { Log } from "@/util/log"
import { ShareNext } from "@/share/share-next"
import { Snapshot } from "../snapshot"
import { Truncate } from "../tool/truncation"
import { ensureProjectIndexed } from "@/ai/rag/indexer"
import { vectorStore } from "@/ai/rag/vector-store"
import { knowledgeGraph } from "@/ai/knowledge"
import { refreshDerivedKnowledgeGraphSafe } from "@/ai/knowledge/derived"
import { bootstrapProjectMemorySafe } from "@/ai/memory/project-memory-bootstrap"
import { initEmbeddingBackgroundService } from "@/ai/rag/embedding-bg-service"
import { getBackgroundServiceManager } from "@/util/background-service"

export async function InstanceBootstrap() {
  Log.Default.info("bootstrapping", { directory: Instance.directory })
  await Plugin.init()
  ShareNext.init()
  Format.init()
  await LSP.init()
  FileWatcher.init()
  File.init()
  Vcs.init()
  Snapshot.init()
  Truncate.init()
  // Ensure the real embedding provider starts in every execution path (TUI
  // worker, workspace-server, etc.) — startAll() is idempotent so double
  // registration from index.ts is harmless.
  initEmbeddingBackgroundService()
  void getBackgroundServiceManager().startAll()
  void ensureProjectIndexed({
    rootDir: Instance.project.worktree,
    fallbackDir: Instance.directory,
    projectId: Instance.project.id,
    vectorStore,
  }).catch((error) => {
    Log.Default.warn("background rag prewarm failed", { projectID: Instance.project.id, error: String(error) })
  })
  void refreshDerivedKnowledgeGraphSafe(knowledgeGraph, Instance.project.worktree)
  void bootstrapProjectMemorySafe({
    projectID: Instance.project.id,
    rootDir: Instance.project.worktree,
    projectName: Instance.project.name,
    startCommand: Instance.project.commands?.start,
  })

  Bus.subscribe(Command.Event.Executed, async (payload) => {
    if (payload.properties.name === Command.Default.INIT) {
      await Project.setInitialized(Instance.project.id)
    }
  })
}
