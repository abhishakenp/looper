/**
 * Client for Liza's adversarial-pairing Markdown blackboard.
 *
 * The blackboard is machine state: frontmatter is the source of truth, the body
 * is durable context. All writes go through blackboard_op.py, which acquires a
 * flock, re-reads under the lock, mutates in memory, and atomically replaces the
 * file. We never write the Markdown ourselves — doing so would bypass the
 * compare-and-swap and the gate preconditions the script enforces.
 *
 * Fail-open is deliberate: a missing script, a bad path, or an unparsable file
 * yields an error result or `false` from a gate. It never yields a guessed
 * phase, a fabricated verdict, or a thrown exception.
 *
 * Source: ~/.liza/skills/adversarial-pairing/scripts/ (blackboard_state.py,
 * blackboard_op.py), /tmp/liza-pairing-research.md §1.5.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export type BlackboardTarget = "analysis" | "plan" | "red-test" | "code";
export type BlackboardVerdict = "APPROVED" | "CHANGES_REQUESTED" | "COMMENT";

export const BLACKBOARD_TARGETS: readonly BlackboardTarget[] = ["analysis", "plan", "red-test", "code"];
export const BLACKBOARD_VERDICTS: readonly BlackboardVerdict[] = ["APPROVED", "CHANGES_REQUESTED", "COMMENT"];
export const ADVERSARIAL_DIR_ENV = "LOOPER_LIZA_ADVERSARIAL_DIR";

/** Mirrors blackboard_state.REVIEW_TARGETS and blackboard_op.REVIEW_FIELDS. */
export const REVIEW_TARGETS: Record<string, { counter: string; reviewed: string; verdict: string; target: BlackboardTarget }> = {
  ANALYSIS_SUBMITTED: { counter: "analysis_revision", reviewed: "reviewed_analysis_revision", verdict: "analysis_verdict", target: "analysis" },
  REVIEWING_ANALYSIS: { counter: "analysis_revision", reviewed: "reviewed_analysis_revision", verdict: "analysis_verdict", target: "analysis" },
  ANALYSIS_APPROVED: { counter: "analysis_revision", reviewed: "reviewed_analysis_revision", verdict: "analysis_verdict", target: "analysis" },
  PLANNING_SUBMITTED: { counter: "plan_revision", reviewed: "reviewed_plan_revision", verdict: "plan_verdict", target: "plan" },
  REVIEWING_PLAN: { counter: "plan_revision", reviewed: "reviewed_plan_revision", verdict: "plan_verdict", target: "plan" },
  PLAN_APPROVED: { counter: "plan_revision", reviewed: "reviewed_plan_revision", verdict: "plan_verdict", target: "plan" },
  RED_TEST_SUBMITTED: { counter: "red_test_round", reviewed: "reviewed_red_test_round", verdict: "red_test_verdict", target: "red-test" },
  REVIEWING_RED_TEST: { counter: "red_test_round", reviewed: "reviewed_red_test_round", verdict: "red_test_verdict", target: "red-test" },
  RED_TEST_APPROVED: { counter: "red_test_round", reviewed: "reviewed_red_test_round", verdict: "red_test_verdict", target: "red-test" },
  CODE_SUBMITTED: { counter: "code_review_round", reviewed: "reviewed_code_round", verdict: "code_verdict", target: "code" },
  REVIEWING_CODE: { counter: "code_review_round", reviewed: "reviewed_code_round", verdict: "code_verdict", target: "code" },
  FOLLOWUP_REVIEW: { counter: "code_review_round", reviewed: "reviewed_code_round", verdict: "code_verdict", target: "code" },
  READY_TO_COMMIT: { counter: "code_review_round", reviewed: "reviewed_code_round", verdict: "code_verdict", target: "code" },
};

export interface BlackboardReview {
  target: string;
  claim_phase: string;
  counter_field: string;
  counter: number | null;
  reviewed_field: string;
  verdict_field: string;
  diff_scope: string | null;
  complete: boolean;
  approved: boolean;
  changes_requested: boolean;
  comment_only: boolean;
  pending_reviewers: string[];
  missing_reviewers: string[];
  stale_reviewers: string[];
  approved_reviewers: string[];
  changes_requested_reviewers: string[];
  comment_reviewers: string[];
  [k: string]: unknown;
}

