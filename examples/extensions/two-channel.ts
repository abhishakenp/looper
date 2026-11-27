/**
 * Two-channel augmentation example.
 *
 * Copy into ~/.looper/extensions to enable. The absolute import keeps working
 * from the extension dir; it points at the built core package (`bun run build`
 * in /Users/abhi/proj/looper).
 *
 *  - RESPONSE-ONLY: work the LLM must NOT know about (pixel results, hidden
 *    decisions). Inject into the client response with the looper-ui tag. The
 *    harness echoes assistant text into the next request; HookRegistry strips
 *    those looper-ui blocks before any hook or LLM sees them, so the cached
 *    prefix hash is restored.
 *  - REQUEST+RESPONSE: context the LLM actually needs. safeAppendContext puts
 *    it after the cache boundary; the companion response hook echoes the same
 *    text into the client with the same UI tag so both sides see one fact.
 *
 * There is no response body on a request hook, so "request+response" here is
 * implemented as a pair of hooks with a shared key — not as one augment call.
 */
import { parseBody, augment } from "looper-core";

export const PIXEL_KEY = "pixel-result";
export const TASK_CONTEXT_KEY = "task-context";

export default function twoChannel({ on, log, state }: any) {
  const seen = {
    get: <T>(k: string) => state.get<T>(k),
    set: <T>(k: string, v: T) => state.set(k, v),
  };

  on("request", async (msg: any) => {
    try {
      const body = parseBody(msg.req?.body);
      if (!body || body.__sse || !Array.isArray(body.messages)) return { action: "pass" };
      const stage: any = await state.get("liza:stage");
      const text = `[looper] current task: ${stage?.next || "unassigned"}`;
      await state.set("two-channel:task-context", text);
      const r = await augment({
        requestBody: body,
        responseBody: undefined, // no response body exists on a request hook
        text,
        key: TASK_CONTEXT_KEY,
        channel: "request+response",
        seen,
      });
      log("[two-channel] context", r.channelsApplied.join(",") || "none", r.reasons.join(";"));
      return r.request;
    } catch (e) {
      log("[two-channel] request fail-open", String(e).slice(0, 200));
      return { action: "pass" };
    }
  }, "two-channel:context");

  on("response", async (msg: any) => {
    try {
      let response: any;
      // Pixel result: internal only, the LLM never sees it.
      const pixel = await augment({
        requestBody: {}, // response-only never reads or mutates the request
        responseBody: msg.res?.body,
        text: "[pixel] classification complete: rate_limited",
        key: PIXEL_KEY,
        channel: "response-only",
      });
      if (pixel.response) {
        log("[two-channel] pixel injected response-only");
        response = pixel.response;
      }
      // The response half of task-context: same text, UI-only tag.
      const text: string | undefined = await state.get("two-channel:task-context");
      if (text) {
        const ctx = await augment({
          requestBody: {},
          responseBody: response?.response?.body ?? msg.res?.body,
          text,
          key: TASK_CONTEXT_KEY,
          channel: "response-only",
        });
        if (ctx.response) {
          log("[two-channel] context echoed response-only");
          response = ctx.response;
        }
      }
      return response || { action: "pass" };
    } catch (e) {
      log("[two-channel] response fail-open", String(e).slice(0, 200));
      return { action: "pass" };
    }
  }, "two-channel:result");
}
