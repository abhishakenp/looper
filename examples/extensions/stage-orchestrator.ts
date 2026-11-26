/**
 * Deterministic Liza stage orchestrator through looper.
 * Pixel builds the stage plan; LLM is asked only for bounded shapes it must produce;
 * each stage runs in a fresh-context subagent via the harness's own tool.
 */
import { buildStagePlan, stageSubagentArgs } from "/Users/abhi/proj/looper/packages/core/dist/index.js";
import { parseBody } from "/Users/abhi/proj/looper/packages/core/dist/index.js";

let plan: any = null;
export default function ({ on, log, state, wake, effect, config }: any) {
  effect(() => log("[stage-orchestrator] unloaded"));
  on("request", async (msg: any) => {
    if (plan) return { action: "pass" };
    const body = parseBody(msg.req?.body);
    if (!body || body.__sse || !Array.isArray(body.messages)) return { action: "pass" };
    try {
      const scope = await fetch("file:///tmp/scope.json").then(r => r.json()).catch(() => ({ targets: [] }));
      plan = await buildStagePlan(config?.entry || "general-objective", {
        targets: scope.targets || [],
        lizaStatus: "looper stage run",
        approvedRefs: ["specs/vision.md"],
      });
      const args = stageSubagentArgs(plan, 0, body);
      if (args) log("[stage-orchestrator] first stage args", JSON.stringify(args).slice(0, 200));
      await state.set("liza:stage-plan", plan);
      wake.emit(1, `stage plan ready: ${plan.chain.join(" -> ")}`);
    } catch (e) { log("[stage-orchestrator] fail-open", String(e).slice(0, 160)); }
    return { action: "pass" };
  }, "stage:plan");
}
