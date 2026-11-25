# Decision record — specs/vision.md

Altitude: `general-objective` · Phase: 4 (Verify) · Entry point chosen by human.

## Decisions

### 1. Process capture strategy
- **What settled:** `pid` scope is the default (wrapped process + same-process child sessions). Separately-spawned CLI subagents are covered by wrapped CLI shims, so visibility is shared, not lost.
- **Who supplied it:** Human (answer to product-decision question, 2026-11-25).
- **Why:** Avoids capturing unrelated same-name processes; explicit child wrapping is deterministic.
- **Rejected:** `name` default (captures unrelated same-name processes); `pid` only (misses external CLI subagents).
- **Still open:** none.

### 2. Plugin activation
- **What settled:** Examples are the canonical source; all workflow plugins are symlinked into `~/.looper/extensions` so edits go live without copying.
- **Who supplied it:** Human ("instead of drifting with manually copying symlink all or something so we directly write plugin in examples and all those get activated").
- **Why:** Single source of truth, hot reload reaches the live session.
- **Rejected:** manual copying; examples-only.
- **Still open:** none.

### 3. Plan artifact
- **What settled:** Real Liza workspace in the looper repo.
- **Who supplied it:** Human (selected "Real Liza workspace in looper repo").
- **Why:** Full Liza protocol; blackboard tracks tasks/checkpoints/verdicts.
- **Rejected:** markdown-only plan.
- **Still open:** none.

## Human-supplied constraints (from ongoing session)
- Never break prompt cache (10x cost); two-channel augmentation; fail-open.
- Never kill/restart the live `looper opencode` session.
- Linux/Windows capture and Codex/Claude live runs are explicitly deferred.

## Unclaimed markers
None. All product decisions above are human-supplied.
