# Decision record — specs/vision.md

Altitude: `general-objective` · Phase: 4 (Verify, round 2) · Entry point chosen by human.

## Decisions (all human-supplied)

### 1. Process capture strategy
- **Settled:** `pid` default (wrapped process + same-process child sessions). Separately-spawned CLI subagents covered by wrapped CLI shims; visibility shared via control plane.
- **Source:** Human product-decision answer 2026-11-25.
- **Rejected:** `name` default (unrelated same-name capture); pid-only with no shims.

### 2. Plugin activation
- **Settled:** Examples are canonical; all workflow plugins symlinked into `~/.looper/extensions`. No manual copying.
- **Source:** Human ("instead of drifting with manually copying symlink all or something...").
- **Rejected:** manual copying; examples-only inactive.

### 3. Plan artifact
- **Settled:** Real Liza workspace in looper repo.
- **Source:** Human selection.
- **Rejected:** markdown-only.

### 4. Augmentation outcome (gate blocker F1, round 1)
- **Settled:** As needed per extension. Request hook attaches pixel context so the LLM does not wander files; pixel planning/tasks fan out subagents by augmenting the response/tool-call boundary; machine results surface to the human via response-only; LLM is used for thinking/generating, tools (pixel et al.) drive the workflow. Where pixel lacks a primitive, write a pixel plugin.
- **Source:** Human answer 2026-11-25 after mechanism clarification (HTTP-boundary-only; pixel results available at request/response/tool-call boundaries).
- **Rejected:** prompt-steering-only; human-overlay-only.
- **Status:** Round-1 blocker resolved.

### 5. Liza compatibility behavior (gate blocker F2, round 1)
- **Settled:** Active. Looper wraps any harness (Claude/Codex/OpenCode/Pi/ZCode) and enforces the Liza way of working: deterministic independent-context subagents spun via the harness's own subagent tool calls, recursive by architecture, pixel context pre-injected, complete visibility. Pairing contract prefix never rewritten; blackboard CLI-only.
- **Source:** Human answer 2026-11-25.
- **Rejected:** passive non-regression; phased deferral.
- **Status:** Round-1 blocker resolved.

### 6. Cache-prefix hash failure
- **Settled:** Send the mutation anyway and log a warning. Cache verification is advisory, not a hard stop.
- **Source:** Human answer 2026-11-25.
- **Rejected:** hard stop to pass-through.

### 7. MVP validation set
- **Settled:** OpenCode, Pi (free OpenRouter model), Liza, Claude with cheap model (Haiku). Codex, Linux, Windows are best-effort/deferred.
- **Source:** Human answer 2026-11-25.
- **Rejected:** OpenCode-only; all-harnesses.

### 8. Example workflows in MVP
- **Settled:** Yes, symlinked and active.
- **Source:** Human answer 2026-11-25.

### 9. Named examples that ship
- **Settled:** subagent-augmentation, pixel-brief, chaining, router, liza-deterministic, two-channel, fanout (the current `examples/extensions/` set), all symlinked.
- **Source:** Derived from human decision 8 + repo state; if this over-specifies, human can amend.

## Round-1 gate notes disposition
- F3 capability/criteria mapping: addressed by explicit MVP scope + success criteria including detection, control plane, fail-open config indirectly via tests.
- F4 determinism: three meanings now defined in Behavior rules.
- F5 fail-open precedence: decision 6.
- F6 validation boundary: decision 7.
- F7 shim UX: wrapped shim generator exists (`core/workflows/shim.ts`), `looper <harness>` unchanged; shim install is a helper for operators, not a new CLI surface.
- F8 "7 tiers": count removed from spec ("Config layered").
- F9 decision-record closure: this record now covers all product decisions including F1/F2.
- F10 named workflows: decision 9.

## Unclaimed markers
None. Every product decision above is human-supplied or explicitly derived from a human decision and marked as such.

## Round-2 gate
Pending re-check by the SAME independent reviewer that issued round 1 (per goal-writing protocol).
