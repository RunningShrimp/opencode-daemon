import { db } from "@/storage/db"
import { ThoughtNodeTable } from "@/session/session.sql"
import { eq } from "drizzle-orm"
import { Log } from "@/util/log"

import type { ThoughtNode } from "./tree-of-thought"

export class ThoughtNodeStorage {
  private log = Log.create({ service: "storage.thought-node" })

  async saveNode(node: ThoughtNode, sessionId: string): Promise<void> {
    await db.insert(ThoughtNodeTable).values({
      id: node.id,
      session_id: sessionId,
      parent_id: node.parentId,
      content: node.content,
      score: node.score,
      children: JSON.stringify(node.children),
      depth: node.depth,
      metadata: JSON.stringify({}),
      created_at: node.createdAt,
    })
    this.log.info("Saved thought node", { id: node.id, sessionId })
  }

  async loadNode(nodeId: string): Promise<ThoughtNode | null> {
    const result = await db.select().from(ThoughtNodeTable).where(eq(ThoughtNodeTable.id, nodeId)).limit(1)

    if (!result[0]) return null

    return this.rowToNode(result[0])
  }

  async loadTree(sessionId: string): Promise<Map<string, ThoughtNode>> {
    const rows = await db.select().from(ThoughtNodeTable).where(eq(ThoughtNodeTable.session_id, sessionId))

    const nodes = new Map<string, ThoughtNode>()
    for (const row of rows) {
      nodes.set(row.id, this.rowToNode(row))
    }

    this.log.info("Loaded thought tree", { sessionId, count: nodes.size })
    return nodes
  }

  async deleteNode(nodeId: string): Promise<void> {
    await db.delete(ThoughtNodeTable).where(eq(ThoughtNodeTable.id, nodeId))
    this.log.info("Deleted thought node", { id: nodeId })
  }

  private rowToNode(row: any): ThoughtNode {
    return {
      id: row.id,
      content: row.content,
      score: row.score,
      confidence: 0.5,
      parentId: row.parent_id,
      children: JSON.parse(row.children || "[]"),
      depth: row.depth,
      isLeaf: true,
      createdAt: row.created_at,
    }
  }
  }
}
