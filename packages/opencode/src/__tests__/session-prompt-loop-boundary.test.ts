import { afterEach, describe, expect, mock, spyOn, test } from "bun:test"
import { MessageV2 } from "../session/message-v2"
import { SessionCompaction } from "../session/compaction"
import { IntentDetection } from "../ai/thinking/intent"
import { SessionPrompt } from "../session/prompt"
import { messageID, modelID, partID, providerID, sessionID } from "../test-helpers/ids"

afterEach(() => {
  mock.restore()
})

function createTokens(total: number) {
  return {
    total,
    input: total,
    output: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  }
}

function createModel() {
  return {
    id: modelID("test-model"),
    providerID: providerID("test-provider"),
    api: {
      id: "test-model",
      url: "https://example.com",
      npm: "@ai-sdk/openai",
    },
    name: "Test Model",
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: true,
      toolcall: true,
      input: {
        text: true,
        audio: false,
        image: true,
        video: false,
        pdf: true,
      },
      output: {
        text: true,
        audio: false,
        image: false,
        video: false,
        pdf: false,
      },
      interleaved: false,
    },
    cost: {
      input: 0,
      output: 0,
      cache: { read: 0, write: 0 },
    },
    limit: {
      context: 70000,
      input: 60000,
      output: 5000,
    },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-01-01",
  } as any
}

function createAssistantWithLargeOutput(text: string) {
  return {
    info: {
      id: messageID("assistant_latest"),
      parentID: messageID("user_latest"),
      sessionID: sessionID("session_prompt_test"),
      role: "assistant",
      providerID: providerID("test-provider"),
      modelID: modelID("test-model"),
      time: { created: 2, completed: 3 },
    },
    parts: [
      {
        id: partID("assistant_text"),
        sessionID: sessionID("session_prompt_test"),
        messageID: messageID("assistant_latest"),
        type: "text",
        text,
      },
    ],
  } as any
}

describe("SessionPrompt.getLoopBoundary", () => {
  test("uses max step limit when turn control is not active", () => {
    const result = SessionPrompt.getLoopBoundary({
      turnControlReady: false,
      turnController: {
        shouldContinue() {
          throw new Error("should not be called")
        },
      },
      step: 3,
      maxSteps: 3,
    })

    expect(result.turnDecision).toBeUndefined()
    expect(result.shouldWrapUp).toBe(false)
    expect(result.isLastStep).toBe(true)
  })

  test("does not call turn control without finished token usage", () => {
    const result = SessionPrompt.getLoopBoundary({
      turnControlReady: true,
      turnController: {
        shouldContinue() {
          throw new Error("should not be called")
        },
      },
      step: 1,
      maxSteps: 5,
    })

    expect(result.turnDecision).toBeUndefined()
    expect(result.shouldWrapUp).toBe(false)
    expect(result.isLastStep).toBe(false)
  })

  test("forces wrap-up when turn controller says to stop", () => {
    const result = SessionPrompt.getLoopBoundary({
      turnControlReady: true,
      lastFinished: {
        tokens: createTokens(42000),
      },
      turnController: {
        shouldContinue(current) {
          expect(current).toBe(42000)
          return {
            shouldContinue: false,
            reason: "budget exceeded",
          }
        },
      },
      step: 1,
      maxSteps: 8,
    })

    expect(result.turnDecision).toEqual({
      shouldContinue: false,
      reason: "budget exceeded",
    })
    expect(result.shouldWrapUp).toBe(true)
    expect(result.isLastStep).toBe(true)
  })

  test("does not force wrap-up when turn controller says to continue", () => {
    const result = SessionPrompt.getLoopBoundary({
      turnControlReady: true,
      lastFinished: { tokens: createTokens(30000) },
      turnController: {
        shouldContinue() {
          return { shouldContinue: true, reason: "within budget" }
        },
      },
      step: 2,
      maxSteps: 10,
    })
    expect(result.turnDecision).toEqual({ shouldContinue: true, reason: "within budget" })
    expect(result.shouldWrapUp).toBe(false)
  })

  test("respects maxSteps even when turn controller allows continuation", () => {
    const result = SessionPrompt.getLoopBoundary({
      turnControlReady: true,
      lastFinished: { tokens: createTokens(10000) },
      turnController: {
        shouldContinue() {
          return { shouldContinue: true, reason: "ok" }
        },
      },
      step: 5,
      maxSteps: 5,
    })
    expect(result.isLastStep).toBe(true)
  })

  test("resets max-step enforcement after a synthetic reminder starts a new autonomous round", () => {
    const result = SessionPrompt.getLoopBoundary({
      turnControlReady: true,
      lastFinished: { tokens: createTokens(10000) },
      turnController: {
        shouldContinue() {
          return { shouldContinue: true, reason: "ok" }
        },
      },
      step: 5,
      roundBaseStep: 5,
      maxSteps: 5,
    })

    expect(result.isLastStep).toBe(false)
  })

  test("does not immediately force wrap-up on the first synthetic retry when agent maxSteps is 1", () => {
    const result = SessionPrompt.getLoopBoundary({
      turnControlReady: true,
      lastFinished: { tokens: createTokens(10000) },
      turnController: {
        shouldContinue() {
          return { shouldContinue: true, reason: "ok" }
        },
      },
      step: 6,
      roundBaseStep: 5,
      maxSteps: 1,
    })

    expect(result.isLastStep).toBe(false)
  })
})

