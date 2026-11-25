/**
 * Fan-out scheduler over ctx.proc.spawn.
 *
 * Copy into ~/.looper/extensions to enable. The absolute import keeps working
 * from the extension dir; it points at the built core package (`bun run build`
 * in /Users/abhi/proj/looper).
 *
 * Demonstrates dependsOn / needs / after, P0 priority, bounded caps and one
 * terminal event per generation. plan:settled is wired to ctx.wake.emit so the
 * parent harness gets exactly one follow-up per generation at the next safe
 * request boundary (the core wake bus dedupes by generation).
 */
import {
  WorkerScheduler,
  type ExecuteContext,
  type JobSettled,
  type LooperSubtask,
  type SubtaskResult,
} from "/Users/abhi/proj/looper/packages/core/dist/index.js";

/** Pure: a linear dependency chain from task ids. First task has no deps. */
export function buildStageChain(ids: readonly string[], overrides: Partial<LooperSubtask> = {}): LooperSubtask[] {
  const clean = ids.filter((id): id is string => typeof id === "string" && !!id.trim());
  return clean.map((id, i) => ({
    taskId: id,
    task: id,
    priority: "P0",
    ...overrides,
    ...(i > 0 ? { dependsOn: [clean[i - 1]] } : {}),
  }));
}

/** Pure: stable wake text for a settled generation. */
export function formatWake(generation: number, r: JobSettled): string {
  return `[plan ${generation}] ${r.ok}/${r.total} done, ${r.failed} failed, ${r.skipped} skipped, ${r.aborted} aborted (${r.durationMs}ms)`;
}

/** Cross-reload monotonic generation: WakeBus dedupes by number, not by text. */
const G = globalThis as any;
function nextGeneration(): number {
  G.__looper_fanout_gen = (G.__looper_fanout_gen || 0) + 1;
  return G.__looper_fanout_gen as number;
}

export default function fanout({ on, log, proc, state, effect, config, wake }: any) {
  const cfg: Record<string, any> = config || {};
  const handles = new Set<any>();
  const scheduler = new WorkerScheduler({
    maxParallel: Number(cfg.maxParallel) || 24,
    maxActiveModelRequests: Number(cfg.maxActiveModelRequests) || 16,
    maxSpawns: Number(cfg.maxSpawns) || 64,
    killGraceMs: Number(cfg.killGraceMs) || 2_000,
    log: (m: string) => log("[fanout:scheduler]", m),
    execute: async (c: ExecuteContext): Promise<SubtaskResult> => {
      let handle: any;
      try {
        handle = await proc.spawn({
          harness: c.task.harness || "opencode",
          args: ["run", c.task.task, ...(c.task.model ? ["--model", c.task.model] : [])],
          cwd: c.task.cwd || proc.cwd,
        });
        handles.add(handle);
        c.emitEvidence(`started ${handle.child?.pid ?? "child"}`);
        // spawnProxied inherits stdio by design: stdout may be null. Collect it
        // when a harness override supplies a pipe, otherwise use the exit code.
        let out = "";
        const bound = (d: Buffer) => { out = (out + d.toString()).slice(-2048); };
        handle.child?.stdout?.on?.("data", bound);
        const timer = setTimeout(() => handle.kill?.("SIGKILL"), Number(c.task.timeoutMs) || 120_000);
        timer.unref?.();
        const code = await new Promise<number | null>((resolve) => {
          handle.child?.once?.("exit", resolve);
          handle.child?.once?.("error", () => resolve(null));
        });
        clearTimeout(timer);
        return {
          status: code === 0 ? "done" : "failed",
          digest: out || `exit=${code}`,
          filesChanged: [],
          verified: code === 0,
        };
      } catch (e) {
        return { status: "failed", error: String(e instanceof Error ? e.message : e) };
      } finally {
        handles.delete(handle);
      }
    },
  });

  scheduler.on("plan:settled", (r: JobSettled) => {
    const text = formatWake(r.generation, r);
    const emitted = wake.emit(r.generation, text);
    log("[fanout] plan:settled", JSON.stringify(r), `wake=${emitted ? "emitted" : "duplicate"}`);
    state.set("fanout:last", r).catch((e: unknown) => log("[fanout] state write failed", String(e).slice(0, 160)));
  });

  effect(() => {
    for (const h of [...handles]) { try { h.kill?.(); } catch {} }
    handles.clear();
    scheduler.abortAll("extension unloaded");
  });

  // Expose submission by reacting to a marker in a request body, e.g. a line
  // `LOOPER_FANOUT: <json>` in the user prompt. Deterministic, no LLM routing.
  // The json may be an array of subtasks or { "stages": ["a","b"] }.
  on("request", (msg: any) => {
    try {
      const raw = msg.req?.body;
      const body = typeof raw === "string" ? raw : JSON.stringify(raw);
      const m = body.match(/LOOPER_FANOUT:\s*(\{[\s\S]*?\})/);
      if (!m) return { action: "pass" };
      const parsed = JSON.parse(m[1]);
      const tasks: LooperSubtask[] = Array.isArray(parsed)
        ? parsed
        : Array.isArray(parsed.stages)
          ? buildStageChain(parsed.stages, { cwd: parsed.cwd, model: parsed.model })
          : Array.isArray(parsed.tasks) ? parsed.tasks : [];
      if (!tasks.length) return { action: "pass" };
      const generation = nextGeneration();
      const job = scheduler.submit(tasks, generation);
      log(`[fanout] submitted ${job.jobId} generation=${generation} tasks=${tasks.length}`);
    } catch (e) {
      log("[fanout] invalid task json", String(e).slice(0, 200));
    }
    return { action: "pass" };
  }, "fanout:submit");
}
