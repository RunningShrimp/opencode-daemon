import { describe, test, expect, beforeEach } from "bun:test"
import { SelfReviewWorkflow } from "@/ai/workflow/self-review-workflow"
import { QualityGate } from "@/ai/workflow/quality-gate"
import { SelfDrivingLoop } from "@/ai/thinking/self-driving-loop"
import { TreeOfThought } from "@/ai/thinking/tree-of-thought"
import { ThoughtNodeStorage } from "@/ai/thinking/thought-storage"

describe("Integration: Self-Driving + Self-Review + Think-Tree", () => {
  let selfDrivingLoop: SelfDrivingLoop
  let treeOfThought: TreeOfThought
  let workflow: SelfReviewWorkflow
  let qualityGate: QualityGate

  beforeEach(() => {
    selfDrivingLoop = new SelfDrivingLoop()
    treeOfThought = new TreeOfThought()
    workflow = new SelfReviewWorkflow()
    qualityGate = new QualityGate()
  })

  test("Phase 1: Self-review workflow integrates with quality gate", async () => {
    const mockCallTool = async (name: string, _args: any) => {
      if (name === "self_critique") {
        return {
          findings: [{ severity: "low", message: "Minor issue" }],
          completenessScore: 85,
        }
      }
      if (name === "review_verify") {
        return {
          findings: [],
          completenessScore: 90,
        }
      }
      return {}
    }

    const result = await workflow.executeAfterImplementation("const x = 1", ["Code is correct"], mockCallTool)

    expect(result.passed).toBe(true)
    expect(result.completenessScore).toBe(85)

    const decision = qualityGate.check({
      completenessScore: result.completenessScore || 0,
      findings: result.findings || [],
    })

    expect(decision.pass).toBe(true)
  })

  test("Phase 2: Self-driving loop detects remaining work", async () => {
    await selfDrivingLoop.initialize("Test task", {
      type: "implementation",
      description: "Test",
      complexity: "simple",
    })

    const report = selfDrivingLoop.detectRemainingWork()

    expect(report).toBeDefined()
    expect(report.progress).toBeGreaterThanOrEqual(0)
    expect(report.progress).toBeLessThanOrEqual(1)
    expect(Array.isArray(report.items)).toBe(true)
    expect(Array.isArray(report.suggestedActions)).toBe(true)
  })

  test("Phase 2: Auto-continue hooks can be setup", () => {
    const mockSession = {
      on: (event: string, handler: (result: any) => Promise<void>) => {
        expect(event).toBe("tool_complete")
        expect(typeof handler).toBe("function")
      },
    }

    expect(() => {
      selfDrivingLoop.setupAutoContinueHooks(mockSession as any)
    }).not.toThrow()
  })

  test("Phase 3: Tree of thought can be initialized and expanded", async () => {
    treeOfThought.initialize()

    const root = await treeOfThought.startThinking("Test prompt")

    expect(root).toBeDefined()
    expect(root.content).toBe("Test prompt")
    expect(root.score).toBe(1.0)
    expect(root.depth).toBe(0)
    expect(root.parentId).toBeNull()
  })

  test("Phase 3: Thought node storage can save and load", async () => {
    const storage = new ThoughtNodeStorage()

    const node = {
      id: "test-node-1",
      content: "Test thought",
      score: 0.8,
      confidence: 0.5,
      parentId: null,
      children: [],
      depth: 0,
      isLeaf: true,
      createdAt: Date.now(),
    }

    await expect(storage.saveNode(node, "test-session")).resolves.not.toThrow()
  })

  test("End-to-end: All three phases work together", async () => {
    await selfDrivingLoop.initialize("Complete integration test", {
      type: "implementation",
      description: "Test all phases",
      complexity: "moderate",
    })

    treeOfThought.initialize()
    await treeOfThought.startThinking("Integration test reasoning")

    const mockCallTool = async (_name: string, _args: any) => {
      return {
        findings: [],
        completenessScore: 95,
      }
    }

    const reviewResult = await workflow.executeAfterImplementation(
      "const result = 'integration test'",
      ["All tests pass"],
      mockCallTool,
    )

    const gateDecision = qualityGate.check({
      completenessScore: reviewResult.completenessScore || 0,
      findings: reviewResult.findings || [],
    })

    const remainingWork = selfDrivingLoop.detectRemainingWork()

    expect(reviewResult.passed).toBe(true)
    expect(gateDecision.pass).toBe(true)
    expect(remainingWork).toBeDefined()
  })
})