describe("SessionPrompt.getVerificationRevisionKey", () => {
  test("pins verification retries to the original turn user id", () => {
    expect(
      SessionPrompt.getVerificationRevisionKey({
        turnUserID: "user_original",
        lastUserID: "user_synthetic_retry",
      }),
    ).toBe("user_original")
  })

  test("falls back to the current user id when the turn id is unavailable", () => {
    expect(
      SessionPrompt.getVerificationRevisionKey({
        lastUserID: "user_current",
      }),
    ).toBe("user_current")
  })
})

describe("SessionPrompt.getAutonomousResumeMode", () => {
  test("prefers self-driven continuation when a next-round task exists", () => {
    expect(
      SessionPrompt.getAutonomousResumeMode({
        syntheticReminderLoop: true,
        hasPendingTodos: true,
        hasNextRoundTask: true,
      }),
    ).toBe("self_driven")
  })

  test("uses todo continuation for the first non-synthetic follow-up when only todos remain", () => {
    expect(
      SessionPrompt.getAutonomousResumeMode({
        syntheticReminderLoop: false,
        hasPendingTodos: true,
        hasNextRoundTask: false,
      }),
    ).toBe("todo")
  })

  test("stops repeating todo-only reminders once already in a synthetic reminder loop", () => {
    expect(
      SessionPrompt.getAutonomousResumeMode({
        syntheticReminderLoop: true,
        hasPendingTodos: true,
        hasNextRoundTask: false,
      }),
    ).toBe("stop")
  })
})

describe("SessionPrompt.getStopHandoffResumeMode", () => {
  test("prefers todo continuation after a repeated self-driven rollover handoff when todos remain", () => {
    expect(
      SessionPrompt.getStopHandoffResumeMode({
        syntheticReminderLoop: true,
        repeatingSelfDrivenHandoff: true,
        hasPendingTodos: true,
        hasNextRoundTask: true,
      }),
    ).toBe("todo")
  })

  test("stops a repeated self-driven rollover handoff when no todos remain", () => {
    expect(
      SessionPrompt.getStopHandoffResumeMode({
        syntheticReminderLoop: true,
        repeatingSelfDrivenHandoff: true,
        hasPendingTodos: false,
        hasNextRoundTask: true,
      }),
    ).toBe("stop")
  })

  test("keeps self-driven continuation on the first rollover handoff retry", () => {
    expect(
      SessionPrompt.getStopHandoffResumeMode({
        syntheticReminderLoop: false,
        repeatingSelfDrivenHandoff: false,
        hasPendingTodos: true,
        hasNextRoundTask: true,
      }),
    ).toBe("self_driven")
  })
})

describe("SessionPrompt.hasOpenWorkflowTasks", () => {
  test("detects pending workflow tasks", () => {
    expect(
      SessionPrompt.hasOpenWorkflowTasks({
        plan: {
          plan: {
            steps: [
              {
                tasks: [
                  { id: "task_1", status: "completed" },
                  { id: "task_2", status: "pending" },
                ],
              },
            ],
          },
        },
      } as any),
    ).toBe(true)
  })

  test("returns false when workflow tasks are fully completed", () => {
    expect(
      SessionPrompt.hasOpenWorkflowTasks({
        plan: {
          plan: {
            steps: [
              {
                tasks: [
                  { id: "task_1", status: "completed" },
                  { id: "task_2", status: "completed" },
                ],
              },
            ],
          },
        },
      } as any),
    ).toBe(false)
  })
})

describe("SessionPrompt.getNoOpUnknownResumeMode", () => {
  test("prefers todo recovery when todos remain", () => {
    expect(
      SessionPrompt.getNoOpUnknownResumeMode({
        syntheticReminderLoop: false,
        repeatingSelfDrivenNoOpState: false,
        hasPendingTodos: true,
        hasOpenWorkflowTasks: true,
        hasNextRoundTask: false,
      }),
    ).toBe("todo")
  })

  test("prefers self-driven recovery when the empty turn still carried next-round work", () => {
    expect(
      SessionPrompt.getNoOpUnknownResumeMode({
        syntheticReminderLoop: true,
        repeatingSelfDrivenNoOpState: false,
        hasPendingTodos: true,
        hasOpenWorkflowTasks: true,
        hasNextRoundTask: true,
      }),
    ).toBe("self_driven")
  })

  test("stops repeated self-driven reminder retries when the same carryover already looped once", () => {
    expect(
      SessionPrompt.getNoOpUnknownResumeMode({
        syntheticReminderLoop: true,
        repeatingSelfDrivenNoOpState: true,
        hasPendingTodos: false,
        hasOpenWorkflowTasks: false,
        hasNextRoundTask: true,
      }),
    ).toBe("stop")
  })

  test("falls back to todo recovery after a repeated self-driven reminder when todos still remain", () => {
    expect(
      SessionPrompt.getNoOpUnknownResumeMode({
        syntheticReminderLoop: true,
        repeatingSelfDrivenNoOpState: true,
        hasPendingTodos: true,
        hasOpenWorkflowTasks: true,
        hasNextRoundTask: true,
      }),
    ).toBe("todo")
  })

  test("falls back to workflow recovery after a repeated self-driven reminder when only workflow work remains", () => {
    expect(
      SessionPrompt.getNoOpUnknownResumeMode({
        syntheticReminderLoop: true,
        repeatingSelfDrivenNoOpState: true,
        hasPendingTodos: false,
        hasOpenWorkflowTasks: true,
        hasNextRoundTask: true,
      }),
    ).toBe("workflow")
  })

  test("falls back to workflow recovery when todos are done but plan work remains", () => {
    expect(
      SessionPrompt.getNoOpUnknownResumeMode({
        syntheticReminderLoop: false,
        repeatingSelfDrivenNoOpState: false,
        hasPendingTodos: false,
        hasOpenWorkflowTasks: true,
        hasNextRoundTask: false,
      }),
    ).toBe("workflow")
  })

  test("stops when neither todo nor workflow work remains", () => {
    expect(
      SessionPrompt.getNoOpUnknownResumeMode({
        syntheticReminderLoop: false,
        repeatingSelfDrivenNoOpState: false,
        hasPendingTodos: false,
        hasOpenWorkflowTasks: false,
        hasNextRoundTask: false,
      }),
    ).toBe("stop")
  })

  test("stops once already in a synthetic reminder retry loop", () => {
    expect(
      SessionPrompt.getNoOpUnknownResumeMode({
        syntheticReminderLoop: true,
        repeatingSelfDrivenNoOpState: false,
        hasPendingTodos: true,
        hasOpenWorkflowTasks: true,
        hasNextRoundTask: false,
      }),
    ).toBe("stop")
  })
})

