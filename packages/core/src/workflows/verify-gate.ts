/**
 * Settle-time verification. A checkout's checks are registered once, run once,
 * and reported through a single terminal receipt — no re-deriving evidence a
 * previous gate already observed. The runner is injectable so the gate can be
 * exercised without spawning real commands.
 */
import { spawn } from "node:child_process";
import { resolve } from "node:path";

export const DEFAULT_VERIFY_TIMEOUT_MS = 30_000;
export const DEFAULT_VERIFY_OUTPUT_CAP = 1_500;

export interface VerificationResult {
  root: string;
  command: string;
  ok: boolean;
  exitCode: number | null;
  /** Observed combined stdout/stderr, capped to a trailing window. */
  output: string;
  ranAt: number;
  durationMs: number;
  timedOut: boolean;
  error?: string;
}

export interface VerificationReceipt {
  root: string;
  commands: string[];
  ok: boolean;
  results: VerificationResult[];
  output: string;
  ranAt: number;
  /** Marker for consumers: this gate has finished and will not append more results. */
  terminal: true;
}

export interface VerificationRunnerContext {
  root: string;
  timeoutMs: number;
  outputCap?: number;
}

/** Injected runners only need to report what they observed; the gate fills in identity and timing. */
export type VerificationRunnerResult = Partial<VerificationResult> & {
  ok?: boolean;
  exitCode?: number | null;
  output?: string;
};

export type VerificationRunner = (
  command: string,
  ctx: VerificationRunnerContext,
) => Promise<VerificationRunnerResult> | VerificationRunnerResult;

export interface VerificationGateOptions {
  timeoutMs?: number;
  outputCap?: number;
  runner?: VerificationRunner;
  onReceipt?: (receipt: VerificationReceipt) => void;
  /** Share one gate across several preRunVerify calls. */
  gate?: VerificationGate;
}

const tail = (text: string, cap: number): string => text.length > cap ? text.slice(-cap) : text;

/** Bounded, async execution. Detached group on POSIX so a timeout kills the whole command tree. */
export const spawnVerificationRunner: VerificationRunner = (command, ctx) =>
  new Promise<VerificationRunnerResult>((done) => {
    const cap = ctx.outputCap ?? DEFAULT_VERIFY_OUTPUT_CAP;
    let output = "";
    let timedOut = false;
    let settled = false;
    const child = spawn(command, {
      shell: true,
      cwd: ctx.root,
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    });
    const collect = (chunk: Buffer): void => {
      output += chunk.toString();
      if (output.length > cap * 4) output = output.slice(-cap * 2);
    };
    child.stdout.on("data", collect);
    child.stderr.on("data", collect);
    const timer = setTimeout(() => {
      timedOut = true;
      try { process.kill(-child.pid!, "SIGKILL"); } catch { child.kill("SIGKILL"); }
    }, ctx.timeoutMs);
    const settle = (exitCode: number | null, error?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      let text = output.trim();
      if (timedOut) text = `TIMED OUT after ${ctx.timeoutMs}ms (not a test failure).\n${text}`.slice(-cap);
      if (error) text = `${error}\n${text}`.slice(-cap);
      done({ ok: !timedOut && !error && exitCode === 0, exitCode, output: tail(text, cap), timedOut, error });
    };
    child.on("error", (error) => settle(null, error.message));
    child.on("close", (code) => settle(code));
  });

export class VerificationGate {
  private readonly registered = new Map<string, { root: string; command: string }>();
  private readonly recorded = new Map<string, VerificationResult>();
  private readonly active = new Map<string, Promise<VerificationResult>>();
  private _receipt?: VerificationReceipt;
  private _emissions = 0;
  private activeRun?: Promise<VerificationReceipt>;

  constructor(private readonly options: VerificationGateOptions = {}) {}

  static key(root: string, command: string): string { return `${resolve(root)}\u0000${command}`; }

  get receipt(): VerificationReceipt | undefined { return this._receipt; }
  /** Number of terminal receipts emitted; exactly one per completed batch. */
  get emissions(): number { return this._emissions; }
  get results(): VerificationResult[] { return [...this.recorded.values()]; }
  get pending(): string[] {
    return [...this.registered.entries()].filter(([key]) => !this.recorded.has(key)).map(([, entry]) => entry.command);
  }

