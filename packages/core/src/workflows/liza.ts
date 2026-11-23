/**
 * Deterministic Liza orchestration helper.
 *
 * Liza is a CLI with a YAML blackboard — it has NO HTTP API, so looper's proxy
 * hooks cannot see claim/verdict/checkpoint coordination. This module drives it
 * through its CLI and gates stages on OBSERVABLE artifacts, never on the LLM's
 * memory of "what comes next". Read-only by default; mutations are explicit
 * CLI commands through proc.spawn (never edits to state.yaml).
 *
 * Source: /tmp/liza-pairing-research.md (pipeline.yaml + CLI contracts).
 */
import { spawnSync } from "node:child_process";

export type LizaEntryPoint = "general-objective" | "functional-spec" | "detailed-spec" | "technical-spec";

export interface LizaTask {
  id: string;
  status?: string;
  role_pair?: string;
  scope?: string;
  output?: Array<{ plan_ref?: string; arch_ref?: string; spec_ref?: string }>;
  [k: string]: unknown;
}

export type LizaErrorCode = "state_schema" | "validation" | "pipeline_config" | "spawn" | "unknown";
export type LizaHealth =
  | { ok: true; tasks: LizaTask[] }
  | { ok: false; code: LizaErrorCode; message: string };

export const STAGE_CHAINS: Record<LizaEntryPoint, { simple: string[]; uncertain: string[] }> = {
  "general-objective": {
    simple: ["epic-planning-pair", "us-writing-pair", "architecture-main-pair", "architecture-pair", "code-planning-pair", "coding-pair"],
    uncertain: ["epic-planning-main-pair", "epic-planning-pair", "us-writing-pair", "architecture-main-pair", "architecture-pair", "code-planning-pair", "coding-pair"],
  },
  "functional-spec": {
    simple: ["architecture-pair", "code-planning-pair", "coding-pair"],
    uncertain: ["architecture-main-pair", "architecture-pair", "code-planning-pair", "coding-pair"],
  },
  "detailed-spec": {
    simple: ["architecture-pair", "code-planning-pair", "coding-pair"],
    uncertain: ["architecture-main-pair", "architecture-pair", "code-planning-pair", "coding-pair"],
  },
  "technical-spec": {
    simple: ["code-planning-pair", "coding-pair"],
    uncertain: ["code-planning-main-pair", "code-planning-pair", "coding-pair"],
  },
};

/** Manual gates from .liza/pipeline.yaml — drive with `liza proceed <id> <name>`. */
export const MANUAL_TRANSITIONS = ["epic-to-us", "code-plan-to-coding", "us-to-coding", "architecture-to-code-plan"] as const;

function run(args: string[], cwd: string): { code: number | null; out: string; err: string } {
  // Short, bounded CLI reads. No spawnSync in a hot loop; these are stage gates.
  const r = spawnSync("liza", [...args, "-C", cwd], { encoding: "utf8", timeout: 15_000, stdio: ["ignore", "pipe", "pipe"] });
  return { code: r.status, out: r.stdout || "", err: r.stderr || "" };
}

function classify(message: string): LizaErrorCode {
  if (message.includes("state schema validation failed") || message.includes("cannot unmarshal")) return "state_schema";
  if (message.includes("missing required field")) return "validation";
  if (message.includes("pipeline") || message.includes("config")) return "pipeline_config";
  return "unknown";
}

/** Preflight: never proceed with an unreadable blackboard. `liza status` can exit 0 on error. */
export function lizaPreflight(cwd: string): LizaHealth {
  const r = run(["validate", "--skip-process-checks", "--json"], cwd);
  let parsed: any;
  try { parsed = JSON.parse(r.out); } catch {}
  if (parsed?.ok === true) return { ok: true, tasks: [] };
  const message = parsed?.error?.message || r.err || r.out || `liza validate exited ${r.code}`;
  return { ok: false, code: classify(message), message };
}

/** Read tasks via JSON only. Fail-open: never let the LLM guess task ids or statuses. */
export function lizaTasks(cwd: string): LizaHealth {
  const pre = lizaPreflight(cwd);
  if (!pre.ok && pre.code !== "validation") return pre; // schema corruption = quarantine
  const r = run(["get", "tasks", "--format", "json"], cwd);
  // Liza writes its JSON result to stderr in this build; read both streams.
  const text = (r.out || "").trim() || (r.err || "").trim();
  if (r.code !== 0 || !text) {
    return { ok: false, code: classify(r.err || r.out), message: r.err || r.out || "no tasks output" };
  }
  try {
    const tasks = JSON.parse(text);
    return { ok: true, tasks: Array.isArray(tasks) ? tasks : [] };
  } catch (e) {
    return { ok: false, code: "unknown", message: `invalid liza JSON: ${String(e)}` };
  }
}

/** Deterministic gate: a stage is complete only when a task of that pair is approved. */
export function stageComplete(tasks: LizaTask[], rolePair: string, approvedStatus: string): boolean {
  return tasks.some(t => t.role_pair === rolePair && t.status === approvedStatus);
}

/** Choose the chain from the entry point and a deterministic breadth signal. */
export function stageChain(entry: LizaEntryPoint, uncertain: boolean): string[] {
  return uncertain ? STAGE_CHAINS[entry].uncertain : STAGE_CHAINS[entry].simple;
}

/** The next stage after `current`; undefined means the chain is complete. */
export function nextStage(chain: string[], current: string): string | undefined {
  const i = chain.indexOf(current);
  return i >= 0 && i + 1 < chain.length ? chain[i + 1] : undefined;
}

/** Emit the exact CLI command for a manual gate. Never executed here — caller opts in. */
export function proceedCommand(cwd: string, taskId: string, transition: typeof MANUAL_TRANSITIONS[number]): string {
  return `liza proceed ${taskId} ${transition} -C ${JSON.stringify(cwd)}`;
}