describe("SessionPrompt.hasRepeatedSelfDrivenNoOpState", () => {
  test("detects a stale self-driven no-op state even after the loop briefly downgraded to a todo reminder", () => {
    const repeated = SessionPrompt.hasRepeatedSelfDrivenNoOpState({
      history: [
        {
          info: { id: messageID("assistant_prev"), role: "assistant", finish: "unknown" },
          parts: [
            {
              type: "tool",
              tool: "self_driven",
              state: {
                status: "completed",
                input: { next_round_task: true },
                metadata: {
                  internal: true,
                  currentStatus:
                    "phase=acting | progress=100% | remaining=0 | carryover=1 | nextRoundTask=yes | nextAction=Next step: read crates/application/src/rules.rs",
                  nextAction: "Next step: read crates/application/src/rules.rs",
                  remainingItems: [],
                },
              },
            },
            { type: "step-start" },
            { type: "step-finish" },
          ],
        },
        {
          info: { id: messageID("user_todo"), role: "user" },
          parts: [
            {
              type: "text",
              text: '<system-reminder>The previous autonomous round produced no user-visible output, but your todo list still has unfinished work. Continue with: "[Wave 2] Execute W2".</system-reminder>',
              synthetic: true,
            },
          ],
        },
      ] as any,
      lastUserID: messageID("user_todo"),
      assistantParts: [
        {
          type: "tool",
          tool: "self_driven",
          state: {
            status: "completed",
            input: { next_round_task: true },
            metadata: {
              internal: true,
              currentStatus:
                "phase=acting | progress=100% | remaining=0 | carryover=1 | nextRoundTask=yes | nextAction=Next step: read crates/application/src/rules.rs",
              nextAction: "Next step: read crates/application/src/rules.rs",
              remainingItems: [],
            },
          },
        },
        { type: "step-start" },
        { type: "step-finish" },
      ] as any,
    })

    expect(repeated).toBe(true)
  })

  test("returns false when the previous assistant before the synthetic reminder was not a no-op unknown turn", () => {
    const repeated = SessionPrompt.hasRepeatedSelfDrivenNoOpState({
      history: [
        {
          info: { id: messageID("assistant_prev"), role: "assistant", finish: "tool-calls" },
          parts: [
            { type: "text", text: "Applied the next batch of edits." },
            { type: "step-finish", reason: "tool-calls" },
          ],
        },
        {
          info: { id: messageID("user_todo"), role: "user" },
          parts: [
            {
              type: "text",
              text: '<system-reminder>The previous autonomous round produced no user-visible output, but your todo list still has unfinished work. Continue with: "[Wave 2] Execute W2".</system-reminder>',
              synthetic: true,
            },
          ],
        },
      ] as any,
      lastUserID: messageID("user_todo"),
      assistantParts: [
        {
          type: "tool",
          tool: "self_driven",
          state: {
            status: "completed",
            input: { next_round_task: true },
            metadata: {
              internal: true,
              currentStatus:
                "phase=acting | progress=100% | remaining=0 | carryover=1 | nextRoundTask=yes | nextAction=Next step: read crates/application/src/rules.rs",
              nextAction: "Next step: read crates/application/src/rules.rs",
              remainingItems: [],
            },
          },
        },
        { type: "step-start" },
        { type: "step-finish" },
      ] as any,
    })

    expect(repeated).toBe(false)
  })
})

