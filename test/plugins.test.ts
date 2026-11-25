import { expect, test } from "bun:test";
import { MemoStore } from "../packages/core/src/memo";
import { WakeBus } from "../packages/core/src/wake";
import { WorkerScheduler } from "../packages/core/src/scheduler";
import { detectCacheBoundary, verifyCacheSafe } from "../packages/core/src/workflows/detect";

const extension = async (name: string) => import(new URL(`../examples/extensions/${name}.ts`, import.meta.url).href);

const PLUGINS = [
  "subagent-augmentation",
  "pixel-brief",
  "chaining",
  "fanout",
  "two-channel",
  "router",
  "liza-deterministic",
];

/** Minimal ExtensionContext stand-in. No network, no child processes. */
function fakeCtx(config: Record<string, any> = {}) {
  const stateMap = new Map<string, any>();
  const hooks: Record<string, any[]> = {};
  const disposers: Array<() => void> = [];
  const memos = new MemoStore(32);
  const wake = new WakeBus();
  const ctx = {
    on: (t: string, fn: any, _name?: string) => {
      (hooks[t] ||= []).push(fn);
      return () => {};
    },
    log: () => {},
    state: {
      get: async <T>(k: string) => stateMap.get(k) as T | undefined,
      set: async <T>(k: string, v: T) => { stateMap.set(k, v); },
    },
    memo: <T>(k: string, fn: () => Promise<T> | T) => memos.get(k, fn),
    proc: {
      cwd: process.cwd(),
      spawn: async () => ({
        child: {
          pid: 42,
          stdout: null,
          once: (ev: string, cb: (code: number) => void) => { if (ev === "exit") queueMicrotask(() => cb(0)); },
        },
        kill: () => {},
      }),
    },
    effect: (d: () => void) => { disposers.push(d); },
    config,
    wake,
    flows: {},
    requestId: () => "req_test",
    hold: () => ({ claim: { action: "claim" }, resolve: () => {} }),
    resources: { agents: [], skills: [], prompts: [] },
  };
  return { ctx, hooks, disposers, stateMap, wake };
}

// ── module loadability ────────────────────────────────────────────────────────

for (const name of PLUGINS) {
  test(`${name}: default export is a loadable factory`, async () => {
    const mod: any = await extension(name);
    expect(typeof mod.default, `${name} must default-export a function`).toBe("function");
  });
}

test("every plugin except the CLI-driven Liza plugin mounts with a fake ctx", async () => {
  for (const name of PLUGINS.filter((n) => n !== "liza-deterministic")) {
    const mod: any = await extension(name);
    const { ctx, hooks, disposers } = fakeCtx();
    mod.default(ctx);
    expect(Object.keys(hooks).length, `${name} registered at least one hook`).toBeGreaterThan(0);
    for (const d of disposers) d();
  }
});

// ── chaining: constant guidance, dedupe, cache safety ────────────────────────

test("chaining guidance is constant and duplicate keys are detected", async () => {
  const { buildGuidance, isDuplicateGuidance, guidanceFromConfig } = await extension("chaining");
  const a = buildGuidance(["plan", "verify"]);
  expect(a).toBe(buildGuidance(["plan", "verify"]));
  expect(a).toContain("1. plan");
  expect(a).toContain("2. verify");
  expect(a).not.toMatch(/\d{10,}/); // no timestamp/nonce in the cached tail
  expect(guidanceFromConfig({ steps: ["x"] })).toBe(buildGuidance(["x"]));
  expect(guidanceFromConfig({})).toContain("1. plan");
  expect(isDuplicateGuidance([], "k")).toBe(false);
  expect(isDuplicateGuidance(["k"], "k")).toBe(true);
  expect(isDuplicateGuidance(["looper:injected:k"], "k")).toBe(true);
  expect(isDuplicateGuidance(["chaining-guidance"])).toBe(true);
});

test("chaining appends once, after the cache boundary, without mutating the original", async () => {
  const mod: any = await extension("chaining");
  const { ctx, hooks } = fakeCtx();
  mod.default(ctx);
  const body: any = {
    model: "gpt-test",
    messages: [{ role: "system", content: "sys" }, { role: "user", content: "u1" }],
    prompt_cache_key: "sess",
  };
  const before = JSON.stringify(body);
  const dec = await hooks.request[0]({ req: { body } });
  expect(dec.action).toBe("mutate");
  const mutated = JSON.parse(dec.request.body);
  expect(mutated.messages[mutated.messages.length - 1].content).toContain("[looper chain]");
  expect(verifyCacheSafe(detectCacheBoundary(body), mutated)).toBe(true);
  expect(JSON.stringify(body)).toBe(before); // caller's object untouched
  const again = await hooks.request[0]({ req: { body: mutated } });
  expect(again.action).toBe("pass"); // dedupe by key
});

// ── wake generation idempotence + fanout stage chain ─────────────────────────

