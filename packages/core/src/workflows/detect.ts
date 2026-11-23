/**
 * Deterministic helpers for looper workflows.
 * All operate on bridge-decoded request/response data — no LLM calls, no pixel, no branching on harness identity.
 */

export interface ToolCall {
  id?: string;
  name: string;
  arguments: string; // raw JSON string, accumulated across SSE chunks
  argsParsed?: Record<string, unknown>;
}

export interface CacheBoundary {
  provider: "anthropic" | "openai" | "unknown";
  boundaryIndex: number;      // first NON-cached message index
  cachedPrefixHash: string;   // hash of messages[0..boundaryIndex) AND tools (both are cache-key inputs)
  cacheControlPresent: boolean;
  cacheKey: "anthropic:cache_control" | "openai:prompt_cache_key" | "none";
  promptCacheKey?: string;    // session-scoped key value, when present
}

const SUBAGENT_NAMES = new Set([
  "subagent", "spawn", "spawn_agent", "spawnagent", "agent_spawn", "task", "task_tool", "delegate", "delegate_task", "agent",
]);

function hashPrefix(obj: unknown): string {
  // FNV-1a over canonical JSON — fast, deterministic, no crypto dep
  const s = JSON.stringify(obj);
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/** Parse body that may be a JSON object, a JSON string, or an SSE stream of `data: {...}` chunks. */
export function parseBody(raw: unknown): any {
  if (typeof raw !== "string") return raw;
  const t = raw.trim();
  if (t.startsWith("{") || t.startsWith("[")) {
    try { return JSON.parse(t); } catch {}
  }
  if (t.includes("data: ")) {
    // SSE stream: extract tool_calls and content deltas from all chunks
    const chunks: any[] = [];
    for (const line of t.split("\n")) {
      const l = line.trim();
      if (l.startsWith("data: ")) {
        try { chunks.push(JSON.parse(l.slice(6))); } catch {}
      }
    }
    return { __sse: true, chunks };
  }
  return raw;
}

/** Find subagent tool DECLARATIONS in a request's `tools[]` array. Fully deterministic. */
export function detectSubagentTools(requestBody: unknown): Array<{ name: string; description?: string; schema?: any }> {
  const b = parseBody(requestBody);
  if (!b || b.__sse) return [];
  const tools = b.tools || b.functions || [];
  const found: Array<{ name: string; description?: string; schema?: any }> = [];
  for (const t of tools) {
    const fn = t.function || t;
    const name: string = (fn.name || "").toString();
    if (SUBAGENT_NAMES.has(name.toLowerCase())) {
      found.push({ name, description: fn.description, schema: fn.parameters || fn.input_schema });
    }
  }
  return found;
}

/** Accumulate tool calls from a response body (plain JSON or SSE stream). */
export function extractToolCalls(responseBody: unknown): ToolCall[] {
  const b = parseBody(responseBody);
  const calls = new Map<number, ToolCall>();
  const ingest = (tc: any, idx: number) => {
    let c = calls.get(idx);
    if (!c) { c = { name: "", arguments: "" }; calls.set(idx, c); }
    if (tc.id) c.id = tc.id;
    const fn = tc.function || {};
    if (fn.name) c.name += fn.name;
    if (fn.arguments) c.arguments += fn.arguments;
    if (typeof tc.name === "string") c.name += tc.name;
  };
  if (b && b.__sse) {
    for (const ch of b.chunks) {
      for (const choice of ch.choices || []) {
        const delta = choice.delta || choice.message || {};
        for (const tc of delta.tool_calls || []) ingest(tc, tc.index ?? 0);
        // Anthropic-style tool_use blocks
        for (const block of delta.content || []) {
          if (block.type === "tool_use") {
            const c: ToolCall = { id: block.id, name: block.name, arguments: JSON.stringify(block.input || {}) };
            calls.set(calls.size, c);
          }
        }
      }
    }
  } else if (b && b.choices) {
    const msg = b.choices[0]?.message || {};
    for (const tc of msg.tool_calls || []) ingest(tc, tc.index ?? 0);
  }
  const out = [...calls.values()].filter(c => c.name);
  for (const c of out) {
    try { c.argsParsed = JSON.parse(c.arguments); } catch {}
  }
  return out;
}

/** Detect cache boundary from a request body. Anthropic uses cache_control; OpenAI conservative. */
export function detectCacheBoundary(requestBody: unknown, providerHint?: "anthropic" | "openai" | "unknown"): CacheBoundary {
  const b = parseBody(requestBody);
  const msgs: any[] = (b && !b.__sse && (b.messages || b.system ? b.messages || [] : [])) || [];
  const provider: "anthropic" | "openai" | "unknown" = providerHint || detectProvider(b);
  let boundaryIndex = 0;
  let cacheControlPresent = false;
  let cacheKey: CacheBoundary["cacheKey"] = "none";
  let promptCacheKey: string | undefined;

  if (b && !b.__sse && typeof b.prompt_cache_key === "string") {
    // OpenAI / OpenRouter auto prefix cache: key = session id, prefix = system + tools + all but last message.
    // Everything before the LAST message is cached; the last message is the variable tail.
    promptCacheKey = b.prompt_cache_key;
    cacheKey = "openai:prompt_cache_key";
    boundaryIndex = Math.max(0, msgs.length - 1);
  } else if (provider === "anthropic") {
    for (let i = 0; i < msgs.length; i++) {
      const m = msgs[i];
      const hasCC = m.cache_control || (Array.isArray(m.content) && m.content.some((c: any) => c.cache_control));
      if (hasCC) { cacheControlPresent = true; boundaryIndex = i + 1; cacheKey = "anthropic:cache_control"; break; }
    }
    if (!cacheControlPresent) {
      boundaryIndex = msgs.length && msgs[0].role === "system" ? 1 : 0;
    }
  } else {
    boundaryIndex = msgs.length && msgs[0].role === "system" ? 1 : 0;
    for (let i = boundaryIndex; i < msgs.length; i++) {
      if (msgs[i].role === "user") { boundaryIndex = i + 1; break; }
    }
  }
  // Tools are part of the cached prefix for both providers — include in hash
  const prefix = { messages: msgs.slice(0, boundaryIndex), tools: b && !b.__sse ? b.tools : undefined };
  return {
    provider,
    boundaryIndex,
    cachedPrefixHash: hashPrefix(prefix),
    cacheControlPresent,
    cacheKey,
    promptCacheKey,
  };
}

function detectProvider(b: any): "anthropic" | "openai" | "unknown" {
  if (!b || b.__sse) return "unknown";
  if (b.system && Array.isArray(b.messages)) return "anthropic";
  if (b.messages && b.messages.some((m: any) => Array.isArray(m.content) && m.content.some((c: any) => c.cache_control))) return "anthropic";
  if (b.model && (b.model.includes("gpt") || b.model.includes("o1") || b.model.includes("o3"))) return "openai";
  return "unknown";
}

/** Verify cached prefix unchanged after a mutation. Returns true if safe.
 *  The cached prefix is defined by the ORIGINAL boundary indices — we must hash
 *  the same indices in the mutated request, not recompute a new boundary. */
export function verifyCacheSafe(before: CacheBoundary, mutatedRequest: unknown): boolean {
  const m = parseBody(mutatedRequest);
  if (!m || m.__sse || !Array.isArray(m.messages)) return false;
  const prefix = { messages: m.messages.slice(0, before.boundaryIndex), tools: m.tools };
  return hashPrefix(prefix) === before.cachedPrefixHash;
}