describe("SessionPrompt.isTodoContinuationReminderMessage", () => {
  test("recognizes todo continuation directives inside synthetic reminders", () => {
    expect(
      SessionPrompt.isTodoContinuationReminderMessage([
        {
          type: "text",
          text: '<system-reminder>The previous autonomous round produced no user-visible output, but your todo list still has unfinished work. Continue with: "[Wave 2] Execute W2".</system-reminder>',
          synthetic: true,
        },
      ] as any),
    ).toBe(true)
  })

  test("does not treat self-driven continuation directives as todo reminders", () => {
    expect(
      SessionPrompt.isTodoContinuationReminderMessage([
        {
          type: "text",
          text: `<system-reminder>${SessionPrompt.buildSelfDrivenContinuationDirective({
            currentStatus: "phase=acting | progress=100% | remaining=0 | carryover=1 | nextRoundTask=yes",
            nextAction: "Check the cross-cutting crate name.",
            remainingItems: [],
          })}</system-reminder>`,
          synthetic: true,
        },
      ] as any),
    ).toBe(false)
  })
})

describe("SessionPrompt.extractSelfDrivenStateFromParts", () => {
  test("recovers the next action from currentStatus when metadata is sparse", () => {
    expect(
      SessionPrompt.extractSelfDrivenStateFromParts([
        {
          type: "tool",
          tool: "self_driven",
          state: {
            status: "completed",
            input: {
              next_round_task: true,
            },
            output: "Prepared self-driven context for the next model call.",
            metadata: {
              internal: true,
              currentStatus:
                "phase=acting | progress=100% | remaining=0 | carryover=1 | nextRoundTask=yes | nextAction=Let me check the cross-cutting crate name.",
            },
          },
        },
      ] as any),
    ).toEqual({
      hasNextRoundTask: true,
      currentStatus:
        "phase=acting | progress=100% | remaining=0 | carryover=1 | nextRoundTask=yes | nextAction=Let me check the cross-cutting crate name.",
      nextAction: "check the cross-cutting crate name.",
      remainingItems: [],
    })
  })
})

describe("SessionPrompt.shouldEnforceTurnWrapUp", () => {
  test("keeps wrap-up enabled when no autonomous continuation remains", () => {
    expect(
      SessionPrompt.shouldEnforceTurnWrapUp({
        turnDecision: { shouldContinue: false },
        hasNextRoundTask: false,
      }),
    ).toBe(true)
  })

  test("lets self-driven continuation override wrap-up heuristics", () => {
    expect(
      SessionPrompt.shouldEnforceTurnWrapUp({
        turnDecision: { shouldContinue: false },
        hasNextRoundTask: true,
      }),
    ).toBe(false)
  })
})

describe("SessionPrompt.buildSelfDrivenHistoryContent", () => {
  test("preserves self-driven next-round work from internal tool parts", () => {
    const content = SessionPrompt.buildSelfDrivenHistoryContent([
      {
        type: "text",
        text: "Compilation errors in loader.rs are blocking the integration.",
      },
      {
        type: "tool",
        tool: "self_driven",
        state: {
          status: "completed",
          input: {
            next_round_task: true,
          },
          output: "Prepared self-driven context for the next model call.",
          title: "Self-driven state prepared",
          metadata: {
            internal: true,
            nextAction: "Fix the syntax errors in loader.rs, then rerun cargo build.",
            remainingItems: ["Fix loader.rs syntax errors", "Rerun cargo build"],
          },
        },
      },
    ] as any)

    expect(content).toContain("Compilation errors in loader.rs are blocking the integration.")
    expect(content).toContain("Next step: Fix the syntax errors in loader.rs, then rerun cargo build.")
    expect(content).toContain("Remaining tasks:")
    expect(content).toContain("- Fix loader.rs syntax errors")
    expect(content).toContain("- Rerun cargo build")
  })

  test("omits ignored autonomous tool preambles from history text", () => {
    const content = SessionPrompt.buildSelfDrivenHistoryContent([
      {
        type: "text",
        text: "Now I have all the exact strings. Fixing all 3 broken helpers in parallel:",
        ignored: true,
      },
      {
        type: "tool",
        tool: "edit",
        state: {
          status: "completed",
          input: {},
          output: "patched",
          time: { start: 1, end: 2 },
        },
      },
      {
        type: "tool",
        tool: "self_driven",
        state: {
          status: "completed",
          input: {
            next_round_task: true,
          },
          output: "Prepared self-driven context for the next model call.",
          title: "Self-driven state prepared",
          metadata: {
            internal: true,
            nextAction: "Run cargo test on all 3 crates.",
            remainingItems: ["Run cargo test on all 3 crates"],
          },
        },
      },
    ] as any)

    expect(content).not.toContain("Now I have all the exact strings")
    expect(content).toContain("Next step: Run cargo test on all 3 crates.")
  })
})

describe("SessionPrompt.getMaxStepPrompt", () => {
  test("uses terse rollover prompt when autonomous work must continue", () => {
    const prompt = SessionPrompt.getMaxStepPrompt({ hasNextRoundTask: true })

    expect(prompt).toContain("terse rollover handoff")
    expect(prompt).toContain('Do NOT add headings such as "Summary", "Remaining Tasks", "Recommendations", or "Next Steps".')
    expect(prompt).not.toContain("MUST provide a text response summarizing work done so far")
  })

  test("keeps the wrap-up template when no autonomous continuation remains", () => {
    const prompt = SessionPrompt.getMaxStepPrompt({ hasNextRoundTask: false })

    expect(prompt).toContain("MUST provide a text response summarizing work done so far")
    expect(prompt).toContain("Recommendations for what should be done next")
  })
})

