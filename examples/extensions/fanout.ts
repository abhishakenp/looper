/**
 * Fan-out scheduler over ctx.proc.spawn — copy into ~/.looper/extensions to enable.
 * Demonstrates dependsOn / needs / after, P0 priority, bounded caps and one
 * terminal event per generation. Wire a command into your harness to submit jobs.
 */
import { WorkerScheduler, type ExecuteContext, type SubtaskResult } from "../../packages/core/dist/index.js";

export default function ({ on, log, proc, state, effect }: any) {
  const scheduler = new WorkerScheduler({
    maxParallel: 24,
    maxActiveModelRequests: 16,
    maxSpawns: 64,
    killGraceMs: 2_000,
    log,
    execute: async (c: ExecuteContext): Promise<SubtaskResult> => {
      // Real implementation: run the child harness with the task's prompt and
      // model, capture its digest, and enforce the ownership lease.
      const handle = await proc.spawn({
        harness: "opencode",
        args: ["run", c.task.task, ...(c.task.model ? ["--model", c.task.model] : [])],
        cwd: c.task.cwd || proc.cwd,
      });
      c.emitEvidence(`started ${handle.child.pid}`);
      const digest = await new Promise<string>((resolve) => {
        let out = "";
        handle.child.stdout?.on("data", (d: Buffer) => { out += d.toString(); });
        handle.child.on("exit", () => resolve(out.slice(-2048)));
      });
      return { status: "done", digest };
    },
  });

  scheduler.on("plan:settled", (r: any) => {
    log("[plan:settled]", JSON.stringify(r));
    state.set("fanout:last", r);
  });
  effect(() => scheduler.abortAll("extension unloaded"));

  // Expose submission by reacting to a marker in a request body, e.g. a line
  // `LOOPER_FANOUT: <json>` in the user prompt. Deterministic, no LLM routing.
  on("request", (msg: any) => {
    const raw = msg.req?.body || "";
    const body = typeof raw === "string" ? raw : JSON.stringify(raw);
    const m = body.match(/LOOPER_FANOUT:\s*(\{[\s\S]*?\})/);
    if (!m) return { action: "pass" };
    try {
      const tasks = JSON.parse(m[1]);
      const job = scheduler.submit(tasks);
      log(`[fanout] submitted ${job.jobId}`);
    } catch (e) {
      log("[fanout] invalid task json", e);
    }
    return { action: "pass" };
  }, "fanout:submit");
}
