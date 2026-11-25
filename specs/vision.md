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



## Liza protocol usage (corrected 2026-11-25)
- **Pairing mode** = contract loaded into any harness session (Claude/Codex/OpenCode/Pi/ZCode/T3). No Liza CLI/TUI required for ordinary pairing. Activated by `liza init --opencode` (contract symlink `AGENTS.md → ~/.liza/CORE.md`); note the global `~/.config/opencode/AGENTS.md` is non-Liza and retained.
- **Adversarial pairing** = doer + reviewers in harness panes sharing a Markdown blackboard, driven by `/adversarial-pairing <role> <path>` inside the harness; helpers `blackboard_state.py`/`blackboard_op.py` own frontmatter under a lock. Liza CLI/TUI is NOT required for the sessions themselves; `liza launch wezterm|cmux adversarial-pairing` is optional pane-spawning convenience. This is the right vehicle for looper's workflow: deterministic stage gates, independent reviewers, no full MAS supervisor.
- **Full MAS** (`liza agent`, `state.yaml`, `liza get/validate/proceed`) is a separate mode. Used here only to track the plan tasks in `~/.liza/` workspace; it is NOT the workflow protocol for harness sessions. The earlier `liza agent orchestrator` attempt was wrong-mode and is stopped.
- Active workspace: `.liza/adversarial/looper-workflow-augmentation.md` (created via `blackboard_op.py create`, phase DRAFT), plus MAS tasks in `.liza/state.yaml` for plan tracking. The two are distinct: adversarial for execution protocol, MAS for backlog.

## Notes (round-2 gate, travel with document)
- N1: Pixel is the primitive provider; exact commands per capability are recorded in `/tmp/pixel-capability-map.md` (brief, scope-task, execution-brief, classify, review-gate, task-state, impact, what-changed, recall, metrics). `--metrics off` required for JSON parsing.
- N2: `liza proceed` is emitted as an explicit command by looper's Liza extension at a manual gate, triggered by observing `phase == PLAN_APPROVED` (or equivalent) from `liza get`/`blackboard_state.py`.
- N3: Liza enforcement core primitive lives in `core/workflows/liza.ts`; the `examples/extensions/liza-deterministic.ts` example is the active policy. Core owns mechanism, example owns policy.
- N4: Harness list is illustrative, not exhaustive; the contract is "any harness that speaks HTTP to an LLM provider".
- Pixel gaps to fill as pixel plugins when needed: `pixel-looper-hook`, `pixel-leases`, `pixel-rpc`, `pixel-handoff`, `pixel-approve`, `pixel-watchdog`, `pixel-taskpack`, `pixel-guard` (specs in `/tmp/pixel-capability-map.md` §4). These are NOT MVP blockers — looper implements the needed primitives in TypeScript until a pixel plugin exists.

## Pixel-driven harness control (2026-11-25 addendum)
The operator's explicit target architecture: **LLM does only what cannot be done deterministically; pixel and peers drive the harness.** Subagent spinning must be driven by pixel's planning/task decomposition, using the harness's OWN subagent tool call (so visibility through looper is complete), with zero harness-specific conditionals:

- `core/workflows/subagent-smart.ts` — Jev/pixel classifies a tool's **description + parameter schema** from the request body; no name list, no branching. Verified on two very different real schemas: T3/OpenCode `subagent{agent,description,prompt,model,sessionID}` and Pi/pi-ultimate `subagent{action,agent,task,tasks,chain,dependsOn,needs,files,ownership}` — both resolved to `subagent` via semantics.
- `core/workflows/tool-driver.ts` — `workPackagesFromPixel()` turns `pixel scope-task`/`pixel plan` output into deterministic file-owned work packages; `buildAugmentations()` maps them onto each harness tool's own dispatch shape (T3 → `prompt` string, Pi → `tasks[]`). Verified: same pixel output produced `prompt` vs `tasks[]` automatically from the schema.
- Visibility: the harness executes its own tool call; looper sees the request, the SSE `delta.tool_calls`, the rewritten chunk, and every child HTTP flow through the shared control plane. 8 real native subagent calls with full args confirmed in trace.
- Recursive-by-architecture: each subagent is launched through a wrapped shim / shared control plane (pid scope + `core/workflows/shim.ts`), so it carries pixel context into its own fresh conversation and focuses on thinking, not rediscovery.
- LLM is called only for: reasoning/generation inside the harness and the tiny `pixel classify --jsonl` decision questions. Exploration, planning, tasking, file selection, verification, routing are pixel/local/deterministic.

This is the design; per-harness tool schemas differ but the control logic does not — it reads the schema and lets pixel decide.