describe("SessionPrompt.buildSelfDrivenContinuationDirective", () => {
  test("turns rollover handoff text into an execution-first directive", () => {
    const directive = SessionPrompt.buildSelfDrivenContinuationDirective({
      currentStatus: "phase=implement | progress=70% | remaining=2 | carryover=2 | nextRoundTask=yes",
      nextAction: [
        "The exact next step if autonomous work should continue in the next round:",
        "Fix the compilation errors immediately, then rerun the existing test suite.",
      ].join("\n"),
      remainingItems: ["Resolve dependency-injection compilation errors", "Rerun the failing test suite"],
    })

    expect(directive).toContain(
      "Execute this next action first: Fix the compilation errors immediately, then rerun the existing test suite.",
    )
    expect(directive).toContain("Do not repeat work summaries, exact-next-step headings, or recommendation sections.")
    expect(directive).toContain("If you are about to call tools, start with the tool calls.")
    expect(directive).not.toContain("The exact next step if autonomous work should continue in the next round")
  })

  test("sanitizes Chinese next-step prefixes before building the directive", () => {
    const directive = SessionPrompt.buildSelfDrivenContinuationDirective({
      currentStatus: "phase=implement | progress=50% | remaining=1 | carryover=1 | nextRoundTask=yes",
      nextAction: "下一步：补充回归测试。",
      remainingItems: ["重新构建二进制并检查日志"],
    })

    expect(directive).toContain("Execute this next action first: 补充回归测试。")
    expect(directive).not.toContain("Execute this next action first: 下一步：补充回归测试。")
  })

  test("strips first-person lead-ins from next actions before building the directive", () => {
    const directive = SessionPrompt.buildSelfDrivenContinuationDirective({
      currentStatus: "phase=acting | progress=100% | remaining=0 | carryover=1 | nextRoundTask=yes",
      nextAction: "Next step: Let me check the cross-cutting crate name.",
      remainingItems: [],
    })

    expect(directive).toContain("Execute this next action first: check the cross-cutting crate name.")
    expect(directive).not.toContain("Execute this next action first: Let me check the cross-cutting crate name.")
  })

  test("extracts embedded next action from terse phase-complete summaries", () => {
    const directive = SessionPrompt.buildSelfDrivenContinuationDirective({
      currentStatus: "phase=acting | progress=100% | remaining=0 | carryover=1 | nextRoundTask=yes",
      nextAction:
        "Phase 0 complete — all 16 P0 tasks committed, 74/75 tests pass. Next: read docs/plans/2026-02-28-refactoring-implementation-plan.md Phase 1 section and create Phase 1 todos.",
      remainingItems: [],
    })

    expect(directive).toContain(
      "Execute this next action first: read docs/plans/2026-02-28-refactoring-implementation-plan.md Phase 1 section and create Phase 1 todos.",
    )
    expect(directive).not.toContain("Execute this next action first: Phase 0 complete")
  })

  test("extracts exact next action from markdown-labeled blocker handoff", () => {
    const directive = SessionPrompt.buildSelfDrivenContinuationDirective({
      currentStatus: "phase=acting | progress=100% | remaining=0 | carryover=2 | nextRoundTask=yes",
      nextAction: [
        "**Phase 0 is fully complete** — all 16 P0 tasks committed, 74/75 tests pass (1 pre-existing failure).",
        "",
        "**Blocker**: I need to read 3 files to assess Phase 1 readiness.",
        "",
        "**Exact next action**: Read `crates/review/src/lib.rs`, `crates/indexing/src/lib.rs`, `crates/analysis/src/lint.rs` in parallel, compare them against the Phase 1 plan, then create the Phase 1 todo list.",
      ].join("\n"),
      remainingItems: [],
    })

    expect(directive).toContain(
      "Execute this next action first: Read `crates/review/src/lib.rs`, `crates/indexing/src/lib.rs`, `crates/analysis/src/lint.rs` in parallel, compare them against the Phase 1 plan, then create the Phase 1 todo list.",
    )
    expect(directive).not.toContain("Execute this next action first: Phase 0 is fully complete")
    expect(directive).not.toContain("Execute this next action first: Blocker")
  })

  test("drops stall-note text from next actions and falls back to the generic continuation directive", () => {
    const directive = SessionPrompt.buildSelfDrivenContinuationDirective({
      currentStatus: "phase=acting | progress=100% | remaining=0 | carryover=1 | nextRoundTask=yes",
      nextAction:
        "Autonomous continuation stalled after repeated empty rounds. The model kept selecting the same next action without producing user-visible progress.",
      remainingItems: [],
    })

    expect(directive).toContain(
      "Execute this next action first: Continue with the next concrete implementation step from the previous round.",
    )
    expect(directive).not.toContain("Execute this next action first: Autonomous continuation stalled after repeated empty rounds")
  })
})

describe("SessionPrompt.isSyntheticReminderMessage", () => {
  test("recognizes oh-my-opencode todo continuation directives as synthetic continuation", () => {
    expect(
      SessionPrompt.isSyntheticReminderMessage([
        {
          type: "text",
          text: [
            "[SYSTEM DIRECTIVE: OH-MY-OPENCODE - TODO CONTINUATION]",
            "",
            "Continue autonomously with the next pending task.",
            "<!-- OMO_INTERNAL_INITIATOR -->",
          ].join("\n"),
          synthetic: true,
        },
      ] as any),
    ).toBe(true)
  })
})