test("wake is idempotent per generation and formatWake is stable", async () => {
  const { formatWake } = await extension("fanout");
  const settled: any = {
    jobId: "job_1", generation: 7, ok: 2, failed: 0, skipped: 0, aborted: 0, total: 2, durationMs: 5,
  };
  const text = formatWake(7, settled);
  expect(text).toBe(formatWake(7, settled));
  const bus = new WakeBus();
  expect(bus.emit(7, text)).toBe(true);
  expect(bus.emit(7, "duplicate")).toBe(false);
  expect(bus.emit(8, text)).toBe(true);
  expect(bus.drain().map((w) => w.generation)).toEqual([7, 8]);
});

test("fanout stage chain enforces dependency order through the real scheduler", async () => {
  const { buildStageChain } = await extension("fanout");
  const chain = buildStageChain(["a", "b", "c"]);
  expect(chain[0].dependsOn).toBeUndefined();
  expect(chain[1].dependsOn).toEqual(["a"]);
  expect(chain[2].dependsOn).toEqual(["b"]);

  const order: string[] = [];
  const scheduler = new WorkerScheduler({
    maxParallel: 4,
    log: () => {},
    execute: async (c) => { order.push(c.task.taskId); return { status: "done" }; },
  });
  const job = scheduler.submit(chain);
  const settled = await job.done;
  expect(settled.ok).toBe(3);
  expect(order).toEqual(["a", "b", "c"]);
});

test("fanout request marker submits and emits exactly one wake on settle", async () => {
  const mod: any = await extension("fanout");
  const { ctx, hooks, wake, disposers } = fakeCtx();
  mod.default(ctx);
  const dec = hooks.request[0]({
    req: { body: 'user says LOOPER_FANOUT: {"stages":["s1","s2"]}' },
  });
  expect(dec.action).toBe("pass");
  await new Promise((r) => setTimeout(r, 20));
  expect(wake.pending).toBe(1);
  expect(wake.drain()[0].text).toContain("[plan ");
  for (const d of disposers) d();
});

// ── other deterministic helpers ──────────────────────────────────────────────

test("pixel-brief deadline and coverage gate are deterministic", async () => {
  const { withDeadline, coverageGate, textHash } = await extension("pixel-brief");
  const never = new Promise<string>(() => {});
  expect(await withDeadline(never, 5, "fallback")).toBe("fallback");
  expect(await withDeadline(Promise.resolve("ok"), 100, "fallback")).toBe("ok");
  expect(textHash("abc")).toBe(textHash("abc"));
  expect(textHash("abc")).not.toBe(textHash("abd"));
  expect(coverageGate({ via: "decide", probabilities: { covered: 0.8 } }, 0.6)).toBe(true);
  expect(coverageGate({ via: "decide", probabilities: { covered: 0.2 } }, 0.6)).toBe(false);
  expect(coverageGate({ via: "deadline", probabilities: {} }, 0.6)).toBe(false);
});

test("subagent-augmentation signature helpers are stable and content-addressed", async () => {
  const { signatureHash, toolSignatureKey, contextBlock, resultBlock } = await extension("subagent-augmentation");
  const body = { tools: [{ name: "Task", description: "spawn agent", parameters: { prompt: {} } }] };
  expect(toolSignatureKey(body)).toBe(toolSignatureKey(body));
  expect(toolSignatureKey(body)).not.toBe(toolSignatureKey({ tools: [{ name: "Bash" }] }));
  expect(signatureHash("x")).toMatch(/^[0-9a-f]{8}$/);
  expect(contextBlock(["Task"])).toBe(contextBlock(["Task"]));
  expect(contextBlock(["Task"])).toContain("Task");
  expect(resultBlock({ jobId: "j", generation: 1, ok: 1, failed: 0, skipped: 0, aborted: 0, total: 1, durationMs: 1 } as any,
    [{ taskId: "t", status: "done" }])).toContain("t=done");
});

test("router helpers hash exact text and read the model without network", async () => {
  const { verdictKey, modelFromBody } = await extension("router");
  expect(verdictKey("abc")).toBe(verdictKey("abc"));
  expect(verdictKey("abc")).not.toBe(verdictKey("abd"));
  expect(modelFromBody(JSON.stringify({ model: "m1" }))).toBe("m1");
  expect(modelFromBody("data: {...}")).toBeUndefined();
});

test("liza deterministic stage helpers fix the empty-completed case", async () => {
  const { resolveEntry, completedStages, nextUnfinishedStage } = await extension("liza-deterministic");
  expect(resolveEntry({}, { LOOPER_LIZA_ENTRY: "functional-spec" })).toBe("functional-spec");
  expect(resolveEntry({ entry: "nonsense" })).toBe("general-objective");
  const chain = ["plan", "code"];
  expect(nextUnfinishedStage(chain, [])).toBe("plan");
  expect(nextUnfinishedStage(chain, ["plan"])).toBe("code");
  expect(completedStages(chain, [{ role_pair: "plan", status: "PLAN_APPROVED" }])).toEqual(["plan"]);
});
