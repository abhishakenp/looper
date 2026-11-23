/**
 * One warm child process instead of a spawn per call.
 *
 * Lessons from pi-ultimate/lib/pixel-client.ts: FIFO resolver correlation,
 * timeout kills and re-sends the other queued requests, stderr.unref() (or
 * the child's pipe keeps the parent alive for minutes), beforeExit teardown.
 * A warm `pixel classify --jsonl` is ~180ms per call vs a multi-second spawn.
 */
import { spawn, type ChildProcess } from "node:child_process";

export interface WarmProcessOptions {
  cmd: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  log?: (msg: string) => void;
  /** Max queued requests before refusing (backpressure). */
  maxQueue?: number;
  /** Write `input` verbatim as one line (pixel classify --jsonl expects a bare spec per line). */
  rawLine?: boolean;
}

interface Pending {
  id: number;
  input: string;
  resolve: (value: string) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
  sent: boolean;
}

const warmInstances = new Set<WarmProcess>();

process.on("beforeExit", () => {
  for (const p of warmInstances) p.close();
});

export class WarmProcess {
  private child?: ChildProcess;
  private queue: Pending[] = [];
  private buf = "";
  private nextId = 1;
  private closed = false;
  private opts: Required<Pick<WarmProcessOptions, "args" | "timeoutMs" | "maxQueue" | "rawLine">> & WarmProcessOptions;

  constructor(opts: WarmProcessOptions) {
    this.opts = { args: [], timeoutMs: 5_000, maxQueue: 64, rawLine: false, ...opts };
    warmInstances.add(this);
  }

  get alive() { return !!this.child && this.child.exitCode === null; }
  get pending() { return this.queue.length; }

  async request(input: string): Promise<string> {
    if (this.closed) throw new Error("WarmProcess closed");
    if (this.queue.length >= this.opts.maxQueue) throw new Error(`WarmProcess queue full (${this.opts.maxQueue})`);
    if (!this.alive) this.start();
    return new Promise<string>((resolve, reject) => {
      const id = this.nextId++;
      const timer = setTimeout(() => this.onTimeout(id), this.opts.timeoutMs);
      this.queue.push({ id, input, resolve, reject, timer, sent: false });
      this.flush();
    });
  }

  private start() {
    this.buf = "";
    const child = spawn(this.opts.cmd, this.opts.args, {
      cwd: this.opts.cwd || process.cwd(),
      env: { ...process.env, ...this.opts.env } as Record<string, string>,
      stdio: ["pipe", "pipe", "pipe"],
    });
    // A held stderr pipe keeps the parent alive for minutes after the work is done.
    (child.stderr as any)?.unref?.();
    child.on("error", (e) => this.onChildGone(`spawn error: ${e.message}`));
    child.on("exit", (code) => { if (!this.closed) this.onChildGone(`exit ${code}`); });
    child.stdout?.on("data", (d: Buffer) => this.onData(d));
    this.child = child;
    this.opts.log?.(`[warm] started ${this.opts.cmd}`);
  }

  private flush() {
    if (!this.child?.stdin) return;
    for (const p of this.queue) {
      if (p.sent) continue;
      p.sent = true;
      this.child.stdin.write((this.opts.rawLine ? p.input : JSON.stringify({ id: p.id, input: p.input })) + "\n");
    }
  }

  private onData(d: Buffer) {
    this.buf += d.toString("utf8");
    while (this.buf.includes("\n")) {
      const i = this.buf.indexOf("\n");
      const line = this.buf.slice(0, i);
      this.buf = this.buf.slice(i + 1);
      if (!line.trim()) continue;
      let msg: any;
      try { msg = JSON.parse(line); } catch { continue; }
      // Correlation: prefer an explicit id, otherwise FIFO order (pixel --jsonl).
      let idx = msg?.id !== undefined ? this.queue.findIndex(p => p.id === msg.id) : 0;
      if (idx < 0) idx = 0;
      const p = this.queue[idx];
      if (!p) continue;
      this.queue.splice(idx, 1);
      clearTimeout(p.timer);
      if (msg?.error) p.reject(new Error(String(msg.error)));
      else if (this.opts.rawLine) p.resolve(line);
      else p.resolve(typeof msg?.data === "string" ? msg.data : line);
    }
  }

  private onTimeout(id: number) {
    const p = this.queue.find(x => x.id === id);
    if (!p) return;
    this.opts.log?.(`[warm] timeout id=${id}, restarting`);
    this.queue = this.queue.filter(x => x.id !== id);
    clearTimeout(p.timer);
    p.reject(new Error(`WarmProcess timeout after ${this.opts.timeoutMs}ms`));
    // Killing the child invalidates every reply still queued in it: restart and
    // re-send the survivors, as pi-ultimate's restartWithout() does.
    const survivors = this.queue.filter(x => x.sent).map(x => ({ ...x, sent: false }));
    const unsent = this.queue.filter(x => !x.sent);
    this.queue = [...survivors, ...unsent];
    this.killChild();
    this.start();
    this.flush();
  }

  private onChildGone(reason: string) {
    this.opts.log?.(`[warm] child gone: ${reason}`);
    this.child = undefined;
    if (this.closed) return;
    for (const p of this.queue) clearTimeout(p.timer);
    const pending = this.queue;
    this.queue = [];
    for (const p of pending) p.reject(new Error(`WarmProcess ${reason}`));
  }

  private killChild() {
    const c = this.child;
    this.child = undefined;
    try { c?.kill("SIGKILL"); } catch {}
  }

  close() {
    this.closed = true;
    for (const p of this.queue) clearTimeout(p.timer);
    for (const p of this.queue) p.reject(new Error("WarmProcess closed"));
    this.queue = [];
    this.killChild();
    warmInstances.delete(this);
  }
}
