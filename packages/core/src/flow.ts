import type { FlowId, FlowMeta } from "@looper/sdk";

export interface FlowState {
  id: FlowId;
  meta: FlowMeta;
  bufferedChunks: Uint8Array[];
  committed: boolean;
  data: Record<string, unknown>;
}

export class FlowStore {
  private flows = new Map<FlowId, FlowState>();
  get(id: FlowId): FlowState | undefined { return this.flows.get(id); }
  ensure(id: FlowId, meta?: Partial<FlowMeta>): FlowState {
    let f = this.flows.get(id);
    if (!f) {
      f = { id, meta: { id, ts: Date.now(), ...meta }, bufferedChunks: [], committed: false, data: {} };
      this.flows.set(id, f);
    }
    return f;
  }
  setData(id: FlowId, key: string, value: unknown) { this.ensure(id).data[key] = value; }
  getData<T>(id: FlowId, key: string): T | undefined { return this.ensure(id).data[key] as T | undefined; }
  delete(id: FlowId) { this.flows.delete(id); }
}
