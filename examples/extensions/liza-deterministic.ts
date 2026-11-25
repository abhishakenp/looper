/**
 * Deterministic Liza orchestration — stages driven by observable CLI state,
 * never by the LLM's memory. Copy into ~/.looper/extensions to enable.
 * Liza has no HTTP API, so this is a proc/config plugin, not a proxy hook.
 * The absolute import keeps working from the extension dir; it points at the
 * built core package (`bun run build` in /Users/abhi/proj/looper).
 *
 * Manual gates are only PRINTED, never executed: a human opts in.
 */
import {
  lizaPreflight,
  lizaTasks,
  stageChain,
  nextStage,
  stageComplete,
  MANUAL_TRANSITIONS,
  proceedCommand,
} from "/Users/abhi/proj/looper/packages/core/dist/index.js";

export const ENTRY_POINTS = ["general-objective", "functional-spec", "detailed-spec", "technical-spec"] as const;

/** Pure: config wins over env; an unknown entry falls back safely. */
export function resolveEntry(cfg: Record<string, any> = {}, env: Record<string, string | undefined> = {}): any {
  const raw = cfg.entry ?? env.LOOPER_LIZA_ENTRY ?? "general-objective";
  return (ENTRY_POINTS as readonly string[]).includes(String(raw)) ? raw : "general-objective";
}

/** Pure: stage is complete only when a task of that pair has the approval status. */
export function completedStages(chain: readonly string[], tasks: readonly any[], suffix = "_APPROVED"): string[] {
  return chain.filter((s) => stageComplete(tasks as any[], s, `${s.toUpperCase()}${suffix}`));
}

/** Pure: with nothing approved the NEXT stage is the FIRST, not the second. */
export function nextUnfinishedStage(chain: readonly string[], completed: readonly string[]): string | undefined {
  if (!chain.length) return undefined;
  if (!completed.length) return chain[0];
  return nextStage(chain as string[], completed[completed.length - 1]);
}

export default function lizaDeterministic({ on, log, state, effect, config }: any) {
  const cfg: Record<string, any> = config || {};
  const root = typeof cfg.root === "string" && cfg.root ? cfg.root : process.cwd();
  const entry = resolveEntry(cfg, process.env);
  const uncertain = cfg.uncertain === true || process.env.LOOPER_LIZA_UNCERTAIN === "1";
  const suffix = typeof cfg.approvedSuffix === "string" ? cfg.approvedSuffix : "_APPROVED";
  const chain = stageChain(entry, uncertain);
  let inFlight: Promise<void> | undefined;

  function reconcileOnce(): Promise<void> {
    if (!inFlight) {
      inFlight = reconcile().finally(() => { inFlight = undefined; });
    }
    return inFlight;
  }

  async function reconcile() {
    try {
      const health = lizaPreflight(root);
      if (!health.ok && health.code !== "validation") {
        log("[liza] quarantined", health.code, health.message.slice(0, 200));
        return; // never guess task ids or statuses
      }
      const tasks = lizaTasks(root);
      if (!tasks.ok) return;
      const completed = completedStages(chain, tasks.tasks, suffix);
      const next = nextUnfinishedStage(chain, completed);
      const task = tasks.tasks.find((t: any) => t.role_pair === next)
        || tasks.tasks.find((t: any) => t.status && !/APPROVED|MERGED/.test(String(t.status)));
      log("[liza] stage", JSON.stringify({
        task: task?.id, status: task?.status, completed, next,
      }));
      await state.set("liza:stage", {
        root, entry, uncertain, completed, next,
        taskId: task?.id, status: task?.status, at: Date.now(),
      });
      if (!task) return;
      for (const t of MANUAL_TRANSITIONS) {
        log("[liza] gate available", proceedCommand(root, task.id, t));
      }
    } catch (e) {
      log("[liza] reconcile fail-open", String(e).slice(0, 200));
    }
  }

  let kick: ReturnType<typeof setTimeout> | undefined;
  effect(() => {
    if (kick) clearTimeout(kick);
    log("[liza] unloaded");
  });
  // "done" is emitted by bridge.py after every response; HookRegistry matches
  // it by type even though the static HookType union omits it.
  on("done", () => { reconcileOnce().catch(() => {}); }, "liza:reconcile");
  // CLI reads block (spawnSync); never put them in the extension load path.
  kick = setTimeout(() => reconcileOnce().catch(() => {}), 0);
  kick.unref?.();
}
