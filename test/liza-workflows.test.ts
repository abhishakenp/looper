import { afterEach, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  BlackboardClient,
  defaultAdversarialScriptDir,
  REVIEW_TARGETS,
  type BlackboardClientOptions,
  type BlackboardVerdict,
} from "../packages/core/src/workflows/adversarial";
import {
  explainCommand,
  lizaLaunchPlan,
  validateWrap,
} from "../packages/core/src/workflows/liza-wrap";

const SCRIPT_DIR = defaultAdversarialScriptDir();
const scriptsPresent =
  fs.existsSync(path.join(SCRIPT_DIR, "blackboard_state.py")) &&
  fs.existsSync(path.join(SCRIPT_DIR, "blackboard_op.py"));
const bbTest = scriptsPresent ? test : test.skip;

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
const tmp = (): string => {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "looper-liza-wf-"));
  dirs.push(d);
  return d;
};

const yamlVal = (v: unknown): string => (v === null || v === undefined ? "null" : String(v));

interface FixtureOpts {
  phase: string;
  counters?: Record<string, number | null>;
  required?: string[];
  reviewers?: string[];
  verdicts?: Record<string, BlackboardVerdict | null>;
  reviewed?: Record<string, number | null>;
  worktree?: string | null;
  redTestRequired?: boolean;
}

/** Documented adversarial-pairing frontmatter, with every verdict field explicit. */
const fixtureFrontmatter = (opts: FixtureOpts): string => {
  const counters = {
    analysis_revision: 1,
    plan_revision: 1,
    red_test_round: 0,
    code_review_round: 1,
    ...opts.counters,
  };
  const required = opts.required ?? [];
  const reviewers = opts.reviewers ?? required;
  const lines = [
    `phase: ${opts.phase}`,
    "yolo: true",
    "work_type: feature",
    "rca_required: false",
    `red_test_required: ${opts.redTestRequired ?? false}`,
    ...Object.entries(counters).map(([k, v]) => `${k}: ${yamlVal(v)}`),
    required.length ? `required_reviewers: [${required.join(", ")}]` : "required_reviewers: []",
    `worktree: ${yamlVal(opts.worktree ?? null)}`,
    "worktree_path: null",
    "agents:",
    "  doer:",
    "    role: doer",
    "    status: WAITING",
  ];
  for (const id of reviewers) {
    lines.push(`  ${id}:`, "    role: reviewer", "    status: APPROVED");
    for (const f of Object.values(REVIEW_TARGETS)) {
      lines.push(`    ${f.reviewed}: ${yamlVal(opts.reviewed?.[id] ?? null)}`);
      lines.push(`    ${f.verdict}: ${yamlVal(opts.verdicts?.[id] ?? null)}`);
    }
  }
  return `${lines.join("\n")}\n`;
};

const writeBb = (opts: FixtureOpts): { bb: string } => {
  const bb = path.join(tmp(), "bb.md");
  fs.writeFileSync(bb, `---\n${fixtureFrontmatter(opts)}---\n# Blackboard\n\n## Analysis\n\n## Plan\n\n## Code Review Rounds\n`);
  return { bb };
};

const client = (
  bb: string,
  roleOrReviewerId = "doer",
  extra: Partial<BlackboardClientOptions> = {},
) => new BlackboardClient({ blackboardPath: bb, roleOrReviewerId, ...extra });

