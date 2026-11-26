# Coding plan — looper workflow augmentation

Source: `specs/vision.md`; architecture `specs/liza/architecture-plan.md`; epic `specs/liza/epic-plan.md`.

## C1 — Capture & config foundation
Files: `packages/core/src/proc.ts`, `config.ts`, `packages/cli/src/index.ts`, `packages/sdk/src/types.ts`.
Steps: pid default + SIGSTOP/SIGCONT spawn, process groups, readiness signals, CA env, 7-tier config consumption, `looper doctor`.
Validation: `tsc sdk/core/cli`, `bun test`, `looper curl` 577B/0 console.

## C2 — Cache-safe channels
Files: `workflows/detect.ts`, `inject.ts`, `channels.ts`, `hooks.ts`.
Steps: boundary detection, safe append, UI-only strip, advisory hash failure, SSE/JSON response injection.
Validation: baseline cached ratio 0.8627; safe 0.8401 with 704 cached tokens; break control 0.0000.

## C3 — Tool detection, driver & chunk rewrite
Files: `workflows/subagent-smart.ts`, `tool-driver.ts`, `toolcall.ts`, `shim.ts`.
Steps: Jev classify schema, pixel scope→work packages, map to prompt/tasks[], chunk mutate, wrapped shims.
Validation: 8 real subagent calls; T3+Pi schemas both detected; live trace shows `looper_context` in delivered chunk.

## C4 — Scheduler, wake, durable
Files: `scheduler.ts`, `wake.ts`, `durable-v2.ts`, `state.ts`, `memo.ts`, `warm-process.ts`, `route-health.ts`, `decide.ts`.
Steps: WorkerScheduler deps/needs/after/P0/retry; one wake/generation; pi-durable commits + lock; bounded memo; warm classify child.
Validation: 6/6 scheduler tasks settled; restart round-trip; 0600; cross-process lock test.

## C5 — Liza, plugins & final verification
Files: `workflows/liza.ts`, `adversarial.ts`, `liza-wrap.ts`, `ownership.ts`, `verify-gate.ts`; `examples/extensions/*`; `~/.pixel/plugins/*`.
Steps: stage chains + manual gates; blackboard CLI-only; adversarial phases via blackboard_op.py; symlink plugins; G1–G8 pixel plugins; multi-harness validation.
Validation: `liza get tasks --format json` (6 tasks), `liza validate` ok, blackboard at CODING, OpenCode+Pi+Liza+Claude-haiku proof, 55 tests.

## Decomposition output (for `code-planning-main-pair` → `code-planning-pair`)
Entries C1–C5 become coding child tasks via `liza proceed <task> code-plan-decompose`, each with:
- `plan_ref: specs/liza/code-plan.md` (decomposition-output-ref)
- `rca_required: false` (explicit on every master output)
- `files`/`scope`, `validation`, `depends_on` indexes.
Then `liza proceed <task> code-plan-to-coding` (manual gate) creates `coding-pair` children.
