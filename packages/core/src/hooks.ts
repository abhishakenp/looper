import type { BridgeInbound, Decision, HookApi, FlowId, HookFn, HookType } from "@looper/sdk";
import { FlowStore } from "./flow.js";

interface RegisteredHook { type: HookType; fn: HookFn; name?: string }

export class HookRegistry {
  private hooks: RegisteredHook[] = [];
  constructor(private flows: FlowStore) {}
  on(type: HookType, fn: HookFn, name?: string) { this.hooks.push({ type, fn, name }); return () => this.off(fn); }
  off(fn: HookFn) { this.hooks = this.hooks.filter(h => h.fn !== fn); }
  clear() { this.hooks = []; }
  async dispatch(msg: BridgeInbound): Promise<Decision> {
    const type = msg.t as HookType;
    const id: FlowId | undefined = (msg as any).id;
    if (!id) return { action: "pass" };
    const flow = this.flows.ensure(id);
    const api: HookApi = {
      flowId: id,
      meta: flow.meta,
      log: (m, d) => console.error(`[looper:${type}:${id}] ${m}`, d ?? ""),
      state: {
        get: async <T>(k: string) => this.flows.getData<T>(id, k),
        set: async <T>(k: string, v: T) => { this.flows.setData(id, k, v); },
      },
    };
    for (const h of this.hooks) {
      if (h.type !== type) continue;
      try {
        const res = await h.fn(msg, api);
        if (res && res.action && res.action !== "pass") return res as Decision;
      } catch (e) {
        console.error(`[looper] hook error (${h.name || "anon"}):`, e);
      }
    }
    return { action: "pass" };
  }
}
