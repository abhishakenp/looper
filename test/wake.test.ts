import { test, expect } from "bun:test";
import { WakeBus } from "../packages/core/src/wake.js";
import { safeAppendContext } from "../packages/core/src/workflows/inject.js";
import { verifyCacheSafe, detectCacheBoundary } from "../packages/core/src/workflows/detect.js";

test("one wake per generation and suppressed while busy", () => {
  const bus = new WakeBus();
  expect(bus.emit(1, "plan settled")).toBe(true);
  expect(bus.emit(1, "duplicate")).toBe(false);
  expect(bus.emit(2, "second")).toBe(true);
  expect(bus.pending).toBe(2);
  bus.setBusy(true);
  expect(bus.drain()).toEqual([]);
  bus.setBusy(false);
  expect(bus.drain().map(w => w.generation)).toEqual([1, 2]);
  expect(bus.pending).toBe(0);
});

test("injected wake is cache-safe at the next request boundary", async () => {
  const body: any = {
    model: "gpt-6-luna",
    messages: [{ role: "system", content: "sys" }, { role: "user", content: "u1" }, { role: "assistant", content: "a1" }, { role: "user", content: "u2" }],
    prompt_cache_key: "sess",
  };
  const boundary = detectCacheBoundary(body);
  const seen = new Map<string, any>();
  const store = { get: async <T>(k: string) => seen.get(k) as T, set: async (k: string, v: any) => { seen.set(k, v); } };
  const r = await safeAppendContext({ body, key: "wake", context: "[looper wake 1] plan settled", seen: store as any });
  expect(r.injected).toBe(true);
  const mutated = JSON.parse((r.decision as any).request.body);
  expect(verifyCacheSafe(boundary, mutated)).toBe(true);
  const r2 = await safeAppendContext({ body: mutated, key: "wake", context: "[looper wake 2] again", seen: store as any });
  expect(r2.injected).toBe(false);
  expect(r2.reason).toBe("duplicate");
});
