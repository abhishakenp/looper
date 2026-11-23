/**
 * Bounded fan-out scheduler over ctx.proc.spawn.
 *
 * Patterns ported from pi-ultimate/extensions/subagent:
 *  - dependsOn (whole result), needs (partial evidence mid-run), after (settle-only)
 *  - P0 critical path wins admission before P1 speculation
 *  - two caps: worker slots and in-flight model-request permits
 *  - per-task failure isolation (no Promise.all rejection of the whole batch)
 *  - bounded retry in place (attempt++, model hop, notBefore)
 *  - abortAll with grace; one terminal event per generation
 */
import { EventEmitter } from "node:events";

export type Priority = "P0" | "P1";
export type Ownership = "read" | "write";
export type TaskStatus = "queued" | "running" | "done" | "failed" | "aborted" | "skipped" | "blocked";

export interface LooperSubtask {
  taskId: string;
  task: string;
  files?: string[];
  ownership?: Ownership;
  cwd?: string;
  model?: string;
  dependsOn?: string[];  // wait for whole result of these ids
  needs?: string[];      // wait for partial evidence from these ids
  after?: string[];      // wait for settle (any end state) of these ids
  priority?: Priority;
  timeoutMs?: number;
  maxAttempts?: number;
  fallbackModels?: string[];
  optimisticContract?: string;
  noOpExempt?: boolean;
}

export interface SubtaskResult {
  status: "done" | "failed" | "skipped";
  digest?: string;
  filesChanged?: string[];
  verified?: boolean;
  error?: string;
  evidence?: string;
  model?: string;
}

export interface ExecuteContext {
  task: LooperSubtask;
  attempt: number;
  signal: { aborted: boolean };
  emitEvidence: (text: string) => void;
}

export interface SchedulerOptions {
  maxParallel?: number;      // worker slots (default 24)
  maxActiveModelRequests?: number; // inference permits (default 16)
  maxSpawns?: number;        // total spawns per job (default 64)
  killGraceMs?: number;
  log?: (...args: unknown[]) => void;
  execute: (ctx: ExecuteContext) => Promise<SubtaskResult>;
}

interface Node {
  spec: LooperSubtask;
  status: TaskStatus;
  attempt: number;
  result?: SubtaskResult;
  evidence?: string;
  notBefore: number;
  startedAt?: number;
  endedAt?: number;
}

interface Job {
  nodes: Map<string, Node>;
  generation: number;
  started: number;
  spawns: number;
  aborted: boolean;
  settledAlready: boolean;
  settle: (r: JobSettled) => void;
  promise: Promise<JobSettled>;
}

export class JobHandle {
  constructor(
    readonly jobId: string,
    private scheduler: WorkerScheduler,
  ) {}
  get rows() { return this.scheduler.rows(this.jobId); }
  get done(): Promise<JobSettled> { return this.scheduler.settled(this.jobId); }
  add(tasks: LooperSubtask[]) { return this.scheduler.add(this.jobId, tasks); }
  cancel(reason = "cancelled") { return this.scheduler.abortJob(this.jobId, reason); }
}

export interface JobSettled {
  jobId: string;
  generation: number;
  ok: number;
  failed: number;
  skipped: number;
  aborted: number;
  total: number;
  durationMs: number;
  reason?: string;
}

export class WorkerScheduler extends EventEmitter {
  private opts: Required<Pick<SchedulerOptions, "maxParallel" | "maxActiveModelRequests" | "maxSpawns" | "killGraceMs">> & SchedulerOptions;
  private jobs = new Map<string, Job>();
  private permits = 0;
  private active = 0;
  private nextJob = 0;

  constructor(opts: SchedulerOptions) {
    super();
    this.opts = { maxParallel: 24, maxActiveModelRequests: 16, maxSpawns: 64, killGraceMs: 2_000, ...opts };
  }

  get activeWorkers() { return this.active; }
  get activePermits() { return this.permits; }

  /** Model-request permits are admitted by request hooks, not by the worker pool. */
  acquirePermit(): boolean {
    if (this.permits >= this.opts.maxActiveModelRequests) return false;
    this.permits++;
    return true;
  }
  releasePermit() { this.permits = Math.max(0, this.permits - 1); }

  submit(tasks: LooperSubtask[], generation = 1): JobHandle {
    const jobId = `job_${Date.now()}_${++this.nextJob}`;
    const nodes = new Map<string, Node>();
    for (const t of tasks) nodes.set(t.taskId, { spec: t, status: "queued", attempt: 0, notBefore: 0 });
    let settle!: (r: JobSettled) => void;
    const promise = new Promise<JobSettled>((r) => { settle = r; });
    const job: Job = { nodes, generation, started: Date.now(), spawns: 0, aborted: false, settledAlready: false, settle, promise };
    this.jobs.set(jobId, job);
    this.opts.log?.(`[scheduler] submitted ${jobId} (${tasks.length} tasks)`);
    this.emit("looper:subagent:submitted", { jobId, generation, count: tasks.length });
    queueMicrotask(() => this.pump(jobId));
    return new JobHandle(jobId, this);
  }

  add(jobId: string, tasks: LooperSubtask[]) {
    const job = this.jobs.get(jobId);
    if (!job) return;
    for (const t of tasks) job.nodes.set(t.taskId, { spec: t, status: "queued", attempt: 0, notBefore: 0 });
    this.pump(jobId);
  }

  rows(jobId: string) {
    const job = this.jobs.get(jobId);
    return job ? [...job.nodes.values()].map(n => ({ taskId: n.spec.taskId, status: n.status, attempt: n.attempt, result: n.result })) : [];
  }