  /** Idempotent by root + command; returns only the newly registered keys. */
  register(root: string, commands: string[]): string[] {
    const target = resolve(root);
    const added: string[] = [];
    for (const command of commands) {
      const key = VerificationGate.key(target, command);
      if (this.registered.has(key)) continue;
      this.registered.set(key, { root: target, command });
      added.push(key);
    }
    if (added.length) this._receipt = undefined;
    return added;
  }

  private runEntry(key: string, entry: { root: string; command: string }): Promise<VerificationResult> {
    const inflight = this.active.get(key);
    if (inflight) return inflight;
    const started = Date.now();
    const runner = this.options.runner ?? spawnVerificationRunner;
    const timeoutMs = this.options.timeoutMs ?? DEFAULT_VERIFY_TIMEOUT_MS;
    const cap = this.options.outputCap ?? DEFAULT_VERIFY_OUTPUT_CAP;
    const base = { root: entry.root, command: entry.command, ranAt: started };
    const normalize = (raw: VerificationRunnerResult, timedOut: boolean): VerificationResult => ({
      ...base,
      ok: raw.ok ?? (raw.exitCode === 0),
      exitCode: raw.exitCode ?? (raw.ok === false ? 1 : 0),
      output: tail(raw.output ?? "", cap),
      timedOut: raw.timedOut ?? timedOut,
      error: raw.error,
      durationMs: raw.durationMs ?? (Date.now() - started),
      ranAt: raw.ranAt ?? started,
    });
    const promise = Promise.resolve()
      .then(() => runner(entry.command, { root: entry.root, timeoutMs, outputCap: cap }))
      .then((raw) => {
        const result = normalize(raw, raw.timedOut ?? false);
        this.recorded.set(key, result);
        return result;
      }, (error: unknown) => {
        const result = normalize({ ok: false, exitCode: 1, output: error instanceof Error ? error.message : String(error) }, false);
        this.recorded.set(key, result);
        return result;
      });
    const tracked = promise.finally(() => this.active.delete(key));
    this.active.set(key, tracked);
    return tracked;
  }

  /** Execute every registered check at most once, then emit one receipt for the batch. */
  async run(root?: string): Promise<VerificationReceipt> {
    if (this.activeRun) return this.activeRun;
    const target = root ? resolve(root) : undefined;
    const entries = [...this.registered.entries()].filter(([, e]) => !target || e.root === target);
    const pending = entries.filter(([key]) => !this.recorded.has(key));
    if (!pending.length && this._receipt) return this._receipt;

    const batch = (async (): Promise<VerificationReceipt> => {
      await Promise.all(pending.map(([key, entry]) => this.runEntry(key, entry)));
      const results = entries.map(([key]) => this.recorded.get(key)!).filter(Boolean);
      const receipt: VerificationReceipt = {
        root: target ?? entries[0]?.[1].root ?? process.cwd(),
        commands: entries.map(([, entry]) => entry.command),
        ok: results.every((r) => r.ok),
        results,
        output: results.map((r) => `[${r.command}]\n${r.output}`).join("\n").trim(),
        ranAt: Math.max(0, ...results.map((r) => r.ranAt)),
        terminal: true,
      };
      this._receipt = receipt;
      this._emissions++;
      this.options.onReceipt?.(receipt);
      return receipt;
    })();
    this.activeRun = batch.finally(() => { this.activeRun = undefined; });
    return this.activeRun;
  }
}

export interface PreRunVerifyOptions extends VerificationGateOptions {}

export interface PreRunVerifyResult {
  ok: boolean;
  results: VerificationResult[];
  receipt: VerificationReceipt;
}

/** Convenience path: one gate, one batch, the observed results. */
export const preRunVerify = async (
  root: string,
  commands: string[],
  options: PreRunVerifyOptions = {},
): Promise<PreRunVerifyResult> => {
  const gate = options.gate ?? new VerificationGate(options);
  gate.register(root, commands);
  const receipt = await gate.run(resolve(root));
  return { ok: receipt.ok, results: receipt.results, receipt };
};