export interface BlackboardState {
  path: string;
  sha256: string | null;
  phase: string;
  terminal: boolean;
  yolo: boolean;
  work_type: string | null;
  worktree: string | null;
  worktree_path: string | null;
  audit: Record<string, unknown>;
  counters: {
    analysis_revision: number | null;
    plan_revision: number | null;
    red_test_round: number | null;
    code_review_round: number | null;
    [k: string]: unknown;
  };
  required_reviewers: string[];
  registered_reviewers: string[];
  missing_required_agent_records: string[];
  unrequired_registered_reviewers: string[];
  working_agents: string[];
  waiting_agents: string[];
  agent: Record<string, unknown> | null;
  review: BlackboardReview | null;
  next: { actor: string; action: string; handoff_to: string[]; [k: string]: unknown };
  [k: string]: unknown;
}

export type BlackboardStateResult =
  | { ok: true; state: BlackboardState }
  | { ok: false; state: null; error: string };

export interface BlackboardOpResult {
  ok: boolean;
  operation: string;
  state: BlackboardState | null;
  error?: string;
  oldSha256?: string | null;
  newSha256?: string | null;
}

export interface BlackboardClientOptions {
  blackboardPath: string;
  /** `doer`, `reviewer`, or `reviewer-<id>` — passed to --role-or-reviewer-id. */
  roleOrReviewerId?: string;
  /** Explicit reviewer id for submit-verdict/request-changes when role is bare `reviewer`. */
  agentId?: string;
  /** Overrides LOOPER_LIZA_ADVERSARIAL_DIR. */
  scriptDir?: string;
  /** Used by enterCoding(); otherwise the recorded frontmatter worktree is used. */
  worktree?: string;
  repoRoot?: string;
  baseBranch?: string;
  baseSha?: string;
  topicBranch?: string;
  timeoutMs?: number;
}

export const defaultAdversarialScriptDir = (): string =>
  process.env[ADVERSARIAL_DIR_ENV] || path.join(os.homedir(), ".liza", "skills", "adversarial-pairing", "scripts");

const numOrNull = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);
const strArray = (v: unknown): string[] => (Array.isArray(v) ? v.map((x) => String(x)) : []);

/** Never trust a script's output as a state unless it has the authoritative fields. */
function toState(value: unknown): BlackboardState | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const v = value as Record<string, any>;
  if (typeof v.phase !== "string" || typeof v.path !== "string") return null;
  const c = v.counters || {};
  return {
    ...v,
    path: v.path,
    sha256: typeof v.sha256 === "string" ? v.sha256 : null,
    phase: v.phase,
    terminal: v.terminal === true,
    yolo: v.yolo === true,
    work_type: typeof v.work_type === "string" ? v.work_type : null,
    worktree: typeof v.worktree === "string" ? v.worktree : null,
    worktree_path: typeof v.worktree_path === "string" ? v.worktree_path : null,
    audit: v.audit && typeof v.audit === "object" ? v.audit : {},
    counters: {
      ...c,
      analysis_revision: numOrNull(c.analysis_revision),
      plan_revision: numOrNull(c.plan_revision),
      red_test_round: numOrNull(c.red_test_round),
      code_review_round: numOrNull(c.code_review_round),
    },
    required_reviewers: strArray(v.required_reviewers),
    registered_reviewers: strArray(v.registered_reviewers),
    missing_required_agent_records: strArray(v.missing_required_agent_records),
    unrequired_registered_reviewers: strArray(v.unrequired_registered_reviewers),
    working_agents: strArray(v.working_agents),
    waiting_agents: strArray(v.waiting_agents),
    agent: v.agent && typeof v.agent === "object" ? v.agent : null,
    review: v.review && typeof v.review === "object" ? (v.review as BlackboardReview) : null,
    next: v.next && typeof v.next === "object" ? v.next : { actor: "unknown", action: "", handoff_to: [] },
  };
}

// The canonical parser is imported from the installed script so the gate reads
// exactly the frontmatter blackboard_op.py would read — no second YAML dialect.
const FRONTMATTER_CODE = [
  "import json, sys",
  "sys.path.insert(0, sys.argv[1])",
  "from pathlib import Path",
  "from blackboard_state import read_frontmatter, parse_frontmatter",
  "text, _ = read_frontmatter(Path(sys.argv[2]))",
  "print(json.dumps(parse_frontmatter(text), default=str))",
].join("\n");