  settled(jobId: string): Promise<JobSettled> {
    const job = this.jobs.get(jobId);
    return job ? job.promise : Promise.resolve({ jobId, generation: 0, ok: 0, failed: 0, skipped: 0, aborted: 0, total: 0, durationMs: 0 });
  }

  /** Partial evidence unblocks `needs` dependencies before a worker settles. */
  evidence(jobId: string, taskId: string, text: string) {
    const job = this.jobs.get(jobId);
    const n = job?.nodes.get(taskId);
    if (!n) return;
    n.evidence = text;
    this.emit("looper:subagent:evidence", { jobId, taskId, text });
    this.pump(jobId);
  }

  private terminal(n: Node) { return ["done", "failed", "aborted", "skipped"].includes(n.status); }

  private ready(n: Node, job: any): boolean {
    if (n.status !== "queued" || Date.now() < n.notBefore) return false;
    for (const id of n.spec.dependsOn || []) {
      const d = job.nodes.get(id);
      if (!d || !this.terminal(d) || d.status !== "done") return false;
    }
    for (const id of n.spec.needs || []) {
      const d = job.nodes.get(id);
      if (!d || !d.evidence) return false;
    }
    for (const id of n.spec.after || []) {
      const d = job.nodes.get(id);
      if (!d || !this.terminal(d)) return false;
    }
    return true;
  }

  private pump(jobId: string) {
    const job = this.jobs.get(jobId);
    if (!job) return;
    if ([...job.nodes.values()].every(n => this.terminal(n))) {
      if (job.settledAlready) return;
      job.settledAlready = true;
      const rows = [...job.nodes.values()];
      const res: JobSettled = {
        jobId,
        generation: job.generation,
        ok: rows.filter(n => n.status === "done").length,
        failed: rows.filter(n => n.status === "failed").length,
        skipped: rows.filter(n => n.status === "skipped").length,
        aborted: rows.filter(n => n.status === "aborted").length,
        total: rows.length,
        durationMs: Date.now() - job.started,
        reason: job.aborted ? "aborted" : undefined,
      };
      this.emit("plan:settled", res);
      job.settle(res);
      return;
    }
    if (job.aborted) return;
    const ready = [...job.nodes.values()].filter(n => this.ready(n, job));
    // P0 before P1, then declaration order. P1 speculation is capped.
    ready.sort((a, b) => (a.spec.priority === "P0" ? 0 : 1) - (b.spec.priority === "P0" ? 0 : 1));
    const speculation = Math.max(1, Math.floor(this.opts.maxParallel / 2));
    let p1 = 0;
    for (const n of ready) {
      if (this.active >= this.opts.maxParallel || job.spawns >= this.opts.maxSpawns) break;
      if (n.spec.priority === "P1" && p1++ >= speculation) continue;
      n.status = "running";
      n.startedAt = Date.now();
      this.active++;
      job.spawns++;
      const signal = { aborted: false };
      const ctx: ExecuteContext = {
        task: n.spec,
        attempt: n.attempt + 1,
        signal,
        emitEvidence: (text) => this.evidence(jobId, n.spec.taskId, text),
      };
      Promise.resolve()
        .then(() => this.opts.execute(ctx))
        .then((r) => this.finish(jobId, n, r, undefined, signal))
        .catch((e) => this.finish(jobId, n, undefined, e, signal));
    }
  }

  private finish(jobId: string, n: Node, result?: SubtaskResult, error?: unknown, signal?: { aborted: boolean }) {
    this.active = Math.max(0, this.active - 1);
    const job = this.jobs.get(jobId);
    if (!job) return;
    n.endedAt = Date.now();
    if (signal?.aborted) n.status = "aborted";
    else if (result) {
      n.result = result;
      n.status = result.status === "done" ? "done" : result.status === "skipped" ? "skipped" : "failed";
      if (result.evidence) n.evidence = result.evidence;
    } else {
      n.status = "failed";
      n.result = { status: "failed", error: String(error instanceof Error ? error.message : error) };
    }
    // Bounded retry in place: attempt++, model hop, delayed re-admission.
    const max = n.spec.maxAttempts ?? 1;
    if (n.status === "failed" && n.attempt + 1 < max) {
      n.attempt++;
      n.status = "queued";
      const delay = Math.min(5_000, 250 * n.attempt);
      n.notBefore = Date.now() + delay;
      if (n.spec.fallbackModels?.length) {
        n.spec = { ...n.spec, model: n.spec.fallbackModels[(n.attempt - 1) % n.spec.fallbackModels.length] };
      }
      this.opts.log?.(`[scheduler] retry ${n.spec.taskId} attempt ${n.attempt + 1} in ${delay}ms`);
      // Re-admit after the backoff; otherwise the node stays queued forever.
      setTimeout(() => this.pump(jobId), delay).unref?.();
    }
    this.emit("looper:subagent:finished", { jobId, taskId: n.spec.taskId, status: n.status, result: n.result });
    this.pump(jobId);
  }

  /** Cancel queued work, abort running work with a grace period, settle stragglers. */
  abortJob(jobId: string, reason = "aborted") {
    const job = this.jobs.get(jobId);
    if (!job) return;
    job.aborted = true;
    for (const n of job.nodes.values()) {
      if (n.status === "queued") n.status = "aborted";
      else if (n.status === "running") n.status = "aborted"; // signalchecked at finish
    }
    const grace = this.opts.killGraceMs;
    setTimeout(() => {
      this.active = Math.max(0, this.active - [...job.nodes.values()].filter(n => n.status === "aborted").length);
      this.pump(jobId);
    }, grace).unref?.();
    this.opts.log?.(`[scheduler] aborted ${jobId}: ${reason}`);
  }

  /** Global abort: every job, every group (proc handles process-group kill). */
  abortAll(reason = "shutdown") {
    for (const id of this.jobs.keys()) this.abortJob(id, reason);
  }
}
