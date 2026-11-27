/**
 * Deterministic guidance chaining.
 *
 * Copy this file into ~/.looper/extensions to enable it. The absolute import
 * keeps working from the extension dir; it points at the built core package
 * (`bun run build` in /Users/abhi/proj/looper). A relative import would break
 * the moment the file is copied out of this repo.
 *
 * The guidance block is CONSTANT: no Date.now(), no nonce, no per-flow data.
 * safeAppendContext appends it to the final message, after every cache
 * boundary this project knows about, and verifies the prefix hash before it
 * returns. A key in ctx.state makes the injection once-per-conversation.
 */
import { parseBody, safeAppendContext } from "looper-core";

export const CHAINING_KEY = "chaining-guidance";
export const DEFAULT_STEPS = ["plan", "implement", "verify", "report"] as const;

/** Pure: same steps always produce the same bytes. */
export function buildGuidance(steps: readonly string[]): string {
  const clean = steps
    .filter((s): s is string => typeof s === "string" && !!s.trim())
    .map((s) => s.trim());
  if (!clean.length) return "";
  return ["[looper chain]", ...clean.map((s, i) => `${i + 1}. ${s}`), "[/looper chain]"].join("\n");
}

/** Pure: read config, never the clock. Bad shapes fall back to DEFAULT_STEPS. */
export function guidanceFromConfig(cfg: Record<string, unknown> = {}): string {
  const steps = Array.isArray(cfg.steps) ? cfg.steps : DEFAULT_STEPS;
  return buildGuidance(steps as readonly string[]);
}

/** Pure: dedupe check over stable keys (the block itself is never hashed). */
export function isDuplicateGuidance(keys: Iterable<string>, key = CHAINING_KEY): boolean {
  for (const k of keys) if (k === key || k === `looper:injected:${key}`) return true;
  return false;
}

export default function chaining({ on, log, state, config }: any) {
  const cfg: Record<string, unknown> = config || {};
  if (cfg.enabled === false) return;
  const context = guidanceFromConfig(cfg);
  if (!context) {
    log("[chaining] no steps configured: pass");
    return;
  }
  const key = typeof cfg.key === "string" && cfg.key.trim() ? cfg.key : CHAINING_KEY;
  const seen = {
    get: <T>(k: string) => state.get<T>(k),
    set: <T>(k: string, v: T) => state.set(k, v),
  };

  on("request", async (msg: any) => {
    try {
      const body = parseBody(msg.req?.body);
      if (!body || body.__sse || typeof body !== "object" || !Array.isArray(body.messages)) {
        return { action: "pass" };
      }
      const r = await safeAppendContext({ body, context, key, seen });
      if (r.injected) log("[chaining] injected", key, `boundary=${r.boundary.boundaryIndex}`);
      else log("[chaining] pass", r.reason || "not injected", `safe=${r.safe}`);
      return r.decision;
    } catch (e) {
      // Fail-open: a broken injection must never break the harness request.
      log("[chaining] fail-open", String(e).slice(0, 200));
      return { action: "pass" };
    }
  }, "chaining:guidance");
}
