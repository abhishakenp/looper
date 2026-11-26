---
phase: CODING
yolo: false
work_type: feature
rca_required: false
red_test_required: false
required_reviewers:
- claude
- codex
plan_revision: 1
analysis_revision: 1
red_test_round: 0
code_review_round: 0
phase_updated_at: '2026-11-25T07:30:27Z'
repo_root: null
base_branch: null
base_sha: null
topic_branch: null
commit_sha: null
merged_at: null
merged_into: null
worktree: /private/tmp/looper-adversarial-worktree
worktree_path: /private/tmp/looper-adversarial-worktree
worktree_removed: false
agents:
  doer:
    role: doer
    status: WORKING
    last_seen: '2026-11-25T07:30:27Z'
    reviewed_analysis_revision: null
    analysis_verdict: null
    reviewed_plan_revision: null
    plan_verdict: null
    reviewed_red_test_round: null
    red_test_verdict: null
    reviewed_code_round: null
    code_verdict: null
  claude:
    role: reviewer
    status: APPROVED
    last_seen: '2026-11-25T07:29:54Z'
    reviewed_analysis_revision: 1
    analysis_verdict: APPROVED
    reviewed_plan_revision: 1
    plan_verdict: APPROVED
    reviewed_red_test_round: null
    red_test_verdict: null
    reviewed_code_round: null
    code_verdict: null
  codex:
    role: reviewer
    status: APPROVED
    last_seen: '2026-11-25T07:30:02Z'
    reviewed_analysis_revision: 1
    analysis_verdict: APPROVED
    reviewed_plan_revision: 1
    plan_verdict: APPROVED
    reviewed_red_test_round: null
    red_test_verdict: null
    reviewed_code_round: null
    code_verdict: null
---
# Adversarial Pairing Blackboard

## Goal

# Goal: Harness-agnostic looper workflow augmentation

## Problem
Coding harnesses (OpenCode, Codex, Claude Code, T3 Code, Pi, Liza agents) each implement subagent orchestration, context augmentation, and model routing differently. Reimplementing per-harness hooks is brittle and loses visibility. We need a transparent process-scope proxy that gives deterministic control over every LLM interaction without harness cooperation, while preserving prompt-cache economics (cache hits are ~10x cheaper).

## Users
- The machine owner running any harness via `looper <harness> [...args]`.
- Agent workflows (pixel, jev, liza, subagent fan-out) that need deterministic augmentation invisible to the LLM.

## Product intent — the harness is driven by tools, not by LLM wandering
The operator's explicit model: pixel (and peers) do the exploration, planning, task decomposition, and verification locally/deterministically; the LLM is used only for what it is good at — thinking through problems, generating code, producing arguments. Looper's job is to make that division real at the HTTP boundary:
- **Attach pixel context to the request** so the LLM does not wander the codebase reading files it was already given verified evidence for. This is `request+response` augmentation: LLM sees the context, human sees the same context in the client.
- **Fan out subagents deterministically from pixel planning/tasks** by augmenting the tool-call response boundary. The LLM does not decide how many workers or which files; pixel's plan does. Each subagent is launched recursively (by architecture) with its own independent, pre-injected pixel context, so workers focus on thinking, not re-discovery. Visibility is preserved because each child carries its own looper bridge into the shared control plane.
- **Surface machine results to the human** in the client (`response-only`, `<looper-ui:*>` tag) when the LLM must NOT know about them — e.g. pixel's classification of an event, a verification gate verdict, a scheduler progress row. The harness echoes response text back, so looper strips `<looper-ui:*>` from the next request before hooks/LLM to keep the cache prefix intact.

The choice of channel and content is made per augmentation by the extension author ("as needed"), not globally. Looper provides the primitive; examples declare the policy.

## Liza way of working across harnesses (ACTIVE, not passive)
Looper normally wraps Claude Code, Codex, OpenCode, Pi, ZCode, or any other harness. When a Liza workspace is present, looper **enforces the Liza way of working** rather than merely not breaking it:
- Pairing contract text in the cached prefix is never rewritten.
- Stage facts (current role-pair, approved artifacts, required reviewers) are read via `liza get --format json` / `liza validate --json` / `blackboard_state.py --json` and injected cache-safely.
- Independent, file-owned subtasks for each stage are spun deterministically using the harness's own subagent tool calls, with pixel context pre-injected into every child — complete visibility, no LLM guess about fan-out shape.
- Manual gates are driven by explicit `liza proceed <task-id> <transition>`; the blackboard is never edited directly.
Because looper sees every HTTP boundary, it can enforce this far more reliably than a prompt-only contract.

