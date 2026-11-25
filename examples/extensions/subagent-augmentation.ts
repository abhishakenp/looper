/**
 * Subagent augmentation: one plugin, one seamless flow.
 *
 * Copy into ~/.looper/extensions to enable. The absolute import keeps working
 * from the extension dir; it points at the built core package (`bun run build`
 * in /Users/abhi/proj/looper).
 *
 * 1. request  — detect declared subagent tools (semantic via DecideClient when
 *               config.semantic is true, deterministic name probe otherwise),
 *               memoised by tool signature, then append a CONSTANT context
 *               block with safeAppendContext (never touches the cached prefix).
 * 2. spawn    — WorkerScheduler executes queued jobs through ctx.proc.spawn.
 * 3. settled  — plan:settled -> ctx.wake.emit(generation, text), one per job.
 * 4. response — inject the settled result client-side only, via the
 *               response-only two-channel path (looper-ui tag, stripped from
 *               the next request so the cached prefix hash is restored).
 *
 * Every hook is fail-open: any error returns { action: "pass" } and is logged
 * with a named outcome. No cached prefix is ever mutated in place.
 */
import {
  parseBody,
  toolsFromRequest,
  detectSubagentTools,
  detectSubagentToolsSmart,
  safeAppendContext,
  augment,
  WorkerScheduler,
  DecideClient,
  type ExecuteContext,
  type JobSettled,
  type LooperSubtask,
  type SubtaskResult,
} from "/Users/abhi/proj/looper/packages/core/dist/index.js";

export const CONTEXT_KEY = "subagent-context";
export const RESULT_KEY = "subagent-result";

/** FNV-1a: short, stable memo key. No clock, no random bytes. */
export function signatureHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Pure: the exact tool signature is the memo identity, not the whole body. */
export function toolSignatureKey(body: unknown): string {
  return signatureHash(JSON.stringify(
    toolsFromRequest(body).map((t) => [t.name, t.description || "", t.schema || {}]),
  ));
}

/** Pure: constant guidance — safe to put after the cache boundary. */
export function contextBlock(names: readonly string[]): string {
  const list = names.filter((n) => !!n).join(", ") || "none";
  return `[subagent tools] ${list}\nReturn each subagent result as a short digest; looper surfaces it in the client response.`;
}

/** Pure: one-line client-visible summary of a settled job. */
export function resultBlock(r: JobSettled, rows: readonly any[]): string {
  const digests = rows.map((x: any) => `${x.taskId}=${x.status}`).join(", ");
  return `[subagent result] job=${r.jobId} ${r.ok}/${r.total} done (${digests || "no rows"})`;
}

/** Cross-reload monotonic generation; WakeBus dedupes by number. */
const G = globalThis as any;
function nextGeneration(): number {
  G.__looper_subagent_gen = (G.__looper_subagent_gen || 0) + 1;
  return G.__looper_subagent_gen as number;
}

function makeDecider(cfg: Record<string, any>, log: (...a: any[]) => void): DecideClient | undefined {
  if (cfg.semantic !== true) return undefined;
  try {
    return new DecideClient({
      preset: cfg.preset || "jev",
      timeoutMs: Number(cfg.timeoutMs) || 3_000,
      log: (...a: unknown[]) => log("[subagent-aug:decide]", ...a),
    });
  } catch (e) {
    log("[subagent-aug] decider unavailable; deterministic detection", String(e).slice(0, 160));
    return undefined;
  }
}

