import type { FlowId, FlowMeta } from "@looper/sdk";

export interface FlowState {
  id: FlowId;
  requestId: string;
  meta: FlowMeta;
  bufferedChunks: Uint8Array[];
  chunkCount: number;
  streaming: boolean;
  committed: boolean;
  data: Record<string, unknown>;
  memos: Map<string, Promise<unknown>>;
}

export class FlowStore {
  private flows = new Map<FlowId, FlowState>();
  get(id: FlowId): FlowState | undefined { return this.flows.get(id); }
  ensure(id: FlowId, meta?: Partial<FlowMeta>): FlowState {
    let f = this.flows.get(id);
    if (!f) {
      const requestId = (meta as any)?.requestId || `req_${id}`;
      f = { id, requestId, meta: { id, ts: Date.now(), ...meta }, bufferedChunks: [], chunkCount: 0, streaming: false, committed: false, data: {}, memos: new Map() };
      this.flows.set(id, f);
    }
    return f;
  }
  setData(id: FlowId, key: string, value: unknown) { this.ensure(id).data[key] = value; }
  getData<T>(id: FlowId, key: string): T | undefined { return this.ensure(id).data[key] as T | undefined; }
  markStreaming(id: FlowId, streaming = true) { this.ensure(id).streaming = streaming; }
  pushChunk(id: FlowId, chunk: Uint8Array) { const f = this.ensure(id); f.bufferedChunks.push(chunk); f.chunkCount++; }
  commit(id: FlowId) { const f = this.ensure(id); f.committed = true; }
  async memo<T>(id: FlowId, key: string, fn: () => Promise<T> | T): Promise<T> {
    const f = this.ensure(id);
    if (f.memos.has(key)) return f.memos.get(key) as Promise<T>;
    const p = Promise.resolve().then(fn);
    f.memos.set(key, p);
    return p;
  }
  delete(id: FlowId) { this.flows.delete(id); }
  prune(maxAgeMs = 5 * 60_000) {
    const now = Date.now();
    for (const [id, f] of this.flows) if (f.committed && now - f.meta.ts > maxAgeMs) this.flows.delete(id);
  }
}