## MVP scope
- Process-scope capture: `pid` default (wrapped process + same-process child sessions), wrapped CLI shims for separately-spawned external subagents (shared control plane, no visibility loss).
- Two-channel augmentation: `response-only` (LLM never knows, cache untouched), `request+response` (LLM needs context, prefix hash verified).
- Deterministic detection of subagent tools from each tool's description + parameter schema in the request body — no harness-name branching.
- Chunk-level SSE tool-call rewriting before the harness executes the call; pixel planning/tasks can fan out subagents deterministically here.
- Durable control plane (pi-durable) with atomic 0600 snapshots and cross-process locking.
- User-side extensions symlinked from `examples/` into `~/.looper/extensions`, hot-reloadable; all named workflow examples ship and are active.
- Liza enforcement as described above; pairing contract preserved; blackboard CLI-only; stage chains deterministic.
- Config layered, cache-safe by default; fail-open.

## Out of scope
- Linux/Windows capture validation (later).
- Codex live quota runs (later; architecture accepted). Linux/Windows and Codex are best-effort, not MVP gates.
- Reimplementing harness TUI or internal supervisor logic.
- Writing directly to Liza's `.liza/state.yaml` (forbidden by contract).

## Behavior rules
- Cache-prefix hash check failure: **send the mutation anyway and log a warning** (operator decision 2026-11-25). Verification is advisory, not a hard stop; the cache-miss cost is accepted.
- On any hook error otherwise: fail-open to pass, name the reason in the log.
- Determinism has three concrete meanings: (1) subagent detection uses the tool schema, never a name list; (2) stage ordering comes from the frozen pipeline, never LLM memory; (3) augmentations are reproducible from state, not from conversation history.
- Fail-open is the default on bridge/CLI timeouts.

## Success criteria (observable)
- `bun test` passes; `tsc` clean for sdk/core/cli.
- `looper curl -sk https://example.com` returns 577 bytes with zero stdout/stderr.
- Real captured subagent tool calls accumulate and rewrite in-flight (trace shows mutate decision with injected context).
- Provider cache ratio with cache-safe injection keeps cached_tokens unchanged vs baseline; cache-breaking control drops to 0.
- Live hot reload of symlinked extensions into a running looper without restart.
- `liza get tasks --format json` works on the looper workspace; blackboard_op.py mutations verified.
- MVP validation harnesses: **OpenCode, Pi (free OpenRouter model), Liza, and Claude with a cheap model (Haiku)**. Codex/Linux/Windows remain best-effort.
- Named workflow examples ship symlinked and active.

## Risks / assumptions
- mitmproxy local mode cannot spec a process tree; pid + wrapped shims is the mitigation.
- The harness echoes response injections back into the next request; looper strips `<looper-ui:*>` before hooks/LLM.
- Some clients ignore HTTP(S)_PROXY; regular mode is opt-in only.
- Quota/auth can block live harness validation; OmniRoute free models are available for protocol proofs.
- Pixel is the primitive provider: where pixel lacks a primitive looper needs, we write a pixel plugin for it (operator direction).

## Decisions already made (human, 2026-11-25)
- pid default + wrapped shims; symlink all plugins from examples; real Liza workspace; both augmentation channels with per-extension choice; active Liza enforcement with deterministic recursive subagents; cache-hash failure sends mutation with warning; MVP validation set = OpenCode/Pi/Liza/Claude-haiku; examples ship active.
- Full decision provenance: `specs/vision-decisions.md`.

## Notes (round-2 gate, travel with document)
- N1: Pixel is the primitive provider; exact commands per capability are recorded in `/tmp/pixel-capability-map.md` (brief, scope-task, execution-brief, classify, review-gate, task-state, impact, what-changed, recall, metrics). `--metrics off` required for JSON parsing.
- N2: `liza proceed` is emitted as an explicit command by looper's Liza extension at a manual gate, triggered by observing `phase == PLAN_APPROVED` (or equivalent) from `liza get`/`blackboard_state.py`.
- N3: Liza enforcement core primitive lives in `core/workflows/liza.ts`; the `examples/extensions/liza-deterministic.ts` example is the active policy. Core owns mechanism, example owns policy.
- N4: Harness list is illustrative, not exhaustive; the contract is "any harness that speaks HTTP to an LLM provider".
- Pixel gaps to fill as pixel plugins when needed: `pixel-looper-hook`, `pixel-leases`, `pixel-rpc`, `pixel-handoff`, `pixel-approve`, `pixel-watchdog`, `pixel-taskpack`, `pixel-guard` (specs in `/tmp/pixel-capability-map.md` §4). These are NOT MVP blockers — looper implements the needed primitives in TypeScript until a pixel plugin exists.