export default function subagentAugmentation({ on, log, state, memo, proc, effect, config, wake }: any) {
  const cfg: Record<string, any> = config || {};
  const decider = makeDecider(cfg, log);
  const seen = {
    get: <T>(k: string) => state.get<T>(k),
    set: <T>(k: string, v: T) => state.set(k, v),
  };
  const handles = new Set<any>();

  const scheduler = new WorkerScheduler({
    maxParallel: Number(cfg.maxParallel) || 8,
    maxActiveModelRequests: Number(cfg.maxActiveModelRequests) || 8,
    maxSpawns: Number(cfg.maxSpawns) || 32,
    log: (m: string) => log("[subagent-aug:scheduler]", m),
    execute: async (c: ExecuteContext): Promise<SubtaskResult> => {
      let handle: any;
      try {
        handle = await proc.spawn({
          harness: (c.task as any).harness || cfg.harness || "opencode",
          args: ["run", c.task.task, ...(c.task.model ? ["--model", c.task.model] : [])],
          cwd: c.task.cwd || proc.cwd,
        });
        handles.add(handle);
        c.emitEvidence(`spawned ${handle.child?.pid ?? "child"}`);
        const timer = setTimeout(() => handle.kill?.("SIGKILL"), Number(c.task.timeoutMs) || 120_000);
        timer.unref?.();
        const code = await new Promise<number | null>((resolve) => {
          handle.child?.once?.("exit", resolve);
          handle.child?.once?.("error", () => resolve(null));
        });
        clearTimeout(timer);
        return { status: code === 0 ? "done" : "failed", digest: `exit=${code}`, verified: code === 0 };
      } catch (e) {
        // Per-task isolation: a spawn failure is a failed row, not a hook error.
        return { status: "failed", error: String(e instanceof Error ? e.message : e) };
      } finally {
        handles.delete(handle);
      }
    },
  });

  scheduler.on("plan:settled", (r: JobSettled) => {
    try {
      const rows = scheduler.rows(r.jobId);
      const text = resultBlock(r, rows);
      const emitted = wake.emit(r.generation, text);
      log("[subagent-aug] settled", JSON.stringify(r), `wake=${emitted ? "emitted" : "duplicate"}`);
      state.set("subagent-aug:last", { ...r, rows, text })
        .catch((e: unknown) => log("[subagent-aug] state write failed", String(e).slice(0, 160)));
    } catch (e) {
      log("[subagent-aug] settle fail-open", String(e).slice(0, 160));
    }
  });

  effect(() => {
    for (const h of [...handles]) { try { h.kill?.(); } catch {} }
    handles.clear();
    scheduler.abortAll("extension unloaded");
    try { decider?.close(); } catch {}
    log("[subagent-aug] unloaded");
  });

  on("request", async (msg: any) => {
    let decision: any = { action: "pass" };
    try {
      const body = parseBody(msg.req?.body);
      if (!body || body.__sse || typeof body !== "object" || !Array.isArray(body.messages)) {
        return { action: "pass" };
      }
      const key = toolSignatureKey(body);
      let detected = await memo(`subagent-aug:tools:${key}`, async () => {
        if (decider) {
          try {
            const r = await detectSubagentToolsSmart(body, decider, {
              signal: (m) => log("[subagent-aug:detect]", m),
            });
            return { names: r.tools.map((t) => t.name), via: r.via };
          } catch (e) {
            log("[subagent-aug] semantic detect fail-open", String(e).slice(0, 160));
          }
        }
        return { names: detectSubagentTools(body).map((t) => t.name), via: "deterministic" };
      });
      detected = detected || { names: [], via: "fail-open" };
      log("[subagent-aug] detected", `via=${detected.via}`, `count=${detected.names.length}`);

      if (detected.names.length) {
        const r = await safeAppendContext({
          body,
          key: CONTEXT_KEY,
          context: contextBlock(detected.names),
          seen,
        });
        if (r.injected) {
          decision = r.decision;
          log("[subagent-aug] context injected", `boundary=${r.boundary.boundaryIndex}`);
        } else log("[subagent-aug] context pass", r.reason || "not injected", `safe=${r.safe}`);
        // A non-safe decision is dropped by safeAppendContext itself ({pass}).
      }

      const raw = typeof msg.req?.body === "string" ? msg.req.body : JSON.stringify(body);
      const m = raw.match(/LOOPER_SUBAGENT_JOBS:\s*(\{[\s\S]*?\})/);
      if (m) {
        // The marker is echoed in later turns; dedupe by its exact bytes.
        const jobKey = `subagent-aug:submitted:${signatureHash(m[1])}`;
        if (await state.get(jobKey)) log("[subagent-aug] submit duplicate");
        else {
          const parsed = JSON.parse(m[1]);
          const tasks: LooperSubtask[] = Array.isArray(parsed) ? parsed : (Array.isArray(parsed.tasks) ? parsed.tasks : []);
          if (tasks.length) {
            await state.set(jobKey, true);
            const generation = nextGeneration();
            const job = scheduler.submit(tasks, generation);
            log("[subagent-aug] submitted", job.jobId, `generation=${generation}`, `tasks=${tasks.length}`);
          } else log("[subagent-aug] submit skipped", "empty task list");
        }
      }
    } catch (e) {
      log("[subagent-aug] request fail-open", String(e).slice(0, 200));
    }
    return decision;
  }, "subagent-aug:detect");

  on("response", async (msg: any) => {
    try {
      const last: any = await state.get("subagent-aug:last");
      if (!last || typeof last.text !== "string") return { action: "pass" };
      const doneKey = `subagent-aug:resulted:${last.generation}`;
      if (await state.get(doneKey)) return { action: "pass" };
      const r = await augment({
        requestBody: {}, // response-only: requestBody is never read or mutated
        responseBody: msg.res?.body,
        text: last.text,
        key: RESULT_KEY,
        channel: "response-only",
      });
      await state.set(doneKey, true);
      log("[subagent-aug] result", r.channelsApplied.join(",") || "none", `generation=${last.generation}`);
      return r.response || { action: "pass" };
    } catch (e) {
      log("[subagent-aug] response fail-open", String(e).slice(0, 200));
      return { action: "pass" };
    }
  }, "subagent-aug:result");
}
