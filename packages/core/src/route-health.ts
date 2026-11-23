/**
 * Per-model health + conversation→model pinning, held on globalThis so every
 * cache-busted extension module instance sees the same map.
 *
 * pi-ultimate lessons: one ANCHORED 429 regex (a stack trace `x.ts:429:7`
 * must not halve capacity), dead/throttled TTLs, and pin a conversation to
 * the model of its first turn — a provider switch loses a 30k+ token cache.
 */
export interface HealthEntry { state: "ok" | "throttled" | "dead"; until: number; reason?: string }

export interface RouteHealthOptions {
  throttledMs?: number; // default 5 min
  deadMs?: number;      // default 6 h
  log?: (msg: string) => void;
}

const SYMBOL = Symbol.for("looper.routeHealth");

interface Shared {
  health: Map<string, HealthEntry>;
  pins: Map<string, string>;
}

function shared(): Shared {
  const g = globalThis as any;
  if (!g[SYMBOL]) g[SYMBOL] = { health: new Map(), pins: new Map() } satisfies Shared;
  return g[SYMBOL] as Shared;
}

/** Anchored: a bare "429" inside a path/stack trace is not a rate limit. */
export const RATE_LIMITED = /^\s*(?:HTTP\s*)?429\b|\bstatus(?:Code)?\s*[:=]\s*["']?429\b|\b429\s+(?:too many|rate limit)/i;

export class RouteHealth {
  private opts: Required<Pick<RouteHealthOptions, "throttledMs" | "deadMs">> & RouteHealthOptions;
  private state: Shared;
  constructor(opts: RouteHealthOptions = {}) {
    this.opts = { throttledMs: 300_000, deadMs: 21_600_000, ...opts };
    this.state = shared();
  }

  /** Feed an HTTP status or a text blob. Returns true if a rate limit was observed. */
  note(model: string, statusOrText: number | string): boolean {
    const is429 = typeof statusOrText === "number"
      ? statusOrText === 429
      : RATE_LIMITED.test(statusOrText);
    if (!is429) return false;
    this.state.health.set(model, { state: "throttled", until: Date.now() + this.opts.throttledMs, reason: "429" });
    this.opts.log?.(`[route] ${model} throttled for ${this.opts.throttledMs}ms`);
    return true;
  }

  markDead(model: string, reason = "dead") {
    this.state.health.set(model, { state: "dead", until: Date.now() + this.opts.deadMs, reason });
  }

  available(model: string): boolean {
    const e = this.state.health.get(model);
    if (!e) return true;
    if (Date.now() >= e.until) { this.state.health.delete(model); return true; }
    return e.state === "ok";
  }

  /** Models in the given order, with unavailable ones removed. */
  filter(models: string[]): string[] { return models.filter(m => this.available(m)); }

  /** Pin a conversation to the model that served its first turn (cache stability). */
  pin(conversationId: string, model: string): string {
    if (!this.state.pins.has(conversationId)) this.state.pins.set(conversationId, model);
    return this.state.pins.get(conversationId)!;
  }

  pinned(conversationId: string): string | undefined { return this.state.pins.get(conversationId); }

  /** Pick: keep the existing pin if still healthy, otherwise pin the first available. */
  pick(conversationId: string, models: string[]): string | undefined {
    const current = this.pinned(conversationId);
    if (current && this.available(current) && models.includes(current)) return current;
    const next = this.filter(models)[0];
    if (!next) return undefined;
    if (current !== next) {
      this.state.pins.delete(conversationId);
      return this.pin(conversationId, next);
    }
    return next;
  }

  snapshot() {
    return {
      health: Object.fromEntries([...this.state.health].map(([k, v]) => [k, { ...v }])),
      pins: Object.fromEntries(this.state.pins),
    };
  }

  reset() { this.state.health.clear(); this.state.pins.clear(); }
}