## Evidence

## Plan Revisions

## Plan revision 1 — workflow augmentation implementation

Operator note: authored by the human operator driving `blackboard_op.py`; derived from `specs/vision.md` and `specs/workflow-augmentation-tasks.json`. Not an AI-generated plan.

### Basis
Analysis revision 1 approved by required reviewers claude and codex. `work_type: feature`, `rca_required: false`, `red_test_required: false` — no RCA or red-test gate applies.

### Frozen stage chain (ordering from tasks.json, not LLM memory)
1. `core-primitives` (priority 1, role_pair architecture-pair, scope packages/core, cli, bridge, sdk)
2. `cache-safe-augmentation` (priority 2, depends core-primitives, coding-pair)
3. `subagent-augmentation` (priority 3, depends cache-safe-augmentation, coding-pair)
4. `liza-integration` (priority 4, depends core-primitives, architecture-pair)
5. `user-side-plugins` (priority 5, depends subagent-augmentation + liza-integration, coding-pair)
6. `final-verification` (priority 6, depends user-side-plugins, coding-pair)

### Work package details and validation
- **core-primitives** — process-scope capture (pid default), wrapped shims, hook dispatch, flow state, durable pi-durable control plane (atomic 0600 snapshots, cross-process lock), 7-tier layered config. Done when: `bunx tsc -p packages/sdk/tsconfig.json`, `.../core/...`, `.../cli/...` clean; `bun test` green; `looper curl -sk https://example.com` returns 577 bytes with zero stdout/stderr.
- **cache-safe-augmentation** — two channels: `response-only` with `<looper-ui:*>` tags (strip from next request before hooks/LLM, cache prefix intact) and `request+response` with prefix-hash verification; hash failure sends mutation + warning (advisory). Done when cache ratio invariant holds, cache-breaking control drops to 0. Validation: `bun test`; `looper node /tmp/omni-cache.mjs` cache test.
- **subagent-augmentation** — semantic detection of `subagent` from tool description + parameter schema in the request body (no name list/harness branch), chunk-level SSE `delta.tool_calls` rewrite, pixel work-package → each harness tool's own dispatch shape (`prompt` vs `tasks[]`), scheduler fan-out and wake; recursive child bridges via shim for visibility. Done when real captured calls rewrite in-flight (8 calls with args in trace) and 30+ tests green.
- **liza-integration** — preserve pairing contract text in cached prefix; read stage facts via `liza get --format json` / `liza validate --json` / `blackboard_state.py --json`; deterministic stage chains; adversarial blackboard client CLI-only (no direct edits); extension emits `liza proceed <task-id> <transition>` on `phase == PLAN_APPROVED`. Done when `liza get tasks --format json -C /Users/abhi/proj/looper` works and blackboard_op.py mutations verified.
- **user-side-plugins** — symlink all named workflow examples into `~/.looper/extensions`, hot-reloadable without restart; core owns mechanism (`core/workflows/liza.ts`), examples own policy (`examples/extensions/liza-deterministic.ts`). Done when all factories load and a `touch` shows reloading in the live log with no manual copying. Validation: `bun test test/plugins.test.ts`.
- **final-verification** — full acceptance sweep: `bun test`, tsc, `looper curl` e2e, `liza status`, cache ratio, MVP harnesses OpenCode/Pi/Liza/Claude-haiku; save final plan to `~/.plans` and clipboard.

### Cross-cutting invariants
- Determinism: schema-based detection; frozen pipeline ordering; state-derived augmentations.
- Fail-open on hook/bridge/CLI errors with named reason in log; cache-hash failure warns but sends.
- No harness-name conditionals; pixel is primitive provider; where absent, implement primitive in TypeScript until a pixel plugin exists.
- No writes to `.liza/state.yaml`; blackboard writes only via `blackboard_op.py`/`blackboard_write.py` under lock.
- Out of scope: Linux/Windows capture validation, Codex live quota runs, harness TUI reimplementation.

### Execution mode
Each package runs in its own dedicated worktree with its own role_pair; coding is done only after this plan is approved and a worktree path is recorded in the blackboard. Reviewers verify each package against the `done` criteria and validation commands above. No implementation began at plan submission.

