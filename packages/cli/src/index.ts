#!/usr/bin/env bun
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { BridgeServer, FlowStore, HookRegistry, spawnProxied, resolveHarnessBinary, DurableState, LooperDurableRuntime, MemoStore, stateRoot, expandTilde, loadConfig as loadLooperConfig } from "@looper/core";
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

// Layered, normalized config (7 tiers; project layers trust-gated) — before paths.
const { config, layers, projectTrusted } = loadLooperConfig(cwd);
const socketPath = config.bridgeSocket ? expandTilde(config.bridgeSocket) : path.join(runDir, `${sessionId}.sock`);
const bridgeScript = path.resolve(path.dirname(new URL(import.meta.url).pathname), "../../bridge/bridge.py");
const traceDir = expandTilde(config.traceDir || "~/.looper/traces");
const traceFile = path.join(traceDir, `${sessionId}.ndjson`);
const logFile = path.join(runDir, `${sessionId}.log`);

await fs.promises.mkdir(traceDir, { recursive: true });
await fs.promises.mkdir(runDir, { recursive: true });

const LEVELS: Record<string, number> = { debug: 0, info: 1, warn: 2, error: 3, none: 99 };
const minLevel = LEVELS[config.logLevel || "info"] ?? 1;
const logAt = (level: string, ...args: unknown[]) => {
  if ((LEVELS[level] ?? 1) < minLevel) return;
  try { fs.appendFileSync(logFile, args.map(a => typeof a === "string" ? a : JSON.stringify(a)).join(" ") + "\n", { mode: 0o600 }); } catch {}
};
const log = (...args: unknown[]) => logAt("info", ...args);
const logDebug = (...args: unknown[]) => logAt("debug", ...args);
const logWarn = (...args: unknown[]) => logAt("warn", ...args);
const logError = (...args: unknown[]) => logAt("error", ...args);
logDebug(`[looper] config layers: ${layers.map(l => l.name).join(" | ")}`);
logDebug(`[looper] project config trusted: ${projectTrusted}`);
logDebug(`[looper] config`, config);

const flows = new FlowStore();
const stateDir = stateRoot(cwd);
const durable = new DurableState(stateDir);
const runtime = new LooperDurableRuntime(stateDir);
const hooks = new HookRegistry(flows, durable);
hooks.setLogger(log);
const reconciled = await runtime.reconcile(sessionId);
if (reconciled.crashedFlows.length) log(`[looper] reconciled ${reconciled.crashedFlows.length} crashed flow(s)`);

const redactKey = new RegExp((config.trace?.redactKeys || []).map(k => k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|") || "(?!x)x", "i");
const bodyCap = config.trace?.bodyCapChars ?? 0;
function capStrings(v: any): any {
  if (typeof v === "string") return bodyCap > 0 && v.length > bodyCap ? v.slice(0, bodyCap) + `...[CAP ${v.length - bodyCap}]` : v;
  if (Array.isArray(v)) return v.map(capStrings);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, capStrings(x)]));
  return v;
}
function redact(obj: any): any {
  if (config.trace?.mode === "raw") return capStrings(obj);
  if (!obj || typeof obj !== "object") return obj;
  if (Array.isArray(obj)) return obj.map(redact);
  const out: any = {};
  for (const [k, v] of Object.entries(obj)) {
    if (redactKey.test(k)) out[k] = "[REDACTED]";
    else out[k] = redact(v);
  }
  return capStrings(out);
}
function trace(obj: unknown) {
  try { fs.appendFileSync(traceFile, JSON.stringify(redact(obj)) + "\n", { mode: 0o600 }); } catch {}
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
  config,
  spawn: (overrides: any = {}) => spawnProxied({
    harness,
    args: [...harnessArgs],
    cwd,
    bridgeScript,
    socketPath,
    intercept: harnessIntercept,
    caCert: config.caCert,
    mitmdump: config.mitmdump,
    readyTimeoutMs: config.readyTimeoutMs,
    caTimeoutMs: config.caTimeoutMs,
    killGraceMs: config.fanout?.killGraceMs,
    interceptMode: config.interceptMode,
    proxyPort: config.proxyPort,
    captureBodies: config.captureBodies,
    log: logDebug,
    ...overrides,
    env: { ...process.env, ...config.harnessEnv, ...(overrides.env || {}) },
  }),
  spawnProxied,
};

// Bridge server first — extensions need it to drain in-flight claims on reload.
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

// Bounded, failure-safe memo shared across flows (router verdicts, classifications).
const memo = new MemoStore(config.router?.memoCap ?? 32);

// Per-extension lifecycle: only the changed file is unloaded/reloaded.
const extDirs = [
  path.join(os.homedir(), ".looper", "extensions"),
  path.join(cwd, ".looper", "extensions"),
];
interface ExtEntry { disposers: Array<() => void>; mtimeMs: number }
const extRegistry = new Map<string, ExtEntry>();
const watchDisposers: Array<() => void> = [];
let reloading = false;
let reloadTimer: any = null;

const extensionFiles = (): string[] => {
  const out: string[] = [];
  for (const dir of extDirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter(x => x.endsWith(".ts") || x.endsWith(".js") || x.endsWith(".mjs"))) {
      const stem = path.basename(f).replace(/\.(ts|js|mjs)$/, "");
      // `extensions` list, when non-empty, is an explicit allow-list + order.
      const configured = config.extensions || [];
      if (configured.length && !configured.includes(stem)) continue;
      out.push(path.join(dir, f));
    }
  }
  const order = config.extensions || [];
  if (order.length) out.sort((a, b) => {
    const sa = path.basename(a).replace(/\.(ts|js|mjs)$/, "");
    const sb = path.basename(b).replace(/\.(ts|js|mjs)$/, "");
    return order.indexOf(sa) - order.indexOf(sb);
  });
  return out;
};

