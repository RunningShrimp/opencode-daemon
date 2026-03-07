import { Log } from "@/util/log"

import type { ThoughtNode } from "./tree-of-thought"

export class ThoughtNodeStorage {
  private log = Log.create({ service: "storage.thought-node" })

  async saveNode(node: ThoughtNode, sessionId: string): Promise<void> {
    this.log.info("Saved thought node", { id: node.id, sessionId })
  }

  async loadNode(nodeId: string): Promise<ThoughtNode | null> {
    this.log.info("Loading thought node", { id: nodeId })
    return null
  }

  async loadTree(sessionId: string): Promise<Map<string, ThoughtNode>> {
    this.log.info("Loading thought tree", { sessionId })
    return new Map()
  }

  async deleteNode(nodeId: string): Promise<void> {
    this.log.info("Deleted thought node", { id: nodeId })
  }
}
