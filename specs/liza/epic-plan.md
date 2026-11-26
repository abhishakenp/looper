# Epic plan — looper workflow augmentation

Source: `specs/vision.md` (goal, general-objective entry point).

## E1 — Tool-driven harness control
**Outcome:** pixel and deterministic tools drive the harness; LLM used only for thinking/generation.
**Stories:** S1.1 context injection, S1.2 deterministic subagent fan-out via harness tool calls, S1.3 full looper visibility of child sessions, S1.4 wrapped shims for external CLI subagents.
**Scope:** packages/core/src/workflows/{subagent-smart,tool-driver,shim,toolcall}.ts, examples/extensions/subagent-augmentation.ts.

## E2 — Cache-safe two-channel augmentation
**Outcome:** machine results visible to human only; LLM-visible context injected after cache boundary; cache cost preserved.
**Stories:** S2.1 response-only `<looper-ui:*>` + automatic strip, S2.2 request+response with prefix-hash verification, S2.3 advisory hash-failure (send + warn).
**Scope:** packages/core/src/workflows/{channels,inject,detect}.ts, packages/core/src/hooks.ts.

## E3 — Durable control plane & deterministic gates
**Outcome:** crash-reconciled state, atomic 0600, cross-process locking, ownership/verification gates.
**Stories:** S3.1 pi-durable v2 commits, S3.2 file lock+merge, S3.3 ownership leases, S3.4 verification gate.
**Scope:** packages/core/src/{durable-v2,state}.ts, workflows/{ownership,verify-gate}.ts.

## E4 — Liza enforcement across harnesses
**Outcome:** pairing contract preserved; blackboard CLI-only; deterministic recursive subagents with pixel context; stage chains.
**Stories:** S4.1 provider CLI wrap, S4.2 adversarial blackboard client, S4.3 stage gates/fail-open, S4.4 manual `liza proceed`.
**Scope:** packages/core/src/workflows/{liza,adversarial,liza-wrap}.ts, examples/extensions/liza-deterministic.ts.

## E5 — Config, plugins & verification
**Outcome:** layered config, symlinked plugins, observable via `looper doctor`, all acceptance criteria proven.
**Stories:** S5.1 7-tier config, S5.2 symlink activation/hot reload, S5.3 doctor, S5.4 multi-harness validation (OpenCode/Pi/Liza/Claude-haiku).
**Scope:** packages/cli/src/index.ts, examples/extensions, specs, ~/.looper/extensions.

## Decomposition output (for `epic-planning-main-pair` → `epic-planning-pair`)
Each epic becomes one child task via `liza proceed <task> epic-decompose`, with `output[]` entries carrying: id, text, files/scope, validation, and `plan_ref: specs/liza/epic-plan.md` (decomposition-output-ref for epic-master).
