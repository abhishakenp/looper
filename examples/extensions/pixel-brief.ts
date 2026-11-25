/**
 * Pixel coverage brief — one bounded Jev decision over a warm child.
 *
 * Copy into ~/.looper/extensions to enable. The absolute import keeps working
 * from the extension dir; it points at the built core package (`bun run build`
 * in /Users/abhi/proj/looper).
 *
 *  - WarmProcess lives inside DecideClient; ctx.effect() disposes it on reload.
 *  - Every decision has a HARD deadline (`Promise.race`), independent of the
 *    child's own timeout, so a stuck child can never stall a proxy hook.
 *  - Coverage gate: only a low `covered` probability opens the brief.
 *  - Two-channel augment(): the internal verdict goes response-only (UI tag,
 *    stripped from the next request); the brief the LLM needs goes
 *    request+response, appended after the cache boundary.
 *  - ctx.memo dedupes the verdict by an exact hash of the judged text. Failures
 *    are never memoised by the core MemoStore.
 */
import { parseBody, DecideClient, augment } from "/Users/abhi/proj/looper/packages/core/dist/index.js";

export const VERDICT_KEY = "pixel-brief-verdict";
export const BRIEF_KEY = "pixel-brief-context";
export const DEFAULT_BRIEF = "[looper brief] Cover the missing parts of the task explicitly before answering.";

export interface CoverageVerdict {
  via: "decide" | "unavailable" | "deadline";
  winner?: string;
  probabilities: Record<string, number>;
}

/** FNV-1a, stable across reloads. */
export function textHash(s: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Pure: bound any promise by a wall-clock deadline. */
export async function withDeadline<T>(p: Promise<T>, ms: number, fallback: T): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      p,
      new Promise<T>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error("pixel-brief deadline")), Math.max(1, ms));
        timer.unref?.();
      }),
    ]);
  } catch {
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Pure: a brief opens only when coverage is below the threshold. */
export function coverageGate(verdict: CoverageVerdict, threshold = 0.6): boolean {
  const p = verdict.probabilities?.covered ?? 0;
  return Number.isFinite(p) && p >= threshold;
}

export default function pixelBrief({ on, log, state, memo, config, effect }: any) {
  const cfg: Record<string, any> = config || {};
  if (cfg.enabled === false) return;
  const deadlineMs = Number(cfg.deadlineMs) || 2_500;
  const childTimeoutMs = Math.min(Number(cfg.timeoutMs) || 3_000, deadlineMs);
  const threshold = Number.isFinite(Number(cfg.coverageThreshold)) ? Number(cfg.coverageThreshold) : 0.6;
  const maxChars = Number(cfg.maxChars) || 2_000;
  const brief = typeof cfg.brief === "string" && cfg.brief.trim() ? cfg.brief : DEFAULT_BRIEF;
  const seen = {
    get: <T>(k: string) => state.get<T>(k),
    set: <T>(k: string, v: T) => state.set(k, v),
  };
  let decider: DecideClient | undefined;
  const getDecider = (): DecideClient | undefined => {
    if (decider) return decider;
    try {
      decider = new DecideClient({
        preset: cfg.preset || "jev",
        timeoutMs: childTimeoutMs,
        log: (...a: unknown[]) => log("[pixel-brief:decide]", ...a),
      });
    } catch (e) {
      log("[pixel-brief] decider unavailable", String(e).slice(0, 160));
    }
    return decider;
  };

  effect(() => {
    try { decider?.close(); } catch {}
    log("[pixel-brief] unloaded");
  });

  on("response", async (msg: any) => {
    let verdict: CoverageVerdict = { via: "unavailable", probabilities: {} };
    try {
      const raw = typeof msg.res?.body === "string" ? msg.res.body : JSON.stringify(msg.res?.body || "");
      const text = raw.slice(0, maxChars);
      if (!text || text === "{}") return { action: "pass" };

      const d = getDecider();
      if (d) {
        verdict = await withDeadline(
          memo(`pixel-brief:coverage:${textHash(text)}`, async () => {
            const out = await d.decide({
              text,
              context: "Does this response fully cover the task it was asked to do? Judge the visible text only.",
              labels: ["covered", "partial", "missing"],
              criteria: {
                covered: "answers the whole task with concrete evidence",
                partial: "answers some of it, or is vague about the rest",
                missing: "does not answer the task",
              },
            });
            return { via: "decide" as const, winner: out.winner, probabilities: out.probabilities };
          }),
          deadlineMs,
          { via: "deadline" as const, probabilities: {} },
        );
      }
      const covered = verdict.via === "decide" ? coverageGate(verdict, threshold) : false;
      log("[pixel-brief] verdict", `via=${verdict.via}`, `winner=${verdict.winner || "none"}`,
        `p=${(verdict.probabilities?.covered ?? 0).toFixed(3)}`, `gate=${covered ? "pass" : "open"}`);

      // Internal result: client-only. The looper-ui tag is stripped from the
      // next request by HookRegistry, so the cached prefix is unchanged.
      const internal = await augment({
        requestBody: {}, // response-only never reads or mutates the request
        responseBody: msg.res?.body,
        text: `[pixel-brief] coverage=${verdict.winner || "unknown"} via=${verdict.via}`,
        key: VERDICT_KEY,
        channel: "response-only",
      });
      if (internal.response) log("[pixel-brief] verdict injected response-only");

      await state.set("pixel-brief:pending", covered ? null : { text: brief });
      if (!covered) {
        // The response half of the two-channel brief: UI sees the same text.
        const echo = await augment({
          requestBody: {},
          responseBody: internal.response?.response?.body ?? msg.res?.body,
          text: brief,
          key: BRIEF_KEY,
          channel: "response-only",
        });
        if (echo.response) log("[pixel-brief] brief echoed response-only");
        return echo.response || internal.response || { action: "pass" };
      }
      return internal.response || { action: "pass" };
    } catch (e) {
      log("[pixel-brief] response fail-open", String(e).slice(0, 200));
      return { action: "pass" };
    }
  }, "pixel-brief:coverage");

  on("request", async (msg: any) => {
    try {
      const body = parseBody(msg.req?.body);
      if (!body || body.__sse || typeof body !== "object" || !Array.isArray(body.messages)) {
        return { action: "pass" };
      }
      const pending: any = await state.get("pixel-brief:pending");
      if (!pending || typeof pending.text !== "string" || !pending.text) {
        return { action: "pass" };
      }
      const r = await augment({
        requestBody: body,
        responseBody: undefined, // echoed by the response hook above
        text: pending.text,
        key: BRIEF_KEY,
        channel: "request+response",
        seen,
      });
      if (r.channelsApplied.includes("request+response")) {
        log("[pixel-brief] brief injected request+response", `boundary=${r.boundary.boundaryIndex}`);
        await state.set("pixel-brief:pending", null);
      } else {
        log("[pixel-brief] request pass", r.reasons.join(";"));
      }
      return r.request;
    } catch (e) {
      log("[pixel-brief] request fail-open", String(e).slice(0, 200));
      return { action: "pass" };
    }
  }, "pixel-brief:brief");
}
