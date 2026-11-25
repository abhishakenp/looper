# Goal: Harness-agnostic looper workflow augmentation

## Problem
Coding harnesses (OpenCode, Codex, Claude Code, T3 Code, Liza agents) each implement subagent orchestration, context augmentation, and model routing differently. Reimplementing per-harness hooks is brittle and loses visibility. We need a transparent process-scope proxy that gives deterministic control over every LLM interaction without harness cooperation, while preserving prompt-cache economics (cache hits are ~10x cheaper).

## Users
- The machine owner running any harness via `looper <harness> [...args]`.
- Agent workflows (pixel, jev, liza, subagent fan-out) that need deterministic augmentation invisible to the LLM.

## MVP scope
- Process-scope capture with pid default + wrapped CLI shims for external subagents (visibility preserved, no recursion).
- Two-channel augmentation: response-only (LLM never knows, cache untouched) and request+response (LLM needs context, prefix hash verified).
- Deterministic detection of subagent tools from the tool description/parameter schema in the request body — no harness name branching.
- Chunk-level SSE tool-call rewriting before the harness executes the call.
- Durable control plane (pi-durable) with atomic 0600 snapshots and cross-process locking.
- User-side extensions symlinked from `examples/` into `~/.looper/extensions`, hot-reloadable.
- Liza compatibility: pairing contract preserved; blackboard driven only through CLI; stage chains deterministic.
- Config layered 7 tiers; cache-safe by default; fail-open on every hook error.

## Out of scope
- Linux/Windows capture validation (later).
- Codex/Claude live quota/auth runs (later; architecture accepted).
- Reimplementing harness TUI or internal supervisor logic.
- Writing directly to Liza's `.liza/state.yaml` (forbidden by contract).

## Success criteria (observable)
- `bun test` passes; `tsc` clean for sdk/core/cli.
- `looper curl -sk https://example.com` returns 577 bytes with zero stdout/stderr.
- Real captured subagent tool calls accumulate and rewrite in-flight (trace shows mutate decision with injected context).
- Provider cache ratio with cache-safe injection keeps cached_tokens unchanged vs baseline; cache-breaking control drops to 0.
- Live hot reload of symlinked extensions into a running looper without restart.
- `liza get tasks --format json` works on the looper workspace.

## Risks / assumptions
- mitmproxy local mode cannot spec a process tree; pid + wrapped shims is the mitigation.
- Response-only injections are echoed by the harness into the next request; looper strips `<looper-ui:*>` before hooks/LLM.
- Some clients ignore HTTP(S)_PROXY; regular mode is opt-in only.
- Credits/quota can block live harness validation; OmniRoute free models are available for protocol proofs.

## Decisions already made
- pid default, wrapped-shim for subagents (user decision).
- Plugins symlinked from examples into ~/.looper/extensions (user decision).
- Real Liza workspace in the looper repo for the plan (user decision).