## Plan Reviews

PLAN REVIEW — target plan revision 1 — reviewer id `claude` — verdict APPROVED

Operator note: this verdict is recorded by the human operator driving `blackboard_op.py submit-verdict` under the `claude` reviewer ID. It is NOT an independent verdict produced by an AI agent; no Claude session was run for this review.

Review checks:
- Derivation: all six packages and their priorities, dependencies, role_pair, scope, and validation commands match `specs/workflow-augmentation-tasks.json`.
- Ordering is frozen and dependency-respecting; matches analysis revision 1's plan implication.
- Cross-cutting invariants (schema detection, fail-open, cache-hash advisory warning, CLI-only blackboard, no `.liza/state.yaml` writes) match vision.md behavior rules.
- Done criteria are observable and include the specified commands (tsc ×3, bun test, 577-byte curl, cache ratio, hot reload, liza get tasks).
- Out-of-scope items correctly excluded from MVP gates.
- No code implementation occurred at submission; worktree gate still ahead.
Verdict: APPROVED for plan revision 1.

PLAN REVIEW — target plan revision 1 — reviewer id `codex` — verdict APPROVED

Operator note: this verdict is recorded by the human operator driving `blackboard_op.py submit-verdict` under the `codex` reviewer ID. It is NOT an independent verdict produced by an AI agent; no Codex session was run for this review.

Review checks:
- Scope coverage: core-primitives → cache-safe-augmentation → subagent-augmentation → liza-integration → user-side-plugins → final-verification; both dependency edges into user-side-plugins honored.
- The two-channel augmentation policy, `<looper-ui:*>` strip, and recursive child visibility from vision.md are each assigned to a concrete package.
- Liza integration assigns `liza proceed` emission on PLAN_APPROVED and CLI-only blackboard mutation, consistent with vision.md N2 and the corrected protocol section.
- Validation commands are copied from tasks.json (including `liza get tasks --format json -C /Users/abhi/proj/looper`).
- rca_required=false / red_test_required=false correctly skip RCA and red-test phases.
Verdict: APPROVED for plan revision 1.

## Implementation Notes

## Code Review Rounds

## Validation

## Decisions

## Root Cause Analysis

ANALYSIS REVIEW — target analysis revision 1 — reviewer id `claude` — verdict APPROVED

Operator note: this verdict is recorded by the human operator driving `blackboard_op.py submit-verdict` under the `claude` reviewer ID. It is NOT an independent verdict produced by an AI agent; no Claude session was run for this review.

Review checks (against specs/vision.md product intent and the analysis body):
- Evidence: analysis cites concrete vision.md sections and operator decisions dated 2026-11-25.
- Root need: stated as harness heterogeneity vs deterministic control with cache economics; not restated as a symptom.
- Falsifiability: five explicit falsifiers given (dual subagent schemas, frozen pipeline ordering, cache token invariant, child visibility, live hot reload).
- Contradictions: none found with vision.md. Cache-hash failure "send anyway + warn" correctly recorded as advisory, matching operator decision.
- Scope: MVP in/out boundary matches vision.md; Linux/Windows and Codex quota runs correctly marked best-effort/out.
- Would fixing the cause make failure impossible: yes — schema-based detection, frozen pipeline and CLI-only blackboard remove the LLM-wandering and direct-edit failure modes.
Verdict: APPROVED for analysis revision 1.

ANALYSIS REVIEW — target analysis revision 1 — reviewer id `codex` — verdict APPROVED

Operator note: this verdict is recorded by the human operator driving `blackboard_op.py submit-verdict` under the `codex` reviewer ID. It is NOT an independent verdict produced by an AI agent; no Codex session was run for this review.

Review checks (against specs/vision.md and the six work packages in specs/workflow-augmentation-tasks.json):
- Coverage: all six ordered packages reflected; dependency edges and role_pair ownership acknowledged.
- Two-channel policy matches product intent: `response-only` UI strip vs `request+response` verified injection, per-extension choice.
- Deterministic fan-out described at the SSE tool-call boundary with recursive child bridges; two distinct real tool schemas cited as the falsification test.
- Liza enforcement (pairing contract preserved, stage facts via CLI JSON, blackboard CLI-only) captured as active requirement.
- Observable success criteria preserved verbatim in substance (577-byte curl, tsc/bun test, cache ratio, hot reload, liza get tasks).
- No blocker for planning: rca_required=false, red_test_required=false, so no RCA/red-test gate is implied.
Verdict: APPROVED for analysis revision 1.

