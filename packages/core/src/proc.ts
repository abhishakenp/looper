import { spawn, type ChildProcess } from "node:child_process";
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
}

export interface ProcHandle {
  mitm?: ChildProcess;
  child: ChildProcess;
  kill: (signal?: NodeJS.Signals) => void;
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
  const mitm = spawn(mitmdump, mitmArgs, {
    stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, ...opts.env },
  });
  let ready = false;
  const onData = (d: Buffer) => {
    const s = d.toString();
    process.stderr.write(`[mitm] ${s}`);
    if (s.includes("Local redirector started") || s.includes("successfully initialized")) ready = true;
  };
  mitm.stdout?.on("data", onData);
  mitm.stderr?.on("data", onData);

  // wait for mitmproxy local capture to be ready (macOS NE needs time)
  const deadline = Date.now() + 15000;
  while (!ready && Date.now() < deadline) await new Promise((r) => setTimeout(r, 200));
  if (!ready) console.error("[looper] warning: mitmproxy local capture not confirmed ready, proceeding anyway");

  const bin = resolveHarnessBinary(opts.harness);
  const child = spawn(bin, opts.args, {
    stdio: "inherit",
    cwd: opts.cwd || process.cwd(),
    env: { ...process.env, ...opts.env },
  });

  const kill = (signal: NodeJS.Signals = "SIGTERM") => {
    try { child.kill(signal); } catch {}
    try { mitm.kill(signal); } catch {}
  };
  return { mitm, child, kill };
}
