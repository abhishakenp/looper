# User stories — looper workflow augmentation

From `specs/liza/epic-plan.md` and `specs/vision.md`.

## S1 — Tool-driven harness control
- **S1.1** As an operator, I attach pixel context to a request so the LLM does not re-read files. **AC:** request body contains `<looper:context>` after cache boundary; prefix hash unchanged.
- **S1.2** As an operator, subagent fan-out is decided by pixel, not LLM whim. **AC:** `pixel scope-task` output → work packages → harness tool args, no name branching.
- **S1.3** As an operator, I see every child session in looper traces. **AC:** 8 real subagent calls with args observed; same-process child headers captured.
- **S1.4** As an operator, external CLI subagents are captured via shims. **AC:** shim 0755, wraps `looper <cli>`, shared control plane.

## S2 — Cache-safe channels
- **S2.1** Machine results visible to human only. **AC:** `<looper-ui:*>` in client response; stripped from next request; LLM prefix intact.
- **S2.2** LLM-visible context appended after boundary. **AC:** prefix hash verified; cached_tokens preserved (704 in live test).
- **S2.3** Hash failure is advisory. **AC:** mutation sent + warning logged.

## S3 — Durable control plane
- **S3.1** pi-durable commits survive restart. **AC:** write/read across two instances; 0600 snapshot.
- **S3.2** Two processes can write without loss. **AC:** 20× each; both ids present.
- **S3.3** Ownership leases prevent overlapping edits. **AC:** lease conflict/release tests pass.
- **S3.4** Verification commands dedupe per checkout. **AC:** gate dedupe + failure receipt tests pass.

## S4 — Liza enforcement
- **S4.1** Pairing contract prefix never rewritten. **AC:** contract symlink active; no mutation of `AGENTS.md` content.
- **S4.2** Blackboard driven CLI-only. **AC:** all writes via `blackboard_op.py`; phase chain observed.
- **S4.3** Stage chains deterministic. **AC:** `stageChain()` for 4 entry points; manual gates listed.
- **S4.4** Adversarial phases advance via helpers. **AC:** DRAFT→CODING recorded; operator-authored verdicts flagged.

## S5 — Config, plugins, verification
- **S5.1** 7-tier config consumed. **AC:** doctor reports layers/scope; no hardcoded behavior.
- **S5.2** Plugins symlinked and hot-reloaded. **AC:** live session reload; fresh process loads all.
- **S5.3** `looper doctor` reports state. **AC:** JSON with capture scope/config/extensions.
- **S5.4** Multi-harness validation. **AC:** OpenCode+hy4, Pi+free model, Liza CLI valid; Claude-haiku deferred (auth).