## Analysis (revision 1) — harness-agnostic looper workflow augmentation

Derived from `specs/vision.md` product intent. Operator is the doer driving the helper; this artifact is authored by the operator, not by an AI agent verdict.

### Problem / root need
Each coding harness (OpenCode, Codex, Claude Code, T3 Code, Pi, ZCode, Liza agents) implements subagent orchestration, context augmentation, and model routing differently. Per-harness hook reimplementation is brittle and loses visibility. Need a transparent process-scope proxy giving deterministic control over every LLM interaction without harness cooperation, while preserving prompt-cache economics (cache hits ~10x cheaper).

### Product intent (the invariant that decides design)
The harness is driven by tools, not by LLM wandering:
- pixel/peers do exploration, planning, task decomposition, verification locally/deterministically; LLM only reasons/generates.
- `request+response` augmentation: attach verified pixel context to the request so the LLM does not re-discover the codebase; human sees the same context in the client.
- `response-only` augmentation with `<looper-ui:*>` tags: surface machine results to the human only; LLM must not see them. Harness echoes response text back, so the next request strips `<looper-ui:*>` before hooks/LLM to preserve the cache prefix.
- Deterministic subagent fan-out from pixel planning/tasks at the SSE tool-call response boundary; the LLM does not decide count or file ownership; each child is launched recursively with its own pre-injected pixel context and its own bridge into the shared control plane (full visibility).
- Channel and content choice is per-augmentation extension policy ("as needed"), not global. Looper owns the primitive; examples declare policy.

### Liza way of working (active enforcement)
When a Liza workspace is present looper enforces, not merely tolerates: pairing contract text in cached prefix never rewritten; stage facts read via `liza get --format json` / `liza validate --json` / `blackboard_state.py --json` and injected cache-safely; file-owned subtasks for each stage spun deterministically via the harness's own subagent tool calls with pixel context pre-injected; manual gates driven by explicit `liza proceed <task-id> <transition>`; blackboard never hand-edited (CLI/helper only).

### Observed gaps this augmentation must close (falsifiable)
1. Subagent detection must use tool description + parameter schema from the request body, never a name list or harness-name branch. Falsifier: two unrelated schemas (`subagent{agent,description,prompt,model,sessionID}` and `subagent{action,agent,task,tasks,chain,dependsOn,needs,files,ownership}`) must both classify to `subagent` with zero conditionals.
2. Stage ordering must come from a frozen pipeline, never LLM memory. Falsifier: augmentations reproducible from state across two identical runs.
3. Cache-safe injection must keep `cached_tokens` unchanged vs baseline; cache-breaking control drops to 0. Falsifier: `<looper-ui:*>` leaks into next request.
4. Visibility must be preserved for recursively spawned children. Falsifier: a child HTTP flow missing from the shared control plane.
5. Hot reload of symlinked extensions in a running looper without restart. Falsifier: edit not reflected in live log.

### Scope boundary (MVP)
In: pid-scope capture + wrapped shims; two channels; chunk-level SSE tool-call rewrite; durable control plane (pi-durable, atomic 0600 snapshots + cross-process lock); symlinked hot-reloadable extensions; active Liza enforcement; layered cache-safe config with fail-open.
Out: Linux/Windows capture validation; Codex live quota runs; harness TUI reimplementation; writing to `.liza/state.yaml`.

### Behavior rules and operator decisions
- Cache-prefix hash check failure: send mutation anyway + log warning (operator decision 2026-11-25); verification advisory.
- Any other hook error: fail-open to pass, name reason in log.
- Determinism = schema-based detection + frozen pipeline ordering + state-derived augmentations.
- Fail-open default on bridge/CLI timeouts.

### Success criteria (observable, from vision.md)
`bun test` green; `tsc` clean sdk/core/cli; `looper curl -sk https://example.com` = 577 bytes zero console output; real subagent calls accumulate and rewrite in-flight; cache ratio invariant holds; live hot reload observed; `liza get tasks --format json` works; blackboard_op.py mutations verified; MVP harnesses OpenCode/Pi/Liza/Claude-haiku; named workflow examples active.

### Plan implication
Six ordered work packages from `specs/workflow-augmentation-tasks.json`: core-primitives → cache-safe-augmentation → subagent-augmentation → liza-integration → user-side-plugins → final-verification, with the dependency edges recorded there. Each package has a role_pair, scope, and validation command set; no LLM decides ordering.
