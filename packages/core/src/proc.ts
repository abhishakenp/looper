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
}

export interface ProcHandle {
  mitm?: ChildProcess;
  child: ChildProcess;
  kill: (signal?: NodeJS.Signals) => void;
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

export async function spawnProxied(opts: ProcOptions): Promise<ProcHandle> {
  const mitmdump = opts.mitmdump || "mitmdump";
  const target = opts.intercept || opts.harness;
  const mitmArgs = [
    "--mode", `local:${target}`,
    "-s", opts.bridgeScript,
    "--set", `looper_sock=${opts.socketPath}`,
    "-v",
  ];
  const log = opts.log || (() => {});
  const mitm = spawn(mitmdump, mitmArgs, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...opts.env },
  });
  let ready = false;
  const onData = (d: Buffer) => {
    const s = d.toString();
    log(`[mitm] ${s}`);
    if (s.includes("Local redirector started") || s.includes("successfully initialized")) ready = true;
  };
  mitm.stdout?.on("data", onData);
  mitm.stderr?.on("data", onData);

  // wait for mitmproxy local capture to be ready (macOS NE needs time)
  const deadline = Date.now() + 15000;
  while (!ready && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  if (!ready) log("[looper] warning: mitmproxy local capture not confirmed ready, proceeding anyway");

  // Resolve mitmproxy CA and inject env for non-proxy-aware/TLS clients.
  let caCert = resolveMitmCa(opts.caCert);
  if (opts.caCert !== false && !caCert) {
    const caDeadline = Date.now() + 3000;
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
  });

  const kill = (signal: NodeJS.Signals = "SIGTERM") => {
    try { child.kill(signal); } catch {}
    try { mitm.kill(signal); } catch {}
  };
  return { mitm, child, kill };
}
