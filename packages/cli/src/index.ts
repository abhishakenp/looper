#!/usr/bin/env bun
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { BridgeServer, FlowStore, HookRegistry, spawnProxied, resolveHarnessBinary, DurableState, LooperDurableRuntime } from "@looper/core";
import type { BridgeInbound, Decision, HookFn, HookType } from "@looper/sdk";

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: looper <harness> [args...] | looper trace tail|show [file]");
  process.exit(1);
}

if (args[0] === "trace") {
  const sub = args[1] || "tail";
  const traceDir = path.join(os.homedir(), ".looper", "traces");
  const file = args[2] || (() => { try { const fs2 = fs.readdirSync(traceDir).filter(f=>f.endsWith(".ndjson")).sort(); return path.join(traceDir, fs2[fs2.length-1]||""); } catch { return ""; } })();
  if (!file || !fs.existsSync(file)) { console.error("No trace file found"); process.exit(1); }
  if (sub === "show") { console.log(fs.readFileSync(file, "utf8")); process.exit(0); }
  // tail
  let off = 0;
  const read = () => { try { const s = fs.statSync(file); if (s.size > off) { const fd = fs.openSync(file,"r"); const buf = Buffer.alloc(s.size-off); fs.readSync(fd,buf,0,buf.length,off); fs.closeSync(fd); process.stdout.write(buf.toString("utf8")); off=s.size; } } catch {} };
  read(); fs.watchFile(file,{interval:500},read);
  process.on("SIGINT",()=>process.exit(0));
  await new Promise(()=>{});
}

const harness = args[0];
const rest = args.slice(1);
const cwd = process.cwd();
const sessionId = `s_${Date.now()}_${Math.random().toString(36).slice(2,8)}`;
const runDir = path.join(os.homedir(), ".looper", "run");
const socketPath = path.join(runDir, `${sessionId}.sock`);
const bridgeScript = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../bridge/bridge.py");
const traceDir = path.join(os.homedir(), ".looper", "traces");
const traceFile = path.join(traceDir, `${sessionId}.ndjson`);
const logFile = path.join(runDir, `${sessionId}.log`);

await fs.promises.mkdir(traceDir, { recursive: true });
await fs.promises.mkdir(runDir, { recursive: true });
const log = (...args: unknown[]) => {
  try { fs.appendFileSync(logFile, args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ") + "\n"); } catch {}
};

const flows = new FlowStore();
const durable = new DurableState(path.join(cwd, ".looper"));
const runtime = new LooperDurableRuntime(path.join(cwd, ".looper"));
const hooks = new HookRegistry(flows, durable);
hooks.setLogger(log);
const reconciled = await runtime.reconcile(sessionId);
if (reconciled.crashedFlows.length) log(`[looper] reconciled ${reconciled.crashedFlows.length} crashed flow(s)`);

function redact(obj: any): any {
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(redact);
  const out: any = {};
  for (const [k, v] of Object.entries(obj)) {
    if (/authorization|cookie|token|api[-_]?key|secret|password/i.test(k)) out[k] = "[REDACTED]";
    else out[k] = redact(v);
  }
  return out;
}
function trace(obj: unknown) {
  try { fs.appendFileSync(traceFile, JSON.stringify(redact(obj)) + "\n"); } catch {}
}

const harnessArgs = Object.freeze([...rest]);
const harnessBin = resolveHarnessBinary(harness);
const harnessIntercept = path.basename(harnessBin);
const procCtx = {
  harness,
  args: harnessArgs,
  cwd,
  env: { ...process.env } as Record<string, string | undefined>,
  bin: harnessBin,
  intercept: harnessIntercept,
  bridgeScript,
  socketPath,
  spawn: (overrides: any = {}) => spawnProxied({
    harness,
    args: [...harnessArgs],
    cwd,
    bridgeScript,
    socketPath,
    intercept: harnessIntercept,
    log,
    ...overrides,
    env: { ...process.env, ...(overrides.env || {}) },
  }),
  spawnProxied,
};

// Load extensions from global and project dirs
const extDirs = [
  path.join(os.homedir(), ".looper", "extensions"),
  path.join(cwd, ".looper", "extensions"),
];
async function loadExtensions() {
  hooks.clear();
  for (const dir of extDirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter(x => x.endsWith(".ts") || x.endsWith(".js") || x.endsWith(".mjs"))) {
      try {
        const mod = await import(path.join(dir, f) + `?t=${Date.now()}`);
        const ext = mod.default || mod.extension || mod;
        const ctx = { on: (t: HookType, fn: HookFn, name?: string) => hooks.on(t, fn, name || f), flows, log, state: durable, proc: procCtx };
        if (typeof ext === "function") {
          await ext(ctx);
        } else if (ext && typeof ext.setup === "function") {
          await ext.setup(ctx);
        }
        log(`[looper] loaded extension ${f}`);
      } catch (e) {
        log(`[looper] extension load failed ${f}:`, e);
      }
    }
  }
}
await loadExtensions();

// hot reload
for (const dir of extDirs) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    let t: any = null;
    fs.watch(dir, () => { clearTimeout(t); t = setTimeout(() => { log("[looper] reloading extensions"); loadExtensions().catch(log); }, 200); });
  } catch {}
}

const server = new BridgeServer(socketPath, async (msg: BridgeInbound) => {
  const id = (msg as any).id as string | undefined;
  if (id) runtime.setSnapshot(`flow:${id}:last`, { t: msg.t, status: msg.t, ts: Date.now(), requestId: `req_${id}` }).catch(() => {});
  trace({ ts: Date.now(), dir: "in", id, requestId: id ? `req_${id}` : undefined, msg });
  const decision = await hooks.dispatch(msg);
  trace({ ts: Date.now(), dir: "out", id, requestId: id ? `req_${id}` : undefined, decision });
  return decision;
});
hooks.setClaimSink((id, decision) => {
  trace({ ts: Date.now(), dir: "out", id, decision, async: true });
  server.sendDecision(id, decision);
});
await server.start();
log(`[looper] bridge ${socketPath}`);
log(`[looper] trace ${traceFile}`);
log(`[looper] log ${logFile}`);

const handle = await spawnProxied({
  harness,
  args: rest,
  cwd,
  bridgeScript,
  socketPath,
  intercept: path.basename(resolveHarnessBinary(harness)),
  log,
});

const cleanup = async () => {
  try { handle.kill("SIGTERM"); } catch {}
  try { await server.stop(); } catch {}
};
process.on("SIGINT", () => { cleanup().finally(() => process.exit(130)); });
process.on("SIGTERM", () => { cleanup().finally(() => process.exit(143)); });

handle.child.on("exit", (code, signal) => {
  cleanup().finally(() => {
    if (signal) process.kill(process.pid, signal as NodeJS.Signals);
    process.exit(code ?? 0);
  });
});