const rawOp = (args: string[]): any => {
  const r = spawnSync("python3", [path.join(SCRIPT_DIR, "blackboard_op.py"), ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(r.stderr || `blackboard_op.py ${args[0]} failed`);
  return JSON.parse(r.stdout);
};

// ── state() ──────────────────────────────────────────────────────────────────

bbTest("state() parses the documented frontmatter fixture", () => {
  const { bb } = writeBb({
    phase: "REVIEWING_ANALYSIS",
    counters: { analysis_revision: 2 },
    required: ["reviewer-codex", "reviewer-claude"],
    reviewed: { "reviewer-codex": 2, "reviewer-claude": 2 },
    verdicts: { "reviewer-codex": "APPROVED", "reviewer-claude": "CHANGES_REQUESTED" },
  });
  const r = client(bb).state();
  expect(r.ok).toBe(true);
  if (!r.ok) return;
  const s = r.state;
  expect(s.phase).toBe("REVIEWING_ANALYSIS");
  expect(s.terminal).toBe(false);
  expect(s.yolo).toBe(true);
  expect(s.counters.analysis_revision).toBe(2);
  expect(s.required_reviewers).toEqual(["reviewer-codex", "reviewer-claude"]);
  expect(typeof s.sha256).toBe("string");
  expect(s.sha256?.length).toBe(64);
  expect(s.review?.target).toBe("analysis");
  expect(s.review?.counter).toBe(2);
  expect(s.review?.complete).toBe(true);
  expect(s.review?.approved).toBe(false);
  expect(s.review?.approved_reviewers).toEqual(["reviewer-codex"]);
  expect(s.review?.changes_requested_reviewers).toEqual(["reviewer-claude"]);
});

bbTest("state() is fail-open on a missing file or bad script dir", () => {
  const missing = client(path.join(tmp(), "nope.md")).state();
  expect(missing.ok).toBe(false);
  expect(missing.state).toBeNull();
  expect(missing.ok === false && missing.error.length > 0).toBe(true);

  const { bb } = writeBb({ phase: "DRAFT" });
  const badScripts = client(bb, "doer", { scriptDir: path.join(tmp(), "no-such-scripts") }).state();
  expect(badScripts.ok).toBe(false);
  expect(badScripts.state).toBeNull();
});

// ── gateSatisfied ────────────────────────────────────────────────────────────

bbTest("gateSatisfied: fresh APPROVED votes from all required reviewers", () => {
  const { bb } = writeBb({
    phase: "REVIEWING_PLAN",
    counters: { plan_revision: 3 },
    required: ["reviewer-codex", "reviewer-claude"],
    reviewed: { "reviewer-codex": 3, "reviewer-claude": 3 },
    verdicts: { "reviewer-codex": "APPROVED", "reviewer-claude": "APPROVED" },
  });
  expect(client(bb).gateSatisfied("REVIEWING_PLAN")).toBe(true);
  // Explicit reviewer subset overrides the frontmatter list.
  expect(client(bb).gateSatisfied("REVIEWING_PLAN", ["reviewer-codex"])).toBe(true);
  expect(client(bb).gateSatisfied("REVIEWING_PLAN", ["reviewer-ghost"])).toBe(false);
});

bbTest("gateSatisfied rejects stale, COMMENT-only, phase-mismatched and empty gates", () => {
  const { bb } = writeBb({
    phase: "REVIEWING_PLAN",
    counters: { plan_revision: 3 },
    required: ["reviewer-codex", "reviewer-claude"],
    reviewed: { "reviewer-codex": 3, "reviewer-claude": 2 },
    verdicts: { "reviewer-codex": "APPROVED", "reviewer-claude": "APPROVED" },
  });
  expect(client(bb).gateSatisfied("REVIEWING_PLAN")).toBe(false); // stale vote

  const { bb: comments } = writeBb({
    phase: "REVIEWING_PLAN",
    required: ["reviewer-codex"],
    reviewed: { "reviewer-codex": 1 },
    verdicts: { "reviewer-codex": "COMMENT" },
  });
  expect(client(comments).gateSatisfied("REVIEWING_PLAN")).toBe(false);
  expect(client(comments).gateSatisfied("ANALYSIS_APPROVED")).toBe(false); // phase mismatch
  expect(client(comments).gateSatisfied("PLANNING_SUBMITTED")).toBe(false);

  const { bb: empty } = writeBb({ phase: "PLAN_APPROVED" });
  expect(client(empty).gateSatisfied("PLAN_APPROVED")).toBe(false); // no required reviewers
});

bbTest("gateSatisfied works at approved phases from raw frontmatter and fails open", () => {
  const { bb } = writeBb({
    phase: "PLAN_APPROVED",
    counters: { plan_revision: 4 },
    required: ["reviewer-codex"],
    reviewed: { "reviewer-codex": 4 },
    verdicts: { "reviewer-codex": "APPROVED" },
  });
  expect(client(bb).gateSatisfied("PLAN_APPROVED")).toBe(true);
  expect(client(bb).gateSatisfied("PLAN_APPROVED", ["reviewer-claude"])).toBe(false);
  expect(client(path.join(tmp(), "nope.md")).gateSatisfied("PLAN_APPROVED")).toBe(false);
  expect(client(bb, "doer", { scriptDir: path.join(tmp(), "no-such-scripts") }).gateSatisfied("PLAN_APPROVED")).toBe(false);
});

// ── mutations through blackboard_op.py (lock + CAS preserved) ───────────────

bbTest("submitArtifact and submitVerdict go through the locked op script", () => {
  const dir = tmp();
  const bb = path.join(dir, "bb.md");
  rawOp(["create", "--path", bb, "--goal", "looper test", "--yolo"]);
  rawOp(["register-reviewer", "--path", bb, "--agent-id", "reviewer-codex"]);
  const before = fs.readFileSync(bb, "utf8");

  const doer = client(bb);
  const submitted = doer.submitArtifact("analysis", "root cause: flaky lock");
  expect(submitted.ok).toBe(true);
  expect(submitted.state?.phase).toBe("ANALYSIS_SUBMITTED");
  expect(submitted.state?.counters.analysis_revision).toBe(1);
  expect(submitted.oldSha256).not.toBe(submitted.newSha256);
  expect(fs.readFileSync(bb, "utf8")).not.toBe(before);
  // The op script owns the lock file and the owner metadata.
  expect(fs.existsSync(`${bb}.lock`)).toBe(true);
  expect(fs.existsSync(`${bb}.lock.owner.json`)).toBe(true);
  expect(fs.readFileSync(bb, "utf8")).toContain("root cause: flaky lock");

  const verdict = client(bb, "reviewer-codex").submitVerdict("APPROVED", "looks right");
  expect(verdict.ok).toBe(true);
  expect(verdict.state?.phase).toBe("ANALYSIS_APPROVED");
  expect(client(bb).gateSatisfied("ANALYSIS_APPROVED")).toBe(true);
});

bbTest("requestChanges sets the changes-requested phase", () => {
  const { bb } = writeBb({
    phase: "REVIEWING_PLAN",
    counters: { plan_revision: 2 },
    required: ["reviewer-codex"],
    reviewers: ["reviewer-codex"],
  });
  const r = client(bb, "reviewer-codex").requestChanges("please split the second step");
  expect(r.ok).toBe(true);
  expect(r.state?.phase).toBe("PLAN_CHANGES_REQUESTED");
  expect(fs.readFileSync(bb, "utf8")).toContain("please split the second step");
});

bbTest("enterCoding records the worktree after an approved plan", () => {
  const worktree = tmp();
  const { bb } = writeBb({
    phase: "PLAN_APPROVED",
    counters: { plan_revision: 2 },
    required: ["reviewer-codex"],
    reviewed: { "reviewer-codex": 2 },
    verdicts: { "reviewer-codex": "APPROVED" },
  });
  expect(client(bb).gateSatisfied("PLAN_APPROVED")).toBe(true);
  const r = client(bb, "doer", { worktree }).enterCoding();
  expect(r.ok).toBe(true);
  expect(r.state?.phase).toBe("CODING");
  expect(r.state?.worktree).toBe(fs.realpathSync(worktree));
});

bbTest("mutations fail open instead of guessing target, counter or reviewer", () => {
  const { bb } = writeBb({ phase: "DRAFT" });
  const doerVerdict = client(bb, "doer").submitVerdict("APPROVED");
  expect(doerVerdict.ok).toBe(false);
  expect(doerVerdict.state).toBeNull();
  expect(doerVerdict.ok === false && doerVerdict.error?.includes("reviewer id")).toBe(true);

  const badTarget = client(bb).submitArtifact("bogus" as any, "text");
  expect(badTarget.ok).toBe(false);

  const noWorktree = client(bb).enterCoding();
  expect(noWorktree.ok).toBe(false);
  expect(fs.readFileSync(bb, "utf8")).toContain("phase: DRAFT"); // unchanged
});

// ── liza wrap planner ────────────────────────────────────────────────────────

test("lizaLaunchPlan produces exact argv, cwd and LIZA_AGENT_ID", () => {
  const plan = lizaLaunchPlan({
    cwd: "/repo",
    role: "reviewer-codex",
    cli: "opencode",
    extraArgs: ["-p", "review this"],
  });
  expect(plan.command).toBe("looper");
  expect(plan.args).toEqual(["opencode", "-p", "review this"]);
  expect(plan.cwd).toBe("/repo");
  expect(plan.env).toEqual({ LIZA_AGENT_ID: "reviewer-codex" });
  expect(plan.role).toBe("reviewer-codex");
  expect(plan.cli).toBe("opencode");
  expect(validateWrap(plan)).toEqual({ valid: true, reasons: [] });
});

test("lizaLaunchPlan passes no phantom args and let role override env", () => {
  const plan = lizaLaunchPlan({
    cwd: "/repo",
    role: "coder",
    cli: "codex-acp",
    env: { LIZA_AGENT_ID: "stale", LOOPER_TRACE: "1" },
  });
  expect(plan.args).toEqual(["codex-acp"]);
  expect(plan.env).toEqual({ LIZA_AGENT_ID: "coder", LOOPER_TRACE: "1" });
  expect(validateWrap(plan).valid).toBe(true);
});

test("validateWrap rejects recursion and malformed plans", () => {
  const base = lizaLaunchPlan({ cwd: "/repo", role: "coder", cli: "opencode" });
  const recursive = { ...base, args: ["looper", "opencode"] };
  expect(validateWrap(recursive).valid).toBe(false);
  expect(validateWrap(recursive).reasons.join(" ")).toContain("recursive");
  expect(validateWrap({ ...base, command: "/usr/local/bin/looper", args: ["./looper"] }).valid).toBe(false);
  expect(validateWrap({ ...base, command: "opencode" }).valid).toBe(false);
  expect(validateWrap({ ...base, cli: "" }).valid).toBe(false);
  expect(validateWrap({ ...base, role: "" }).valid).toBe(false);
  expect(validateWrap({ ...base, cwd: "" }).valid).toBe(false);
  expect(validateWrap({ ...base, env: { LIZA_AGENT_ID: "someone-else" } }).valid).toBe(false);
  expect(validateWrap({ ...base, args: [] }).valid).toBe(false);
});

test("explainCommand is shell-safe for quotes, spaces and substitutions", () => {
  const plan = lizaLaunchPlan({
    cwd: "/repo",
    role: "reviewer-codex",
    cli: "opencode",
    extraArgs: ["-p", "say 'hi' $(touch /tmp/pwned)"],
  });
  const cmd = explainCommand(plan);
  expect(cmd).toBe("LIZA_AGENT_ID='reviewer-codex' 'looper' 'opencode' '-p' 'say '\\''hi'\\'' $(touch /tmp/pwned)'");
  // The entire payload stays inside single quotes; no unquoted command substitution.
  expect(cmd.match(/'/g)?.length).toBeGreaterThan(6);
});
