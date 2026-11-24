/**
 * One wake per generation, injected into the parent harness at the next safe
 * request boundary. Never interrupt an in-flight turn (looper cannot rewrite a
 * provider request the harness already sent). Mirrors Liza's `fanout-complete`
 * follow-up discipline: idempotent by generation, suppressed while busy.
 */
export interface Wake { generation: number; text: string; at: number }

export class WakeBus {
  private queue: Wake[] = [];
  private seen = new Set<number>();
  private busy = false;

  /** Queue at most one wake per generation. Returns false for duplicates. */
  emit(generation: number, text: string): boolean {
    if (this.seen.has(generation)) return false;
    this.seen.add(generation);
    this.queue.push({ generation, text, at: Date.now() });
    return true;
  }

  setBusy(v: boolean) { this.busy = v; }

  /** Drain at a request boundary; returns [] while the parent turn is busy. */
  drain(): Wake[] {
    if (this.busy || !this.queue.length) return [];
    const out = this.queue;
    this.queue = [];
    return out;
  }

  get pending() { return this.queue.length; }
  clear() { this.queue = []; this.seen.clear(); }
}
