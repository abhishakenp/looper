import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { resolveHarnessBinary } from "./util.js";

export interface ProcOptions {
  harness: string;
  args: string[];
  cwd?: string;
  env?: Record<string, string>;
  mitmdump?: string;
  bridgeScript: string;
  socketPath: string;
  intercept?: string; // process name or pid spec for mitmproxy local mode
  caCert?: string | false; // path to CA cert, or false to disable injection
  log?: (msg: string) => void;
  /** mitmproxy readiness budget; 0 waits indefinitely. Default 15000. */
  readyTimeoutMs?: number;
  /** CA file polling budget. Default 3000. */
  caTimeoutMs?: number;
  /** Delay before SIGKILL after a graceful signal. Default 2000. */
  killGraceMs?: number;
}

export interface ProcHandle {
  mitm?: ChildProcess;
  child: ChildProcess;
  kill: (signal?: NodeJS.Signals, graceMs?: number) => void;
  /** Process group ids, for observability. */
  pgids: number[];
  settled: boolean;
}

const DEFAULT_CA_PATHS = [
  path.join(os.homedir(), ".mitmproxy", "mitmproxy-ca-cert.pem"),
  path.join(os.homedir(), ".mitmproxy", "mitmproxy-ca-cert.cer"),
];

export function resolveMitmCa(explicit?: string | false): string | undefined {
  if (explicit === false) return undefined;
  if (explicit) return fs.existsSync(explicit) ? explicit : undefined;
  for (const p of DEFAULT_CA_PATHS) if (fs.existsSync(p)) return p;
  return undefined;
}

export function buildCaEnv(caCert: string | undefined, base: Record<string, string | undefined>): Record<string, string> {
  const env: Record<string, string> = {};
  if (!caCert) return env;
  env.LOOPER_CA_CERT = caCert;
  // Additive in Node/Bun - safe to set
  if (!base.NODE_EXTRA_CA_CERTS) env.NODE_EXTRA_CA_CERTS = caCert;
  // These replace/point to CA bundle; only set if unset to avoid breaking user config
  for (const k of ["SSL_CERT_FILE", "REQUESTS_CA_BUNDLE", "CURL_CA_BUNDLE", "GIT_SSL_CAINFO", "AWS_CA_BUNDLE", "DENO_CERT"]) {
    if (!base[k]) env[k] = caCert;
  }
  return env;
}

// All spawned groups are tracked so a looper exit cannot orphan a harness or mitmproxy.
// pi-ultimate learned this the hard way: a grandchild holding stdio kept a worker forever.
const liveGroups = new Set<number>();

function signalGroup(pid: number, signal: NodeJS.Signals) {
  if (process.platform !== "win32") {
    try { process.kill(-pid, signal); return; } catch { /* may already be gone */ }
  }
  try { process.kill(pid, signal); } catch {}
}

process.on("exit", () => {
  // Best-effort synchronous kill; no grace here — the process is already leaving.
  for (const pid of [...liveGroups]) signalGroup(pid, "SIGKILL");
});

export async function spawnProxied(opts: ProcOptions): Promise<ProcHandle> {
  const mitmdump = opts.mitmdump || "mitmdump";
  const target = opts.intercept || opts.harness;
  const log = opts.log || (() => {});
  const readyTimeoutMs = opts.readyTimeoutMs ?? 15_000;
  const caTimeoutMs = opts.caTimeoutMs ?? 3_000;
  const killGraceMs = opts.killGraceMs ?? 2_000;
  const detached = process.platform !== "win32";

  const mitmArgs = [
    "--mode", `local:${target}`,
    "-s", opts.bridgeScript,
    "--set", `looper_sock=${opts.socketPath}`,
    "-v",
  ];
  const mitm = spawn(mitmdump, mitmArgs, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...opts.env },
    detached,
  });
  const pgids: number[] = [];
  if (mitm.pid) { pgids.push(mitm.pid); liveGroups.add(mitm.pid); }
  let ready = false;
  const onData = (d: Buffer) => {
    const s = d.toString();
    log(`[mitm] ${s}`);
    if (s.includes("Local redirector started") || s.includes("successfully initialized")) ready = true;
  };
  mitm.stdout?.on("data", onData);
  mitm.stderr?.on("data", onData);

  // Wait for mitmproxy local capture readiness, bounded by config.
  const deadline = readyTimeoutMs > 0 ? Date.now() + readyTimeoutMs : Infinity;
  while (!ready && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  if (!ready) log(`[looper] warning: mitmproxy local capture not confirmed ready after ${readyTimeoutMs}ms`);

  // Resolve mitmproxy CA and inject env for non-proxy-aware/TLS clients.
  let caCert = resolveMitmCa(opts.caCert);
  if (opts.caCert !== false && !caCert) {
    const caDeadline = caTimeoutMs > 0 ? Date.now() + caTimeoutMs : Infinity;
    while (!caCert && Date.now() < caDeadline) {
      await new Promise((r) => setTimeout(r, 200));
      caCert = resolveMitmCa(opts.caCert);
    }
  }
  const baseEnv = { ...process.env, ...opts.env } as Record<string, string | undefined>;
  const caEnv = buildCaEnv(caCert, baseEnv);
  if (caCert) log(`[looper] ca ${caCert}`);
  else if (opts.caCert !== false) log("[looper] warning: mitmproxy CA cert not found; TLS clients may fail");

  const bin = resolveHarnessBinary(opts.harness);
  const child = spawn(bin, opts.args, {
    stdio: "inherit",
    cwd: opts.cwd || process.cwd(),
    env: { ...baseEnv, ...caEnv } as Record<string, string>,
    detached,
  });
  if (child.pid) { pgids.push(child.pid); liveGroups.add(child.pid); }

  const handle: ProcHandle = {
    mitm,
    child,
    pgids,
    settled: false,
    kill: (signal: NodeJS.Signals = "SIGTERM", grace = killGraceMs) => {
      if (handle.settled) return;
      handle.settled = true;
      for (const pid of pgids) {
        liveGroups.delete(pid);
        signalGroup(pid, signal);
        if (grace > 0 && signal !== "SIGKILL") {
          setTimeout(() => signalGroup(pid, "SIGKILL"), grace).unref?.();
        }
      }
    },
  };
  return handle;
}
