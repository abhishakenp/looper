/**
 * SSE tool-call accumulation and deterministic rewriting.
 *
 * Validated against 8 REAL `subagent` tool calls captured from opencode traffic
 * (s_1795464246631_dv8u3s.ndjson): function.name and function.arguments arrive
 * split across `delta.tool_calls` chunks, so detection must accumulate before
 * deciding. The harness executes the call while chunks stream — a rewrite must
 * happen at chunk level (return a mutated chunk) BEFORE the final chunk is released.
 */
import { detectSubagentTools } from "./detect.js";

export interface ToolCallAccumulatorState {
  calls: Map<number, { id?: string; name: string; arguments: string }>;
  finished: boolean;
}

export class ToolCallAccumulator {
  private state: ToolCallAccumulatorState = { calls: new Map(), finished: false };

  reset() { this.state = { calls: new Map(), finished: false }; }

  /** Feed one decoded SSE chunk (a parsed `data:` object). */
  push(chunk: any) {
    if (this.state.finished) return;
    for (const choice of chunk?.choices || []) {
      const delta = choice.delta || choice.message || {};
      for (const tc of delta.tool_calls || []) {
        const i = tc.index ?? 0;
        const c = this.state.calls.get(i) || { name: "", arguments: "" };
        if (tc.id) c.id = tc.id;
        const fn = tc.function || {};
        if (typeof fn.name === "string") c.name += fn.name;
        if (typeof fn.arguments === "string") c.arguments += fn.arguments;
        this.state.calls.set(i, c);
      }
      if (choice.finish_reason) this.state.finished = true;
    }
  }

  get finished() { return this.state.finished; }
  get calls() { return [...this.state.calls.entries()].map(([index, c]) => ({ index, ...c })); }

  /** Deterministic subagent detection from accumulated call names. */
  subagentCalls() {
    return this.calls.filter(c => {
      const n = c.name.toLowerCase();
      return ["subagent", "spawn", "spawn_agent", "agent_spawn", "delegate", "delegate_task", "task"].includes(n);
    });
  }

  /**
   * Inject a context string into a subagent call's `arguments` JSON without
   * changing any other field. Returns the rewritten arguments string or null.
   * The caller must replace the chunk that carried the FINAL argument fragment.
   */
  rewriteArguments(index: number, context: string): string | null {
    const c = this.state.calls.get(index);
    if (!c || !c.arguments) return null;
    try {
      const args = JSON.parse(c.arguments);
      if (!args || typeof args !== "object" || Array.isArray(args)) return null;
      const key = "looper_context";
      if (typeof args[key] === "string" && args[key].includes(context)) return null;
      args[key] = typeof args[key] === "string" ? `${args[key]}\n${context}` : context;
      return JSON.stringify(args);
    } catch { return null; }
  }

  /** Parse SSE text into decoded chunks (helper for replay/tests). */
  static parseSse(body: string): any[] {
    const out: any[] = [];
    for (const line of body.split("\n")) {
      const l = line.trim();
      if (l.startsWith("data: ") && l !== "data: [DONE]") {
        try { out.push(JSON.parse(l.slice(6))); } catch {}
      }
    }
    return out;
  }

  /** Replace the final argument fragment of a tool call in SSE text. */
  static replaceArgumentsInSse(body: string, index: number, oldArgs: string, newArgs: string): string {
    if (!oldArgs) return body;
    const escaped = oldArgs.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    return body.replace(escaped, newArgs);
  }

  /**
   * When the accumulated arguments finally parse as JSON, compute the replacement
   * for the CURRENT (last) fragment. Earlier fragments already streamed and are
   * unchanged; we append our field before the closing brace and emit only the
   * remainder. Returns null until the arguments are complete.
   */
  completeRewrite(index: number, context: string): { current: string; replacement: string; prefixLen: number } | null {
    const c = this.state.calls.get(index);
    if (!c || !c.arguments) return null;
    let parsed: any;
    try { parsed = JSON.parse(c.arguments); } catch { return null; }
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const key = "looper_context";
    if (typeof parsed[key] === "string" && parsed[key].includes(context)) return null;
    parsed[key] = typeof parsed[key] === "string" ? `${parsed[key]}\n${context}` : context;
    const full = JSON.stringify(parsed);
    const prefixLen = this.prefixLengths.get(index) || 0;
    if (prefixLen >= full.length) return null;
    const current = this.currentFragments.get(index) || "";
    return { current, replacement: full.slice(prefixLen), prefixLen };
  }

  private prefixLengths = new Map<number, number>();
  private currentFragments = new Map<number, string>();

  /** Feed one chunk while tracking which part of a tool call's args was streamed now. */
  pushTracked(chunk: any) {
    const before = new Map<number, number>();
    for (const [i, c] of this.state.calls) before.set(i, c.arguments.length);
    this.push(chunk);
    for (const choice of chunk?.choices || []) {
      for (const tc of choice.delta?.tool_calls || []) {
        const i = tc.index ?? 0;
        const frag = typeof tc.function?.arguments === "string" ? tc.function.arguments : "";
        this.currentFragments.set(i, frag);
        this.prefixLengths.set(i, before.get(i) || 0);
      }
    }
  }

  /** Replace `"arguments":"<current>"` in raw SSE text with the rewritten fragment. */
  static rewriteRawArguments(body: string, current: string, replacement: string): string {
    if (!current) return body;
    const from = `"arguments":${JSON.stringify(current)}`;
    const to = `"arguments":${JSON.stringify(replacement)}`;
    return body.includes(from) ? body.replace(from, to) : body;
  }
}
