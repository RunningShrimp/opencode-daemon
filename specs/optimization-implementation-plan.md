# Optimization Implementation Plan

Date: 2026-03-13

## Goal

Close the gap between recent optimization commits and actual runtime effect.
The plan focuses on three tracks:

1. Performance
2. Agent enhancements
3. Interaction and TUI reliability

## Current Assessment

### Confirmed Effective

- Self-driven agent is wired into the session loop in `packages/opencode/src/session/prompt.ts`.
- Thinking variants are active for reasoning-capable models through `packages/opencode/src/provider/transform.ts`.
- TUI internal transport and slash command compatibility are active through:
  - `packages/opencode/src/cli/cmd/tui/worker.ts`
  - `packages/opencode/src/cli/cmd/tui/thread.ts`
  - `packages/opencode/src/cli/cmd/tui/app.tsx`
- Provider chunk timeout increase is active in `packages/opencode/src/provider/provider.ts`.
- Plugin config injection is active in `packages/opencode/src/plugin/index.ts`.

### Present But Not Yet Effective

- `packages/opencode/src/cli/cmd/tui/component/prompt/use-prompt-state.ts`
  exists but is not consumed by any runtime path.
- `packages/opencode/src/util/dynamic-turn-control.ts`
  exists and is tested, but is not referenced by `packages/opencode/src/session/**`.
- `packages/opencode/src/util/compaction-predictor.ts`
  exists and is tested, but is not referenced by `packages/opencode/src/session/**`.

### Partially Verified

- App terminal fixes for jank, focus, and state corruption have recent code changes and limited test coverage.
- Packaged TUI regression has been validated with MiniMax-M2.5, but cross-model and app-side interaction coverage is still incomplete.

## Implementation Strategy

### Phase 1: Activate Dormant Optimizations

#### 1. Wire prompt state management into the TUI prompt

Target files:

- `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx`
- `packages/opencode/src/cli/cmd/tui/component/prompt/use-prompt-state.ts`

Work:

- Replace duplicated local prompt state with `usePromptState`.
- Ensure normal mode, shell mode, placeholder rotation, interrupt state, and extmark mapping all flow through one hook.
- Add regression coverage for prompt state transitions.

Acceptance criteria:

- `usePromptState` has at least one runtime consumer.
- Prompt behavior remains unchanged for existing flows.
- Prompt-related tests pass.

#### 2. Integrate dynamic turn control into the session loop

Target files:

- `packages/opencode/src/session/prompt.ts`
- `packages/opencode/src/session/processor.ts`
- `packages/opencode/src/util/dynamic-turn-control.ts`

Work:

- Create per-session controller lifecycle.
- Initialize controller from task complexity or message characteristics.
- Record turn outcomes and token usage after each step.
- Use controller decisions to stop low-value continuation or cap runaway loops.

Acceptance criteria:

- `DynamicTurnController` is referenced from `packages/opencode/src/session/**`.
- Loop exit behavior is deterministic and tested.
- Existing session behavior is preserved for simple prompts.

#### 3. Integrate compaction prediction before overflow paths

Target files:

- `packages/opencode/src/session/compaction.ts`
- `packages/opencode/src/session/prompt.ts`
- `packages/opencode/src/session/processor.ts`
- `packages/opencode/src/util/compaction-predictor.ts`

Work:

- Feed predictor with session token growth and compaction history.
- Trigger preemptive compaction before hard overflow where confidence is high.
- Keep fallback to existing overflow logic.

Acceptance criteria:

- `CompactionPredictor` is referenced from `packages/opencode/src/session/**`.
- Existing overflow behavior still works when prediction is disabled or uncertain.
- New tests cover predictive compaction behavior.

### Phase 2: Strengthen Validation for Interaction and Performance

#### 4. Expand app-side terminal interaction coverage

Target files:

- `packages/app/src/pages/session/terminal-panel.tsx`
- `packages/app/src/context/terminal.tsx`
- `packages/app/src/pages/session/helpers.ts`
- `packages/app/src/pages/session/terminal-panel.test.ts`

Work:

- Add tests for auto-create behavior when the panel opens.
- Add tests for focus handoff and refocus after drag/open events.
- Add tests for viewport resize handling.
- Validate terminal cleanup and cache trimming behavior.

Acceptance criteria:

- Terminal panel tests cover focus, auto-create, and close-on-empty behavior.
- Existing terminal context tests continue to pass.

#### 5. Add TUI regression matrix for model and slash-command behavior

Target files:

- `script/tui-validate-tmux.sh`
- `script/export-tui-text-proof.sh`
- optional test additions under `packages/opencode/src/__tests__/`

Work:

- Keep MiniMax-M2.5 regression as baseline.
- Add a second model regression using GLM-5.
- Validate `/session`, `/sessions`, prompt submission, and thinking visibility.
- Ensure ANSI stripping and timeout rules remain model-specific and stable.

Acceptance criteria:

- Both MiniMax-M2.5 and GLM-5 regressions pass.
- Slash-command compatibility remains stable.

### Phase 3: Cleanup and Hardening

#### 6. Clean unsafe or noisy artifacts from optimization-related commits

Target files:

- repository root and `packages/opencode/.opencode/**`
- docs or specs updated as needed

Work:

- Remove accidental generated data and unrelated artifacts from tracked history going forward.
- Keep optimization notes in docs/specs instead of committing runtime cache data.
- Document final wiring decisions.

Acceptance criteria:

- No runtime cache or local artifact files are introduced by optimization work.
- Validation scripts stay in `script/` and are intentional.

## Validation Commands

### Opencode package

```bash
cd packages/opencode
bun test test/thinking-markers-verification.test.ts src/__tests__/tui-prompt-async.test.ts test/provider/provider.test.ts --timeout 120000
```

### App package

```bash
cd packages/app
bun test --preload ./happydom.ts ./src/context/terminal.test.ts --timeout 120000
bun test --preload ./happydom.ts ./src/pages/session/terminal-panel.test.ts --timeout 120000
```

### TUI regression

```bash
MODEL=minimax-cn-coding-plan/MiniMax-M2.5 script/tui-validate-tmux.sh
MODEL=zhipuai-coding-plan/glm-5 script/tui-validate-tmux.sh
```

## Todo List

- [x] Wire `usePromptState` into `packages/opencode/src/cli/cmd/tui/component/prompt/index.tsx`.
- [x] Add prompt state regression tests for mode switch, reset, interrupt, and placeholder changes.
- [x] Integrate `DynamicTurnController` into `packages/opencode/src/session/prompt.ts`.
- [x] Record turn outcomes and token usage from session processing.
- [x] Integrate `CompactionPredictor` into compaction decision paths.
- [x] Add tests for predictive compaction and controller-driven loop exit.
- [x] Extend `packages/app/src/pages/session/terminal-panel.test.ts` beyond label-only coverage.
- [x] Add app-side tests for focus recovery, auto-create, and resize behavior.
- [x] Run packaged TUI regression for MiniMax-M2.5 and GLM-5.
- [x] Review optimization-related changes to avoid committing runtime artifacts.
- [x] Update docs/specs after wiring is complete.

## Recommended Execution Order

1. Wire `usePromptState`.
2. Wire `DynamicTurnController`.
3. Wire `CompactionPredictor`.
4. Expand app terminal interaction tests.
5. Run dual-model packaged TUI regressions.
6. Clean up artifacts and finalize docs.