function makeCtx(file: string, disposers: Array<() => void>) {
  const name = path.basename(file);
  return {
    on: (t: HookType, fn: HookFn, n?: string) => {
      const d = hooks.on(t, fn, n || name);
      disposers.push(d);
      return d;
    },
    flows,
    log,
    state: durable,
    proc: procCtx,
    memo: <T>(k: string, fn: () => Promise<T> | T) => memo.get<T>(`ext:${name}:${k}`, fn),
    requestId: (flowId?: string) => `req_${flowId || sessionId}`,
    hold: (flowId: string, timeoutMs?: number) => hooks.holdFlow(flowId, timeoutMs),
    effect: (disposer: () => void) => { disposers.push(disposer); },
    config: (config.extensionsConfig || {})[name.replace(/\.(ts|js|mjs)$/, "")] || {},
  };
}

async function unloadFile(file: string) {
  const rec = extRegistry.get(file);
  if (!rec) return;
  for (const d of [...rec.disposers].reverse()) {
    try { d(); } catch (e) { log(`[looper] disposer failed for ${path.basename(file)}:`, e); }
  }
  extRegistry.delete(file);
}

async function loadFile(file: string, force = false) {
  let st: fs.Stats;
  try { st = fs.statSync(file); } catch { return; }
  const prev = extRegistry.get(file);
  if (!force && prev && prev.mtimeMs === st.mtimeMs) return;
  if (prev) await unloadFile(file);
  const disposers: Array<() => void> = [];
  try {
    const mod = await import(new URL(`file://${file}?t=${Date.now()}`).href);
    const ext = mod.default || mod.extension || mod;
    const ctx = makeCtx(file, disposers);
    if (typeof ext === "function") await ext(ctx);
    else if (ext && typeof ext.setup === "function") await ext.setup(ctx);
    extRegistry.set(file, { disposers, mtimeMs: st.mtimeMs });
    logDebug(`[looper] loaded extension ${path.basename(file)}`);
  } catch (e) {
    for (const d of [...disposers].reverse()) { try { d(); } catch {} }
    log(`[looper] extension load failed ${path.basename(file)}:`, e);
  }
}

async function reloadExtensions(force = false) {
  if (reloading) return;
  reloading = true;
  try {
    const grace = config.reload?.disposeGraceMs ?? 5_000;
    const drained = await server.waitForClaims(grace);
    if (!drained) log(`[looper] reload: fail-open ${server.failOpenClaims().length} outstanding claim(s) after ${grace}ms`);
    const files = extensionFiles();
    for (const file of [...extRegistry.keys()]) if (!files.includes(file)) await unloadFile(file);
    for (const file of files) await loadFile(file, force);
    logDebug(`[looper] extensions reloaded (${extRegistry.size} active)`);
  } finally {
    reloading = false;
  }
}
await reloadExtensions(true);

// Hot reload: watch each dir AND its parent (fs.watch dies on atomic save),
// plus a slow mtime poll so changes made via rename/replace are never missed.
for (const dir of extDirs) {
  try {
    fs.mkdirSync(dir, { recursive: true });
    const schedule = () => {
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => { reloadExtensions().catch(log); }, config.reload?.debounceMs ?? 200);
    };
    for (const target of [dir, path.dirname(dir)]) {
      try { const w = fs.watch(target, schedule); watchDisposers.push(() => w.close()); } catch {}
    }
  } catch {}
}
const poll = setInterval(() => {
  try {
    const files = extensionFiles();
    let changed = files.length !== extRegistry.size;
    if (!changed) {
      for (const f of files) {
        const rec = extRegistry.get(f);
        if (!rec) { changed = true; break; }
        try { if (fs.statSync(f).mtimeMs !== rec.mtimeMs) { changed = true; break; } } catch { changed = true; break; }
      }
    }
    if (changed) {
      clearTimeout(reloadTimer);
      reloadTimer = setTimeout(() => { reloadExtensions().catch(log); }, config.reload?.debounceMs ?? 200);
    }
  } catch {}
}, config.reload?.pollMs ?? 2_000);
poll.unref?.();
watchDisposers.push(() => clearInterval(poll));

const handle = await spawnProxied({
  harness,
  args: rest,
  cwd,
  bridgeScript,
  socketPath,
  intercept: path.basename(resolveHarnessBinary(harness)),
  caCert: config.caCert,
  mitmdump: config.mitmdump,
  readyTimeoutMs: config.readyTimeoutMs,
  caTimeoutMs: config.caTimeoutMs,
  killGraceMs: config.fanout?.killGraceMs,
  interceptMode: config.interceptMode,
  proxyPort: config.proxyPort,
  captureBodies: config.captureBodies,
  log: logDebug,
});

const cleanup = async () => {
  try { handle.kill("SIGTERM", config.fanout?.killGraceMs ?? 2_000); } catch {}
  clearTimeout(reloadTimer);
  for (const d of watchDisposers) { try { d(); } catch {} }
  for (const file of [...extRegistry.keys()]) await unloadFile(file);
  try { server.failOpenClaims(); } catch {}
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
