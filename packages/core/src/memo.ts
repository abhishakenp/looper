/**
 * Bounded memo for extension work (router verdicts, classifications, etc).
 * Lessons from pi-ultimate: memo by exact key, cap the map, and NEVER memoise a
 * failure — a poisoned verdict can disable a guard for the whole process.
 */
export class MemoStore {
  private map = new Map<string, Promise<unknown>>();
  constructor(private cap = 32) {}

  get<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    const hit = this.map.get(key);
    if (hit) return hit as Promise<T>;
    if (this.cap > 0 && this.map.size >= this.cap) {
      const oldest = this.map.keys().next().value;
      if (oldest !== undefined) this.map.delete(oldest);
    }
    const p = Promise.resolve().then(fn).catch((e: unknown) => {
      // Failure is not a result. Drop it so the next call retries.
      if (this.map.get(key) === p) this.map.delete(key);
      throw e;
    });
    this.map.set(key, p);
    return p as Promise<T>;
  }

  has(key: string) { return this.map.has(key); }
  delete(key: string) { this.map.delete(key); }
  clear() { this.map.clear(); }
  get size() { return this.map.size; }
}