interface PyResult { code: number | null; out: string; err: string }

export class BlackboardClient {
  readonly blackboardPath: string;
  readonly roleOrReviewerId: string;
  readonly scriptDir: string;
  readonly timeoutMs: number;
  private readonly agentId?: string;
  private readonly worktree?: string;
  private readonly repoRoot?: string;
  private readonly baseBranch?: string;
  private readonly baseSha?: string;
  private readonly topicBranch?: string;

  constructor(opts: BlackboardClientOptions) {
    this.blackboardPath = opts.blackboardPath;
    this.roleOrReviewerId = opts.roleOrReviewerId || "doer";
    this.scriptDir = opts.scriptDir || defaultAdversarialScriptDir();
    this.timeoutMs = opts.timeoutMs ?? 15_000;
    this.agentId = opts.agentId;
    this.worktree = opts.worktree;
    this.repoRoot = opts.repoRoot;
    this.baseBranch = opts.baseBranch;
    this.baseSha = opts.baseSha;
    this.topicBranch = opts.topicBranch;
  }

  private run(script: string, args: string[]): PyResult {
    // "-c" is a python3 flag, not a filename in the script directory.
    const argv = script === "-c" ? ["-c", ...args] : [path.join(this.scriptDir, script), ...args];
    try {
      const r = spawnSync("python3", argv, {
        encoding: "utf8",
        timeout: this.timeoutMs,
        stdio: ["ignore", "pipe", "pipe"],
      });
      return { code: r.status, out: r.stdout || "", err: (r.stderr || "") + (r.error ? ` ${r.error.message}` : "") };
    } catch (e) {
      return { code: null, out: "", err: String(e) };
    }
  }

  private jsonFrom(r: PyResult): { ok: true; value: any } | { ok: false; error: string } {
    if (r.code !== 0) return { ok: false, error: r.err.trim() || `python3 exited ${r.code}` };
    try {
      return { ok: true, value: JSON.parse(r.out) };
    } catch (e) {
      return { ok: false, error: `invalid blackboard JSON: ${String(e)}` };
    }
  }

  /** Read the canonical summary. Never returns a guessed phase. */
  state(): BlackboardStateResult {
    const r = this.jsonFrom(this.run("blackboard_state.py", [
      "--path", this.blackboardPath,
      "--role-or-reviewer-id", this.roleOrReviewerId,
      "--json",
    ]));
    if (!r.ok) return { ok: false, state: null, error: r.error };
    const state = toState(r.value);
    return state ? { ok: true, state } : { ok: false, state: null, error: "blackboard_state.py returned no phase" };
  }

  /** Raw frontmatter, parsed by blackboard_state.py's own parser. */
  frontmatter(): { ok: true; value: Record<string, any> } | { ok: false; error: string } {
    const r = this.jsonFrom(this.run("-c", [
      FRONTMATTER_CODE,
      this.scriptDir,
      this.blackboardPath,
    ]));
    if (!r.ok) return r;
    if (!r.value || typeof r.value !== "object" || Array.isArray(r.value)) return { ok: false, error: "frontmatter is not a mapping" };
    return { ok: true, value: r.value };
  }

  /**
   * Deterministic gate: current phase must equal `phase` and every required
   * reviewer must have APPROVED the *current* counter revision. Stale verdicts,
   * COMMENT-only votes, an empty reviewer set, and any read error are false.
   */
  gateSatisfied(phase: string, requiredReviewers?: string[]): boolean {
    const s = this.state();
    if (!s.ok || s.state.phase !== phase) return false;
    const review = REVIEW_TARGETS[phase];
    if (!review) return false;
    const fm = this.frontmatter();
    if (!fm.ok) return false;
    const required = requiredReviewers ?? strArray(fm.value.required_reviewers);
    if (required.length === 0) return false;
    const counter = numOrNull(fm.value[review.counter]);
    if (counter === null) return false;
    const agents = fm.value.agents && typeof fm.value.agents === "object" ? fm.value.agents : {};
    for (const id of required) {
      const entry = agents[id];
      if (!entry || typeof entry !== "object") return false;
      if (numOrNull(entry[review.reviewed]) !== counter) return false;
      if (entry[review.verdict] !== "APPROVED") return false;
    }
    return true;
  }

