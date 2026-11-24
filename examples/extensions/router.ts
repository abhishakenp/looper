/**
 * Router extension: shared route health + one Jev decision seam in real hooks.
 * Fail-open on every error; never guesses a route.
 */
import { RouteHealth, DecideClient } from "../../packages/core/dist/index.js";

let decider: DecideClient | null = null;
export default function ({ on, log, memo, state, config }: any) {
  const health = new RouteHealth({ log });
  decider = decider || new DecideClient({ preset: "jev", timeoutMs: 3000, log });
  const models = ["model-a", "model-b"];

  on("responseheaders", (msg: any) => {
    const status = msg.res?.status;
    if (status === 429) health.note("current", status);
    return { action: "pass" };
  }, "router:health");

  on("response", async (msg: any) => {
    try {
      const text = String(msg.res?.body || "").slice(0, 2000);
      if (!text) return { action: "pass" };
      const r = await memo("router:intent", () => decider!.decide({
        text,
        context: "Is this response a code change, a question, or a plan?",
        labels: ["code", "question", "plan"],
        criteria: { code: "edits files", question: "asks something", plan: "proposes steps" },
      }));
      log("[router]", JSON.stringify({ winner: r.winner, model: r.model, provider: r.provider, available: health.filter(models) }));
      await state.set("router:last", r);
    } catch (e) {
      log("[router] fail-open", String(e).slice(0, 200));
    }
    return { action: "pass" };
  }, "router:decide");
}
