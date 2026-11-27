/**
 * Route-health observer + one bounded Jev decision seam.
 *
 * Copy into ~/.looper/extensions to enable. The absolute import keeps working
 * from the extension dir; it points at the built core package (`bun run build`
 * in /Users/abhi/proj/looper).
 *
 * This plugin OBSERVES and logs; it never rewrites a provider request. A warm
 * DecideClient is owned by this extension and closed in ctx.effect on reload —
 * a module-scoped decider would leak its child across every hot reload. Verdicts
 * are memoised by an exact hash of the judged text, not by a constant key.
 * Every hook is fail-open.
 */
import { RouteHealth, DecideClient, parseBody } from "looper-core";

/** FNV-1a: stable, short memo key. */
export function verdictKey(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Pure: model reported by a response body, or undefined for SSE/unknown. */
export function modelFromBody(raw: unknown): string | undefined {
  const b = parseBody(raw);
  if (!b || b.__sse || typeof b !== "object") return undefined;
  const model = (b as any).model;
  return typeof model === "string" && model.trim() ? model : undefined;
}

export default function router({ on, log, memo, state, config, effect }: any) {
  const cfg: Record<string, any> = config || {};
  if (cfg.enabled === false) return;
  const models: string[] = Array.isArray(cfg.models) && cfg.models.length
    ? cfg.models.filter((m: unknown) => typeof m === "string")
    : [];
  const health = new RouteHealth({ log: (m: string) => log("[router:health]", m) });
  let lastBody: string | undefined; // in-process hint for responseheaders; not durable

  let decider: DecideClient | undefined;
  if (cfg.backend !== "none") {
    try {
      decider = new DecideClient({
        preset: cfg.preset || "jev",
        timeoutMs: Number(cfg.timeoutMs) || 1_500,
        log: (...a: unknown[]) => log("[router:decide]", ...a),
      });
    } catch (e) {
      log("[router] decider unavailable; observation only", String(e).slice(0, 160));
    }
  }
  effect(() => {
    try { decider?.close(); } catch {}
    log("[router] unloaded");
  });

  on("responseheaders", (msg: any) => {
    try {
      const status = msg.res?.status;
      if (status === 429) {
        const model: string = modelFromBody(lastBody) || models[0] || "unknown";
        if (health.note(model, status)) log("[router] 429 noted", model);
      }
    } catch (e) {
      log("[router] health fail-open", String(e).slice(0, 160));
    }
    return { action: "pass" };
  }, "router:health");

  on("response", async (msg: any) => {
    try {
      const raw = typeof msg.res?.body === "string" ? msg.res.body : JSON.stringify(msg.res?.body || "");
      if (raw && raw !== "{}") lastBody = raw;
      const model = modelFromBody(raw) || models[0] || "unknown";
      if (health.note(model, raw)) log("[router] 429 noted", model);
      const text = raw.slice(0, 2_000);
      if (!text || text === "{}" || !decider) return { action: "pass" };

      const r = await memo(`router:intent:${verdictKey(text)}`, () => decider!.decide({
        text,
        context: "Is this response a code change, a question, or a plan?",
        labels: ["code", "question", "plan"],
        criteria: { code: "edits files", question: "asks something", plan: "proposes steps" },
      }));
      log("[router] verdict", JSON.stringify({
        winner: r.winner, model: r.model, provider: r.provider, available: health.filter(models),
      }));
      await state.set("router:last", { winner: r.winner, probabilities: r.probabilities, model, available: health.filter(models) });
    } catch (e) {
      log("[router] fail-open", String(e).slice(0, 200));
    }
    return { action: "pass" };
  }, "router:decide");
}