describe("SessionPrompt.isSelfDrivenContinuationReminderMessage", () => {
  test("recognizes self-driven continuation directives inside synthetic reminders", () => {
    expect(
      SessionPrompt.isSelfDrivenContinuationReminderMessage([
        {
          type: "text",
          text: `<system-reminder>${SessionPrompt.buildSelfDrivenContinuationDirective({
            currentStatus: "phase=acting | progress=100% | remaining=0 | carryover=1 | nextRoundTask=yes",
            nextAction: "Check the cross-cutting crate name.",
            remainingItems: [],
          })}</system-reminder>`,
          synthetic: true,
        },
      ] as any),
    ).toBe(true)
  })

  test("does not treat generic synthetic continuation reminders as self-driven directives", () => {
    expect(
      SessionPrompt.isSelfDrivenContinuationReminderMessage([
        {
          type: "text",
          text: [
            "[SYSTEM DIRECTIVE: OH-MY-OPENCODE - TODO CONTINUATION]",
            "",
            "Continue autonomously with the next pending task.",
            "<!-- OMO_INTERNAL_INITIATOR -->",
          ].join("\n"),
          synthetic: true,
        },
      ] as any),
    ).toBe(false)
  })
})

describe("SessionPrompt.suppressAutonomousToolPreambleParts", () => {
  test("marks short autonomous lead-ins ignored before the first external tool", () => {
    const parts = [
      {
        type: "text",
        text: "Now I have all the exact strings. Fixing all 3 broken helpers in parallel:",
      },
      {
        type: "tool",
        tool: "edit",
        state: {
          status: "completed",
          input: {},
          output: "patched",
          time: { start: 1, end: 2 },
        },
      },
    ] as any

    const suppressed = SessionPrompt.suppressAutonomousToolPreambleParts({
      syntheticReminderLoop: true,
      parts,
    })

    expect(suppressed).toHaveLength(1)
    expect(parts[0].ignored).toBe(true)
  })

  test("keeps the preamble visible outside autonomous continuation loops", () => {
    const parts = [
      {
        type: "text",
        text: "Now I have all the exact strings. Fixing all 3 broken helpers in parallel:",
      },
      {
        type: "tool",
        tool: "edit",
        state: {
          status: "completed",
          input: {},
          output: "patched",
          time: { start: 1, end: 2 },
        },
      },
    ] as any

    const suppressed = SessionPrompt.suppressAutonomousToolPreambleParts({
      syntheticReminderLoop: false,
      parts,
    })

    expect(suppressed).toHaveLength(0)
    expect(parts[0].ignored).toBeUndefined()
  })
})

describe("SessionPrompt.compactSyntheticResumeAssistantText", () => {
  test("replaces rollover wrap-up summaries with a compact continuation note inside synthetic loops", () => {
    const compacted = SessionPrompt.compactSyntheticResumeAssistantText({
      syntheticReminderLoop: true,
      assistantText: [
        "# Summary of Work Completed",
        "",
        "Remaining tasks:",
        "- Fix the compilation errors.",
        "",
        "The exact next step if autonomous work should continue in the next round:",
        "Fix the compilation errors immediately, then rerun the tests.",
        "",
        "Recommendations:",
        "1. Fix the blocker.",
      ].join("\n"),
    })

    expect(compacted).toContain("Previous round ended with a rollover handoff summary.")
    expect(compacted).not.toContain("The exact next step if autonomous work should continue in the next round")
    expect(compacted).not.toContain("Recommendations")
  })

  test("leaves normal assistant text unchanged outside synthetic loops", () => {
    const original = "Next step: rerun the focused test suite."
    expect(
      SessionPrompt.compactSyntheticResumeAssistantText({
        syntheticReminderLoop: false,
        assistantText: original,
      }),
    ).toBe(original)
  })

  test("compacts terse phase-complete handoff summaries inside synthetic loops", () => {
    const compacted = SessionPrompt.compactSyntheticResumeAssistantText({
      syntheticReminderLoop: true,
      assistantText:
        "Phase 0 complete — all 16 P0 tasks committed, 74/75 tests pass. Next round: read docs/plans/2026-02-28-refactoring-implementation-plan.md Phase 1 section and create Phase 1 todos.",
    })

    expect(compacted).toContain("Previous round ended with a rollover handoff summary.")
    expect(compacted).not.toContain("Phase 0 complete")
    expect(compacted).not.toContain("Next round:")
  })

  test("compacts blocked terse handoff summaries inside synthetic loops", () => {
    const compacted = SessionPrompt.compactSyntheticResumeAssistantText({
      syntheticReminderLoop: true,
      assistantText:
        "W2-T01/T03/T04 complete (unwrap cleanup, unreachable! removal, #[ignore] comments). W2-T02 blocked — must `read` `crates/domain/src/specification.rs` lines 80-110 FIRST then `edit` lines 85-87 and 105-107 to add safety docs.",
    })

    expect(compacted).toContain("Previous round ended with a rollover handoff summary.")
    expect(compacted).not.toContain("W2-T01/T03/T04 complete")
    expect(compacted).not.toContain("must `read`")
  })

  test("compacts concise progress handoff summaries inside synthetic loops", () => {
    const compacted = SessionPrompt.compactSyntheticResumeAssistantText({
      syntheticReminderLoop: true,
      assistantText:
        "Applied `orchestration/src/pipeline.rs:381` `.unwrap()` -> `ok_or_else`. Core edit at `core/src/pipeline.rs:382` not yet applied - step boundary reached before edit tool could fire. Next: edit `core/src/pipeline.rs:382`, run `cargo check`, then clean up `#[allow]` comments.",
    })

    expect(compacted).toContain("Previous round ended with a rollover handoff summary.")
    expect(compacted).not.toContain("Applied `orchestration/src/pipeline.rs:381`")
    expect(compacted).not.toContain("Next: edit `core/src/pipeline.rs:382`")
  })
})

