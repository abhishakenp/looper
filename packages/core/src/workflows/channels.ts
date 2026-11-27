/**
 * Two augmentation channels — the core cache-safety rule from the user:
 *
 *  - RESPONSE-ONLY: work the LLM must NOT know about (pixel results, hidden
 *    decisions, background tool output). Inject into the client-bound response
 *    ONLY. Never touch the request → cached prefix unchanged.
 *  - REQUEST+RESPONSE: context the LLM actually needs. Inject into the request
 *    AFTER the cache boundary (so the model sees it) AND echo into the response
 *    (so the T3 Code / harness UI sees the same context). Prefix hash verified.
 *
 * Liza pairing is a contract injected into the harness session, so its rules
 * live in the cached prefix — looper must never rewrite them (channel response-only
 * for status, request+response for new task facts after the boundary).
 */
import type { Decision } from "looper-sdk";
import { detectCacheBoundary, verifyCacheSafe, type CacheBoundary } from "./detect.js";
import { safeAppendContext } from "./inject.js";

export type InjectionChannel = "response-only" | "request+response";

export interface AugmentOptions {
  requestBody: Record<string, any>;
  /** Client-bound response body: SSE string or decoded JSON object. */
  responseBody?: unknown;
  text: string;
  key: string;
  channel: InjectionChannel;
  seen?: { get<T>(k: string): Promise<T | undefined>; set<T>(k: string, v: T): Promise<void> };
  provider?: "anthropic" | "openai" | "unknown";
}

export interface AugmentResult {
  request: Decision;
  response?: Decision;
  boundary: CacheBoundary;
  channelsApplied: InjectionChannel[];
  reasons: string[];
}

const PASS: Decision = { action: "pass" };

/** Append a visible block to an SSE response before the [DONE] sentinel. */
export function injectSseChunk(sse: string, text: string, key: string, uiOnly = true): string {
  const name = uiOnly ? "looper-ui" : "looper";
  const tag = `<${name}:${key}>`;
  if (sse.includes(tag)) return sse;
  const chunk = `data: ${JSON.stringify({
    object: "chat.completion.chunk",
    choices: [{ index: 0, delta: { role: "assistant", content: `\n\n${tag}\n${text}\n</${name}:${key}>` }, finish_reason: null }],
  })}\n\n`;
  const marker = "data: [DONE]";
  const i = sse.indexOf(marker);
  return i >= 0 ? sse.slice(0, i) + chunk + sse.slice(i) : sse + chunk;
}

/** Append a visible block to a decoded JSON response body. */
export function injectJsonResponse(obj: Record<string, any>, text: string, key: string, uiOnly = true): Record<string, any> {
  const name = uiOnly ? "looper-ui" : "looper";
  const tag = `<${name}:${key}>`;
  const choice = obj?.choices?.[0];
  if (!choice) return obj;
  const msg = choice.message || {};
  const current = typeof msg.content === "string" ? msg.content : "";
  if (current.includes(tag)) return obj;
  return {
    ...obj,
    choices: [{ ...choice, message: { ...msg, content: current + `\n\n${tag}\n${text}\n</${name}:${key}>` } }],
  };
}

/**
 * Strip response-injected blocks from a request before it reaches the LLM.
 *
 * Real-traffic proof (s_1795464246631_dv8u3s.ndjson): 218/353 assistant messages
 * in later requests contained prior response text, and ALL 7939 assistant messages
 * sat in the cached prefix (index < len-1). So a response-only injection is echoed
 * back by the harness and WILL break the next cache unless removed here.
 * The client already saw it; the LLM never does; the prefix hash is restored.
 */
export function stripInjectedResponseBlocks(body: Record<string, any>, keys: string[]): { body: Record<string, any>; removed: string[] } {
  const removed: string[] = [];
  const msgs = Array.isArray(body.messages) ? body.messages : [];
  const next = msgs.map((m: any) => {
    if (!m || typeof m !== "object" || m.role !== "assistant") return m;
    let c = m.content;
    if (Array.isArray(c)) {
      c = c.map((part: any) => {
        if (!part || typeof part !== "object" || typeof part.text !== "string") return part;
        let t = part.text;
        for (const k of keys) {
          const re = new RegExp(`\\n\\n<looper-ui:${k}>[\\s\\S]*?</looper-ui:${k}>`, "g");
          if (re.test(t)) { t = t.replace(re, ""); removed.push(k); }
        }
        return { ...part, text: t };
      });
    } else if (typeof c === "string") {
      for (const k of keys) {
        const re = new RegExp(`\\n\\n<looper-ui:${k}>[\\s\\S]*?</looper-ui:${k}>`, "g");
        if (re.test(c)) { c = c.replace(re, ""); removed.push(k); }
      }
    }
    return { ...m, content: c };
  });
  return { body: { ...body, messages: next }, removed };
}

/** Compute both decisions. Fail-open: a cache breach yields pass on the request. */
export async function augment(opts: AugmentOptions): Promise<AugmentResult> {
  const boundary = detectCacheBoundary(opts.requestBody, opts.provider);
  const reasons: string[] = [];
  const applied: InjectionChannel[] = [];

  // Client-bound response injection is cache-free — always possible when a response is present.
  let response: Decision | undefined;
  if (opts.responseBody !== undefined) {
    const rb = opts.responseBody;
    let mutated: unknown;
    if (typeof rb === "string" && (rb.includes("data: ") || rb.includes("[DONE]"))) {
      mutated = injectSseChunk(rb, opts.text, opts.key, opts.channel === "response-only");
    } else if (rb && typeof rb === "object" && !Array.isArray(rb)) {
      mutated = injectJsonResponse(rb as Record<string, any>, opts.text, opts.key, opts.channel === "response-only");
    } else if (typeof rb === "string") {
      try {
        const parsed = JSON.parse(rb);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          mutated = injectJsonResponse(parsed, opts.text, opts.key, opts.channel === "response-only");
        }
      } catch { /* non-JSON body: no injection */ }
    }
    if (mutated !== undefined && mutated !== rb) {
      // bridge.py apply_response sets flow.response.text from decision.response.body
      const body = typeof mutated === "string" ? mutated : JSON.stringify(mutated);
      response = { action: "mutate", response: { body } } as Decision;
      applied.push("response-only");
      reasons.push("client-visible");
    } else {
      reasons.push("response-already-present");
    }
  }

  let request: Decision = PASS;
  if (opts.channel === "request+response") {
    const r = await safeAppendContext({
      body: opts.requestBody,
      context: opts.text,
      key: opts.key,
      seen: opts.seen,
      boundary,
      provider: opts.provider,
    } as any);
    request = r.decision;
    if (r.injected) {
      applied.push("request+response");
      reasons.push("llm-visible", `boundary=${boundary.boundaryIndex}`);
    } else {
      reasons.push(r.reason || "request-not-injected");
    }
  } else {
    reasons.push("request-untouched");
  }

  return { request, response, boundary, channelsApplied: applied, reasons };
}
