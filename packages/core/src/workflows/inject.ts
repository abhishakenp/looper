/**
 * Cache-safe request mutation.
 *
 * The cached prefix is system + tools + all-but-last message (OpenAI
 * prompt_cache_key) or everything before cache_control (Anthropic). Any change
 * to those bytes costs 10x. These helpers append at a deterministic position,
 * dedupe identical injections, and verify the prefix hash before returning.
 */
import type { Decision, ProxyRequest } from "looper-sdk";
import { detectCacheBoundary, verifyCacheSafe, type CacheBoundary } from "./detect.js";

export interface InjectOptions {
  /** Request body (decoded JSON object). */
  body: Record<string, any>;
  /** Text to append. */
  context: string;
  /** Stable id for dedupe — same key is injected at most once per conversation. */
  key: string;
  /** Detected boundary; computed if omitted. */
  boundary?: CacheBoundary;
  /** Provider hint. */
  provider?: "anthropic" | "openai" | "unknown";
  /** Storage for dedupe markers (ctx.state-like). */
  seen?: { get<T>(key: string): Promise<T | undefined>; set<T>(key: string, value: T): Promise<void> };
}

export interface InjectResult {
  decision: Decision;
  boundary: CacheBoundary;
  safe: boolean;
  injected: boolean;
  reason?: string;
}

const PASS: Decision = { action: "pass" };

/** Verify a mutation is safe and return a mutate decision, or fail-open to pass. */
export async function safeAppendContext(opts: InjectOptions): Promise<InjectResult> {
  const boundary = opts.boundary || detectCacheBoundary(opts.body, opts.provider);
  const tag = `<looper:${opts.key}>`;

  // Dedupe: never inject the same block twice into the same conversation.
  if (opts.seen) {
    const already = await opts.seen.get<boolean>(`looper:injected:${opts.key}`);
    if (already) return { decision: PASS, boundary, safe: true, injected: false, reason: "duplicate" };
  }

  const msgs: any[] = Array.isArray(opts.body.messages) ? opts.body.messages : [];
  if (!msgs.length) return { decision: PASS, boundary, safe: true, injected: false, reason: "no messages" };

  const candidate = { ...opts.body, messages: [...msgs] };
  const existing = (msgs[msgs.length - 1]?.content || "").toString();
  if (existing.includes(tag)) return { decision: PASS, boundary, safe: true, injected: false, reason: "already present" };

  // Stable position: append to the final message (never inside the cached prefix).
  const idx = candidate.messages.length - 1;
  const last = candidate.messages[idx];
  const block = `\n\n${tag}\n${opts.context}\n</looper:${opts.key}>`;
  if (typeof last.content === "string") {
    candidate.messages[idx] = { ...last, content: last.content + block };
  } else if (Array.isArray(last.content)) {
    candidate.messages[idx] = { ...last, content: [...last.content, { type: "text", text: block }] };
  } else {
    return { decision: PASS, boundary, safe: true, injected: false, reason: "unsupported content shape" };
  }

  const safe = verifyCacheSafe(boundary, candidate);
  if (!safe) return { decision: PASS, boundary, safe: false, injected: false, reason: "cache breach" };

  if (opts.seen) await opts.seen.set(`looper:injected:${opts.key}`, true);
  // bridge.py apply_request sets flow.request.text from decision.request.body
  return {
    decision: { action: "mutate", request: { body: JSON.stringify(candidate) } } as Decision,
    boundary,
    safe: true,
    injected: true,
  };
}
