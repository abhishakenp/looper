/**
 * Two-channel augmentation example:
 *  - pixel/background results -> RESPONSE only (LLM never knows, cache intact)
 *  - task context the LLM needs -> REQUEST (after cache boundary) + RESPONSE (UI sees it)
 */
import { parseBody, augment } from "../../packages/core/dist/index.js";

export default function ({ on, log, state }: any) {
  const seen = { get: (k: string) => state.get(k), set: (k: string, v: any) => state.set(k, v) };

  on("response", async (msg: any) => {
    // Pixel result computed outside the LLM — client/UI visibility only.
    const r = await augment({
      requestBody: {},
      responseBody: msg.res?.body,
      text: "[pixel] classification complete: rate_limited",
      key: "pixel-result",
      channel: "response-only",
    });
    return r.response || { action: "pass" };
  }, "two-channel:pixel");

  on("request", async (msg: any) => {
    const body = parseBody(msg.req?.body);
    if (!body || body.__sse || !Array.isArray(body.messages)) return { action: "pass" };
    const stage: any = await state.get("liza:stage");
    const r = await augment({
      requestBody: body,
      responseBody: undefined, // echoed into the response by the companion response hook
      text: `[looper] current task: ${stage?.next || "unassigned"}`,
      key: "task-context",
      channel: "request+response",
      seen,
    });
    return r.request;
  }, "two-channel:context");
}
