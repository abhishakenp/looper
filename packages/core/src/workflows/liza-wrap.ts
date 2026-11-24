/**
 * Deterministic argv planner for wrapping a Liza-spawned provider with looper.
 *
 * Liza spawns a provider CLI as a child process and exports LIZA_AGENT_ID to it
 * (`liza agent --help`; /tmp/liza-investigation.md §2). To get looper's HTTP
 * hooks into that traffic, Liza must be pointed at a looper-wrapped CLI: looper
 * becomes the executable, the real provider becomes argv[0]. No process is
 * spawned here — this module only computes and validates the exact argv.
 */
import path from "node:path";

export const LOOPER_COMMAND = "looper";
export const LIZA_AGENT_ENV = "LIZA_AGENT_ID";

export interface LizaLaunchInput {
  cwd: string;
  /** Liza agent id (exported as LIZA_AGENT_ID), e.g. `reviewer-codex`. */
  role: string;
  /** Provider binary Liza would spawn, e.g. `opencode`, `claude`, `codex-acp`. */
  cli: string;
  /** Passed through verbatim after the provider name. */
  extraArgs?: string[];
  /** Override only if looper is installed under another name. */
  command?: string;
  /** Additional env; LIZA_AGENT_ID is always set from `role`. */
  env?: Record<string, string>;
}

export interface LizaLaunchPlan {
  /** Executable to run: looper. */
  command: string;
  /** Exact argv after the executable: [provider, ...extraArgs]. */
  args: string[];
  cwd: string;
  /** LIZA_AGENT_ID plus any caller env. */
  env: Record<string, string>;
  role: string;
  cli: string;
}

export interface WrapValidation {
  valid: boolean;
  reasons: string[];
}

const executableName = (p: string): string => {
  const base = path.basename(p);
  return base.replace(/\.(exe|cmd|bat|mjs|js|ts)$/i, "");
};

/** Plan the exact argv: `looper <cli> [...extraArgs]` with the Liza role in env. */
export const lizaLaunchPlan = (input: LizaLaunchInput): LizaLaunchPlan => ({
  command: input.command ?? LOOPER_COMMAND,
  args: [input.cli, ...(input.extraArgs ?? [])],
  cwd: input.cwd,
  env: { ...(input.env ?? {}), [LIZA_AGENT_ENV]: input.role },
  role: input.role,
  cli: input.cli,
});

/**
 * Guard against the one failure that makes wrapping meaningless (or infinite):
 * asking looper to wrap looper. Also rejects malformed plans so a planner bug
 * cannot surface as a mysterious spawn error.
 */
export const validateWrap = (plan: LizaLaunchPlan): WrapValidation => {
  const reasons: string[] = [];
  const command = typeof plan.command === "string" ? plan.command : "";
  const harness = typeof plan.args?.[0] === "string" ? plan.args[0] : "";

  if (!command) reasons.push("missing command");
  else if (executableName(command) !== LOOPER_COMMAND) reasons.push(`command must be looper, got ${command}`);
  if (!harness) reasons.push("missing wrapped binary (args[0])");
  else if (executableName(harness) === LOOPER_COMMAND || path.resolve(harness) === path.resolve(command)) {
    reasons.push(`recursive wrap: ${command} would wrap itself (${harness})`);
  }
  if (typeof plan.cli !== "string" || !plan.cli) reasons.push("missing provider cli");
  else if (harness && harness !== plan.cli) reasons.push(`wrapped binary ${harness} does not match cli ${plan.cli}`);
  if (typeof plan.role !== "string" || !plan.role) reasons.push("missing role");
  if (typeof plan.cwd !== "string" || !plan.cwd) reasons.push("missing cwd");
  if (plan.env?.[LIZA_AGENT_ENV] !== plan.role) reasons.push(`${LIZA_AGENT_ENV} must equal role`);
  if (!Array.isArray(plan.args) || plan.args.some((a) => typeof a !== "string" || a.length === 0)) {
    reasons.push("args must be non-empty strings");
  }
  return { valid: reasons.length === 0, reasons };
};

const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

/** Single-line, shell-safe rendering of the plan (env assignments included). */
export const explainCommand = (plan: LizaLaunchPlan): string => {
  const env = Object.keys(plan.env || {}).sort()
    .map((key) => `${key}=${shellQuote(String(plan.env[key]))}`)
    .join(" ");
  const argv = [plan.command, ...(plan.args || [])].map((a) => shellQuote(String(a))).join(" ");
  return env ? `${env} ${argv}` : argv;
};
