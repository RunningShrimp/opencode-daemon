import { Log } from "@/util/log"
import type { ThoughtNode } from "@/ai/thinking/tree-of-thought"

export class ThinkTreeUI {
  private log = Log.create({ service: "ui.think-tree" })

  renderTree(node: ThoughtNode, depth = 0): string {
    const indent = "  ".repeat(depth)
    const marker = node.children.length > 0 ? "├─" : "└─"
    const score = `[${(node.score * 100).toFixed(0)}%]`
    const content = node.content.substring(0, 50)

    let output = `${indent}${marker} ${score} ${content}\n`

    for (const childId of node.children) {
      const child = this.getNode(childId)
      if (child) {
        output += this.renderTree(child, depth + 1)
      }
    }

    return output
  }

  private getNode(id: string): ThoughtNode | null {
    return null
  }

  renderCompact(nodes: Map<string, ThoughtNode>): string {
    const root = this.findRoot(nodes)
    if (!root) return "(empty tree)"

    return this.renderTree(root)
  }

  private findRoot(nodes: Map<string, ThoughtNode>): ThoughtNode | null {
    for (const node of nodes.values()) {
      if (!node.parentId) return node
    }
    return null
  }
}
