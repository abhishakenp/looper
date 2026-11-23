/**
 * Deterministic Liza orchestration — stages driven by observable CLI state,
 * never by the LLM's memory. Copy into ~/.looper/extensions to enable.
 * Liza has no HTTP API, so this is a proc/config plugin, not a proxy hook.
 */
import { lizaPreflight, lizaTasks, stageChain, nextStage, stageComplete, MANUAL_TRANSITIONS, proceedCommand } from "../../packages/core/dist/index.js";

export default function ({ on, log, state, proc, effect }: any) {
  const root = process.cwd();
  const entry = (process.env.LOOPER_LIZA_ENTRY || "general-objective") as any;
  const chain = stageChain(entry, process.env.LOOPER_LIZA_UNCERTAIN === "1");

  async function reconcile() {
    const health = lizaPreflight(root);
    if (!health.ok && health.code !== "validation") {
      log("[liza] quarantined", health.code, health.message.slice(0, 200));
      return; // never guess task ids or statuses
    }
    const tasks = lizaTasks(root);
    if (!tasks.ok) return;
    const current = tasks.tasks.find(t => t.status && !/APPROVED|MERGED/.test(t.status));
    if (!current) return;
    const completed = chain.filter(s => stageComplete(tasks.tasks, s, `${s.toUpperCase()}_APPROVED`));
    const next = nextStage(chain, completed[completed.length - 1] || chain[0]);
    log("[liza] stage", { current: current.id, status: current.status, completed, next });
    await state.set("liza:stage", { root, entry, completed, next, at: Date.now() });
    // Manual gates are explicit: emit the exact CLI command; do not auto-run.
    for (const t of MANUAL_TRANSITIONS) log("[liza] gate available", proceedCommand(root, current.id, t));
  }

  effect(() => log("[liza] unloaded"));
  on("done", () => { reconcile().catch(e => log("[liza] error", e)); }, "liza:reconcile");
  reconcile().catch(() => {});
}
