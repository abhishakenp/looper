# Architecture plan — looper workflow augmentation

Source: `specs/vision.md`; epic plan `specs/liza/epic-plan.md`.

## A1 — Interception boundary
- `packages/bridge/bridge.py`: mitmdump addon; unix NDJSON to TS core; fail-open; capture via `LOOPER_CAPTURE_BODIES`; robust connect.
- `packages/core/src/bridge-server.ts`: NDJSON correlation, pending-claim drain/fail-open.
- `packages/core/src/hooks.ts`: ordered dispatch, first non-pass wins, per-file disposers, `<looper-ui:*>` strip.

## A2 — Request/response augmentation (two channels)
- `workflows/detect.ts`: SSE `delta.tool_calls` accumulation, cache boundary (`prompt_cache_key`/`cache_control`), prefix hashing.
- `workflows/inject.ts` + `channels.ts`: append after boundary; UI-only tag stripped next request; advisory verification.
- `workflows/toolcall.ts`: chunk-level rewrite before harness executes the tool.

## A3 — Pixel-driven control (no harness branching)
- `workflows/subagent-smart.ts`: Jev classifies tool description+schema → subagent/spawn detection.
- `workflows/tool-driver.ts`: pixel `scope-task`/`plan` → deterministic work packages → harness tool's own shape (`prompt` vs `tasks[]`).
- `workflows/shim.ts`: wrapped CLI shims for external subagents; shared control plane preserves visibility.

## A4 — Deterministic orchestration & durability
- `scheduler.ts`: WorkerScheduler with dependsOn/needs/after, P0/P1, caps, retry, abort grace.
- `wake.ts`: one wake per generation, boundary injection, busy suppression.
- `durable-v2.ts`: pi-durable `createSession`/`defineDoc`/`session.commit`/`tx.doc` + atomic 0600 snapshot + O_EXCL lock.
- `state.ts`/`config.ts`: out-of-tree state, 7-tier layered config.

## A5 — Liza & verification
- `workflows/liza.ts`, `adversarial.ts`, `liza-wrap.ts`: CLI-only blackboard, pairing prefix preserved, stage chains.
- `workflows/ownership.ts`, `verify-gate.ts`: path leases, credential guards, deduped verification.
- CLI `doctor`, trace tail/show, symlinked extensions from `examples/`.

## Interfaces (binding)
- `ExtensionContext`: on, flows, log, state, proc, memo, requestId, hold, effect, config, resources, wake, ownership, verify.
- `Decision`: pass | mutate | respond | drop | stream | buffer | claim.
- Pixel plugin seam: `~/.pixel/plugins/*` (G1–G8 command plugins) + `DecideClient` (`pixel classify --jsonl`).

## Decomposition output (for `architecture-main-pair` → `architecture-pair`)
Entries A1–A5 become architecture child tasks via `liza proceed <task> arch-decompose`, each carrying `arch_ref: specs/liza/architecture-plan.md`.
