import type { BridgeInbound, Decision, HookApi, FlowId, HookFn, HookType } from "@looper/sdk";
import { FlowStore } from "./flow.js";
import { DurableState } from "./state.js";
import { stripInjectedResponseBlocks } from "./workflows/channels.js";

interface RegisteredHook { type: HookType; fn: HookFn; name?: string }

export class HookRegistry {
  private hooks: RegisteredHook[] = [];
  private durable: DurableState;
  private claimSink?: (id: FlowId, decision: Decision) => void;
  private logger: (...args: unknown[]) => void = () => {};
  constructor(private flows: FlowStore, durable?: DurableState) {
    this.durable = durable || new DurableState(process.cwd() + "/.looper");
  }
  setClaimSink(fn: (id: FlowId, decision: Decision) => void) { this.claimSink = fn; }
  setLogger(fn: (...args: unknown[]) => void) { this.logger = fn; }
  /** Claim a specific flow. Shared by hook APIs and extension contexts. */
  holdFlow(id: FlowId, timeoutMs = 30_000) {
    let settled = false;
    return {
      claim: { action: "claim", timeoutMs } as Decision,
      resolve: (decision: Decision) => {
        if (settled) return;
        settled = true;
        this.claimSink?.(id, decision);
      },
    };
  }
  on(type: HookType, fn: HookFn, name?: string) {
    const entry: RegisteredHook = { type, fn, name };
    this.hooks.push(entry);
    let removed = false;
    return () => {
      if (removed) return;
      removed = true;
      this.hooks = this.hooks.filter(h => h !== entry);
    };
  }
  off(fn: HookFn) { this.hooks = this.hooks.filter(h => h.fn !== fn); }
  clear() { this.hooks = []; }
  get count() { return this.hooks.length; }
  async dispatch(msg: BridgeInbound): Promise<Decision> {
    const type = msg.t as HookType | "done";
    const id: FlowId | undefined = (msg as any).id;
    if (!id) return { action: "pass" };
    // The harness echoes assistant response text into the next request's cached
    // prefix. Remove UI-only injection blocks BEFORE hooks/LLM so cache is intact.
    if (type === "request" && (msg as any).req?.body) {
      const req = (msg as any).req;
      try {
        const body = typeof req.body === "string" ? JSON.parse(req.body) : req.body;
        if (body && Array.isArray(body.messages)) {
          const stripped = stripInjectedResponseBlocks(body, ["[A-Za-z0-9_-]+"]);
          if (stripped.removed.length) {
            req.body = typeof req.body === "string" ? JSON.stringify(stripped.body) : stripped.body;
            this.logger(`[looper] stripped ${stripped.removed.length} UI-only block(s) from request (cache preserved)`);
          }
        }
      } catch { /* malformed body: fail-open, let hooks handle it */ }
    }
    const flow = this.flows.ensure(id);
    const api: HookApi = {
      flowId: id,
      requestId: flow.requestId,
      meta: flow.meta,
      log: (m, d) => this.logger(`[looper:${type}:${id}] ${m}`, d ?? ""),
      state: {
        get: async <T>(k: string) => this.durable.get<T>(k),
        set: async <T>(k: string, v: T) => { await this.durable.set(k, v); },
      },
      hold: (timeoutMs = 30000) => this.holdFlow(id, timeoutMs),
      memo: <T>(key: string, fn: () => Promise<T> | T) => this.flows.memo<T>(id, key, fn),
    };
    let decision: Decision = { action: "pass" };
    for (const h of this.hooks) {
      if (h.type !== type) continue;
      try {
        const res = await h.fn(msg, api);
        if (res && res.action && res.action !== "pass") { decision = res as Decision; break; }
      } catch (e) {
        this.logger(`[looper] hook error (${h.name || "anon"}):`, e);
      }
    }
    // FlowState bookkeeping for Q4 / stream robustness
    if (type === "responseheaders" && decision.action === "stream") this.flows.markStreaming(id, true);
    if (type === "response_chunk") {
      const chunk = (msg as any).chunk;
      if (chunk?.done) this.flows.commit(id);
      else if (chunk?.data) {
        try { this.flows.pushChunk(id, Uint8Array.from(Buffer.from(chunk.data, "base64"))); } catch {}
      }
    }
    if (type === "response" || type === "error" || type === "done") {
      this.flows.commit(id);
      // keep briefly for late async observers, then prune
      setTimeout(() => this.flows.delete(id), 30_000).unref?.();
    }
    this.flows.prune();
    return decision;
  }
}