describe("SessionPrompt.isAutonomousStopHandoffAssistantTurn", () => {
  test("recognizes stop-finish rollover handoff summaries", () => {
    expect(
      SessionPrompt.isAutonomousStopHandoffAssistantTurn({
        finish: "stop",
        parts: [
          {
            type: "text",
            text:
              "Phase 0 complete — all 16 P0 tasks committed, 74/75 tests pass. Next round: read docs/plans/2026-02-28-refactoring-implementation-plan.md Phase 1 section and create Phase 1 todos.",
          },
        ] as any,
      }),
    ).toBe(true)
  })

  test("does not treat tool-call turns as stop handoff summaries", () => {
    expect(
      SessionPrompt.isAutonomousStopHandoffAssistantTurn({
        finish: "tool-calls",
        parts: [
          {
            type: "text",
            text: "Reading the implementation plan.",
          },
        ] as any,
      }),
    ).toBe(false)
  })

  test("recognizes blocked terse rollover handoff summaries without explicit next markers", () => {
    expect(
      SessionPrompt.isAutonomousStopHandoffAssistantTurn({
        finish: "stop",
        parts: [
          {
            type: "text",
            text:
              "W2-T01/T03/T04 complete (unwrap cleanup, unreachable! removal, #[ignore] comments). W2-T02 blocked — must `read` `crates/domain/src/specification.rs` lines 80-110 FIRST then `edit` lines 85-87 and 105-107 to add safety docs.",
          },
        ] as any,
      }),
    ).toBe(true)
  })

  test("recognizes concise progress handoff summaries that stop at a step boundary", () => {
    expect(
      SessionPrompt.isAutonomousStopHandoffAssistantTurn({
        finish: "stop",
        parts: [
          {
            type: "text",
            text:
              "Applied `orchestration/src/pipeline.rs:381` `.unwrap()` -> `ok_or_else`. Core edit at `core/src/pipeline.rs:382` not yet applied - step boundary reached before edit tool could fire. Next: edit `core/src/pipeline.rs:382`, run `cargo check`, then clean up `#[allow]` comments.",
          },
        ] as any,
      }),
    ).toBe(true)
  })
})

describe("SessionPrompt.estimatePostTurnCompactionTokens", () => {
  test("includes newly generated assistant output when deciding whether to compact", () => {
    const model = createModel()
    const messages = [
      {
        info: {
          id: messageID("user_latest"),
          sessionID: sessionID("session_prompt_test"),
          role: "user",
          time: { created: 1 },
        },
        parts: [
          {
            id: partID("user_text"),
            sessionID: sessionID("session_prompt_test"),
            messageID: messageID("user_latest"),
            type: "text",
            text: "continue",
            synthetic: false,
          },
        ],
      } as any,
      createAssistantWithLargeOutput("large output ".repeat(1200)),
    ]

    const estimate = SessionPrompt.estimatePostTurnCompactionTokens({
      messages,
      model,
      providerInputTokens: 64,
    })

    expect(estimate).toBeGreaterThan(64)
  })
})

describe("SessionPrompt.loadFinalAssistantMessage", () => {
  test("waits for prune to finish before streaming the final assistant message", async () => {
    let pruneResolved = false
    let resolvePrune: (() => void) | undefined
    const prunePromise = new Promise<void>((resolve) => {
      resolvePrune = () => {
        pruneResolved = true
        resolve()
      }
    })
    let streamStartedBeforePrune = false

    spyOn(SessionCompaction, "prune").mockImplementation(async () => {
      await prunePromise
    })
    spyOn(MessageV2 as any, "stream").mockImplementation(
      (async function* (_sessionID: any) {
        if (!pruneResolved) {
          streamStartedBeforePrune = true
        }
        yield {
          info: {
            id: messageID("user_only"),
            sessionID: sessionID("session_prompt_test"),
            role: "user",
            time: { created: 1 },
          },
          parts: [],
        } as any
        yield createAssistantWithLargeOutput("final answer")
      }) as any,
    )

    const pending = SessionPrompt.loadFinalAssistantMessage(sessionID("session_prompt_test"))
    await Promise.resolve()

    expect(streamStartedBeforePrune).toBe(false)

    resolvePrune?.()
    const item = await pending

    expect(streamStartedBeforePrune).toBe(false)
    expect(item.info.role).toBe("assistant")
  })
})

