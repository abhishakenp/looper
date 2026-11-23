#!/usr/bin/env bun
import path from "node:path";
import fs from "node:fs";
import os from "node:os";
import { BridgeServer, FlowStore, HookRegistry, spawnProxied, resolveHarnessBinary } from "@looper/core";
import type { BridgeInbound, Decision, HookFn, HookType } from "@looper/sdk";

const args = process.argv.slice(2);
if (args.length === 0) {
  console.error("Usage: looper <harness> [args...]");
  process.exit(1);
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

await fs.promises.mkdir(traceDir, { recursive: true });

const flows = new FlowStore();
const hooks = new HookRegistry(flows);

function trace(obj: unknown) {
  try { fs.appendFileSync(traceFile, JSON.stringify(obj) + "\n"); } catch {}
}

// Load extensions from global and project dirs
async function loadExtensions() {
  const dirs = [
    path.join(os.homedir(), ".looper", "extensions"),
    path.join(cwd, ".looper", "extensions"),
  ];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter(x => x.endsWith(".ts") || x.endsWith(".js") || x.endsWith(".mjs"))) {
      try {
        const mod = await import(path.join(dir, f));
        const ext = mod.default || mod.extension || mod;
        if (typeof ext === "function") {
          await ext({ on: (t: HookType, fn: HookFn, name?: string) => hooks.on(t, fn, name || f), flows, log: console.error });
        } else if (ext && typeof ext.setup === "function") {
          await ext.setup({ on: (t: HookType, fn: HookFn, name?: string) => hooks.on(t, fn, name || f), flows, log: console.error });
        }
        console.error(`[looper] loaded extension ${f}`);
      } catch (e) {
        console.error(`[looper] extension load failed ${f}:`, e);
      }
    }
  }
}

await loadExtensions();

const server = new BridgeServer(socketPath, async (msg: BridgeInbound) => {
  trace({ ts: Date.now(), dir: "in", msg });
  const decision = await hooks.dispatch(msg);
  trace({ ts: Date.now(), dir: "out", id: (msg as any).id, decision });
  return decision;
});
await server.start();
console.error(`[looper] bridge ${socketPath}`);
console.error(`[looper] trace ${traceFile}`);

const handle = await spawnProxied({
  harness,
  args: rest,
  cwd,
  bridgeScript,
  socketPath,
  intercept: path.basename(resolveHarnessBinary(harness)),
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