  private op(operation: string, args: string[]): BlackboardOpResult {
    const r = this.jsonFrom(this.run("blackboard_op.py", [operation, "--path", this.blackboardPath, ...args]));
    if (!r.ok) return { ok: false, operation, state: null, error: r.error };
    const state = toState(r.value);
    if (!state) return { ok: false, operation, state: null, error: "blackboard_op.py returned no phase" };
    return {
      ok: true,
      operation,
      state,
      oldSha256: typeof r.value.old_sha256 === "string" ? r.value.old_sha256 : null,
      newSha256: typeof r.value.new_sha256 === "string" ? r.value.new_sha256 : null,
    };
  }

  /** Text is staged in a temp file: the locked script remains the only writer. */
  private withNote(text: string, fn: (file: string) => BlackboardOpResult): BlackboardOpResult {
    let dir = "";
    try {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), "looper-blackboard-"));
      const file = path.join(dir, "note.md");
      fs.writeFileSync(file, text.endsWith("\n") ? text : `${text}\n`, "utf8");
      return fn(file);
    } catch (e) {
      return { ok: false, operation: "note", state: null, error: String(e) };
    } finally {
      if (dir) { try { fs.rmSync(dir, { recursive: true, force: true }); } catch {} }
    }
  }

  submitArtifact(target: BlackboardTarget, text: string): BlackboardOpResult {
    if (!BLACKBOARD_TARGETS.includes(target)) {
      return { ok: false, operation: "submit-artifact", state: null, error: `unknown target ${target}` };
    }
    return this.withNote(text, (file) =>
      this.op("submit-artifact", ["--target", target, "--body-file", file]));
  }

  private reviewerId(): string | null {
    if (this.agentId) return this.agentId;
    if (this.roleOrReviewerId.startsWith("reviewer-")) return this.roleOrReviewerId;
    return null;
  }

  /** Target and counter are derived from the current state — never guessed. */
  submitVerdict(verdict: BlackboardVerdict, note = "Submitted via looper BlackboardClient"): BlackboardOpResult {
    const op = "submit-verdict";
    if (!BLACKBOARD_VERDICTS.includes(verdict)) return { ok: false, operation: op, state: null, error: `unknown verdict ${verdict}` };
    const agentId = this.reviewerId();
    if (!agentId) return { ok: false, operation: op, state: null, error: "a reviewer id is required (role reviewer-<id> or agentId)" };
    const s = this.state();
    if (!s.ok) return { ok: false, operation: op, state: null, error: s.error };
    const review = REVIEW_TARGETS[s.state.phase];
    if (!review) return { ok: false, operation: op, state: s.state, error: `phase ${s.state.phase} has no review target` };
    const counter = s.state.counters[review.counter];
    if (counter === null) return { ok: false, operation: op, state: s.state, error: `${review.counter} is missing` };
    return this.withNote(note, (file) => this.op(op, [
      "--agent-id", agentId,
      "--target", review.target,
      "--counter", String(counter),
      "--verdict", verdict,
      "--note-file", file,
    ]));
  }

  requestChanges(note = "Changes requested via looper BlackboardClient"): BlackboardOpResult {
    return this.submitVerdict("CHANGES_REQUESTED", note);
  }

  enterCoding(): BlackboardOpResult {
    let worktree = this.worktree;
    if (!worktree) {
      const s = this.state();
      if (!s.ok) return { ok: false, operation: "enter-coding", state: null, error: s.error };
      worktree = s.state.worktree || s.state.worktree_path || undefined;
    }
    if (!worktree) return { ok: false, operation: "enter-coding", state: null, error: "no worktree recorded; pass options.worktree" };
    const args = ["--worktree", worktree];
    if (this.repoRoot) args.push("--repo-root", this.repoRoot);
    if (this.baseBranch) args.push("--base-branch", this.baseBranch);
    if (this.baseSha) args.push("--base-sha", this.baseSha);
    if (this.topicBranch) args.push("--topic-branch", this.topicBranch);
    return this.op("enter-coding", args);
  }
}