describe("SessionPrompt.shouldRunAnswerVerification", () => {
  test("skips answer verification inside synthetic reminder loops", () => {
    expect(
      SessionPrompt.shouldRunAnswerVerification({
        intent: { type: "implementation", description: "patch auth", complexity: "simple" },
        syntheticReminderLoop: true,
      }),
    ).toBe(false)
  })

  test("skips answer verification when autonomous continuation is still pending", () => {
    expect(
      SessionPrompt.shouldRunAnswerVerification({
        intent: { type: "implementation", description: "patch auth", complexity: "simple" },
        hasNextRoundTask: true,
      }),
    ).toBe(false)
  })

  test("skips answer verification for implementation turns", () => {
    expect(
      SessionPrompt.shouldRunAnswerVerification({
        intent: { type: "implementation", description: "patch auth", complexity: "simple" },
      }),
    ).toBe(false)
  })

  test("skips answer verification for direct question turns", () => {
    expect(
      SessionPrompt.shouldRunAnswerVerification({
        intent: { type: "exploration", query: "What does this repo do?", mode: "question" },
      }),
    ).toBe(false)
  })

  test("keeps verification enabled for review work", () => {
    expect(
      SessionPrompt.shouldRunAnswerVerification({
        intent: { type: "review", target: "auth module", scope: "code" },
      }),
    ).toBe(true)
  })

  test("skips verification for arithmetic prompts after intent detection", () => {
    expect(
      SessionPrompt.shouldRunAnswerVerification({
        intent: IntentDetection.detect("Calculate 123 + 456. Reply with the number only."),
      }),
    ).toBe(false)
  })
})

describe("SessionPrompt.resolveVerificationIntent", () => {
  test("falls back to detecting intent from the current user input", () => {
    const resolved = SessionPrompt.resolveVerificationIntent({
      userInput: "Calculate 123 + 456. Reply with the number only.",
    })
    expect(resolved?.type).toBe("exploration")
    if (resolved?.type === "exploration") {
      expect(resolved.mode).toBe("question")
    }
  })

  test("prefers the cached intent when it is available", () => {
    const resolved = SessionPrompt.resolveVerificationIntent({
      intent: { type: "implementation", description: "patch auth", complexity: "simple" },
      userInput: "Calculate 123 + 456. Reply with the number only.",
    })
    expect(resolved).toEqual({ type: "implementation", description: "patch auth", complexity: "simple" })
  })
})

describe("SessionPrompt.resolveTurnUserContext", () => {
  test("skips synthetic follow-up user messages when recovering the active turn", () => {
    const resolved = SessionPrompt.resolveTurnUserContext({
      history: [
        {
          info: { id: "user_real", role: "user" },
          parts: [{ type: "text", text: "Calculate 123 + 456. Reply with the number only." }],
        },
        {
          info: { id: "assistant_1", role: "assistant" },
          parts: [{ type: "text", text: "579" }],
        },
        {
          info: { id: "user_synthetic", role: "user" },
          parts: [{ type: "text", text: "Please revise after verification.", synthetic: true }],
        },
      ] as any,
    })

    expect(String(resolved?.userID)).toBe("user_real")
    expect(resolved?.userInput).toBe("Calculate 123 + 456. Reply with the number only.")
  })

  test("filters synthetic reminder parts out of the active user text", () => {
    const resolved = SessionPrompt.resolveTurnUserContext({
      history: [
        {
          info: { id: "user_real", role: "user" },
          parts: [
            { type: "text", text: "123 + 456" },
            { type: "text", text: "Please address this message and continue with your tasks.", synthetic: true },
          ],
        },
      ] as any,
    })

    expect(String(resolved?.userID)).toBe("user_real")
    expect(resolved?.userInput).toBe("123 + 456")
  })

  test("ignores synthetic system-reminder-only follow-ups when recovering the active turn", () => {
    const resolved = SessionPrompt.resolveTurnUserContext({
      history: [
        {
          info: { id: "user_real", role: "user" },
          parts: [{ type: "text", text: "Finish the remaining todos." }],
        },
        {
          info: { id: "assistant_1", role: "assistant" },
          parts: [{ type: "text", text: "I will continue." }],
        },
        {
          info: { id: "user_reminder", role: "user" },
          parts: [{ type: "text", text: "<system-reminder>Pending todo detected.</system-reminder>", synthetic: true }],
        },
      ] as any,
    })

    expect(String(resolved?.userID)).toBe("user_real")
    expect(resolved?.userInput).toBe("Finish the remaining todos.")
  })
})

describe("SessionPrompt.isNoOpUnknownAssistantTurn", () => {
  test("treats internal capability callouts plus step markers as a no-op unknown turn", () => {
    expect(
      SessionPrompt.isNoOpUnknownAssistantTurn({
        finish: "unknown",
        parts: [
          {
            type: "tool",
            tool: "turn_control",
            metadata: { internal: true },
            state: { status: "completed", metadata: { internal: true } },
          },
          {
            type: "tool",
            tool: "self_driven",
            state: { status: "completed", metadata: { internal: true } },
          },
          { type: "step-start" },
          { type: "step-finish" },
        ] as any,
      }),
    ).toBe(true)
  })

  test("does not classify visible assistant text as a no-op unknown turn", () => {
    expect(
      SessionPrompt.isNoOpUnknownAssistantTurn({
        finish: "unknown",
        parts: [{ type: "text", text: "I found the root cause." }] as any,
      }),
    ).toBe(false)
  })

  test("does not classify non-internal tool activity as a no-op unknown turn", () => {
    expect(
      SessionPrompt.isNoOpUnknownAssistantTurn({
        finish: "unknown",
        parts: [
          {
            type: "tool",
            tool: "grep",
            state: { status: "completed", metadata: { internal: false } },
          },
        ] as any,
      }),
    ).toBe(false)
  })
})
