import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { projectStateKey } from "../packages/core/src/state.js";

const repoRoot = path.resolve(import.meta.dir, "..");
const cliEntry = path.join(repoRoot, "packages", "cli", "src", "index.ts");
const falseBin = process.platform === "win32" ? "" : "/usr/bin/false";

/** Skip instead of hanging when the harness needed to run the CLI is missing. */
const canRunCli = !!process.versions.bun && fs.existsSync(cliEntry) && !!falseBin && fs.existsSync(falseBin);
const blocker = "requires bun, packages/cli/src/index.ts and /usr/bin/false (stub mitmdump)";

type Fixture = {
  root: string;
  home: string;
  project: string;
  stateRoot: string;
  socket: string;
  env: Record<string, string>;
  cleanup: () => Promise<void>;
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (predicate: () => boolean, timeoutMs = 8_000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(50);
  }
  return predicate();
};

const fixture = async (): Promise<Fixture> => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "looper-cli-wiring-"));
  const home = path.join(root, "home");
  const project = path.join(root, "project");
  const stateRoot = path.join(root, "state");
  const socket = path.join(root, "bridge.sock");
  fs.mkdirSync(path.join(home, ".looper"), { recursive: true });
  fs.mkdirSync(project, { recursive: true });
  fs.mkdirSync(stateRoot, { recursive: true });
  const configPath = path.join(home, ".looper", "config.json");
  fs.writeFileSync(configPath, JSON.stringify({
    bridgeSocket: socket,
    traceDir: path.join(home, ".looper", "traces"),
    logLevel: "debug",
    caCert: false,
    mitmdump: falseBin,
    readyTimeoutMs: 500,
    caTimeoutMs: 100,
    fanout: { killGraceMs: 0 },
    reload: { disposeGraceMs: 100, pollMs: 200 },
    trace: { redactKeys: ["authorization", "cookie", "token"] },
  }));
  return {
    root, home, project, stateRoot, socket,
    env: {
      ...process.env,
      HOME: home,
      LOOPER_STATE_DIR: stateRoot,
      LOOPER_CONFIG: configPath,
    } as Record<string, string>,
    cleanup: async () => { fs.rmSync(root, { recursive: true, force: true }); },
  };
};

/** Start a CLI in a temp HOME; `sleep` keeps the harness alive until assertions land. */
const startCli = async (f: Fixture) => {
  const child = Bun.spawn([process.execPath, cliEntry, "sleep", "20"], {
    cwd: f.project,
    env: f.env,
    stdout: "pipe",
    stderr: "pipe",
  });
  const deadline = Date.now() + 10_000;
  while (!fs.existsSync(f.socket) && Date.now() < deadline) await sleep(50);
  if (!fs.existsSync(f.socket)) {
    child.kill();
    throw new Error(`CLI bridge socket never appeared at ${f.socket}`);
  }
  return child;
};

const stopCli = async (child: any) => {
  try { child.kill("SIGTERM"); } catch {}
  const code = await Promise.race([child.exited, sleep(3_000).then(() => "timeout")]);
  if (code === "timeout") { try { child.kill("SIGKILL"); } catch {} }
};

/** One bridge message, enough to exercise tracing and the flow snapshot write. */
const sendBridgeRequest = async (f: Fixture, flowId: string) => {
  const net = await import("node:net");
  await new Promise<void>((resolve, reject) => {
    const conn = net.connect(f.socket);
    conn.on("connect", () => {
      conn.write(JSON.stringify({
        t: "request",
        id: flowId,
        req: { id: flowId, method: "GET", url: "https://example.com", headers: { Authorization: "secret-token-here" } },
      }) + "\n");
      setTimeout(() => { conn.end(); resolve(); }, 250);
    });
    conn.on("error", reject);
  });
};

const traceFiles = (f: Fixture): string[] => {
  const dir = path.join(f.home, ".looper", "traces");
  return fs.existsSync(dir) ? fs.readdirSync(dir).filter((x) => x.endsWith(".ndjson")) : [];
};

test.skipIf(!canRunCli)("CLI state snapshot lands in the configured state dir with mode 0600", async () => {
  const f = await fixture();
  let child: any;
  try {
    child = await startCli(f);
    const flowId = "flow-cli-wiring";
    await sendBridgeRequest(f, flowId);

    // macOS /var is a symlink to /private/var; the child sees the realpath.
    const expectedDir = path.join(f.stateRoot, projectStateKey(fs.realpathSync(f.project)));
    const snapshot = path.join(expectedDir, "durable-v2-snapshot.json");
    expect(await waitFor(() => fs.existsSync(snapshot))).toBe(true);
    expect(traceFiles(f).length).toBeGreaterThan(0);

    const stat = fs.statSync(snapshot);
    expect(stat.mode & 0o777).toBe(0o600);
    const data = JSON.parse(fs.readFileSync(snapshot, "utf8"));
    expect(data.flows[flowId]).toMatchObject({ id: flowId, status: "request", requestId: `req_${flowId}` });
  } finally {
    if (child) await stopCli(child);
    await f.cleanup();
  }
}, 30_000);

test.skipIf(!canRunCli)("CLI redacts configured keys and `looper trace show` prints the redaction", async () => {
  const f = await fixture();
  let child: any;
  try {
    child = await startCli(f);
    await sendBridgeRequest(f, "flow-redaction");
    expect(await waitFor(() => traceFiles(f).length > 0)).toBe(true);

    const file = path.join(f.home, ".looper", "traces", traceFiles(f)[0]);
    expect(await waitFor(() => fs.readFileSync(file, "utf8").includes("[REDACTED]"))).toBe(true);
    const trace = fs.readFileSync(file, "utf8");
    expect(trace).toContain("[REDACTED]");
    expect(trace).not.toContain("secret-token-here");

    const shown = Bun.spawn([process.execPath, cliEntry, "trace", "show", file], {
      cwd: f.project,
      env: f.env,
      stdout: "pipe",
      stderr: "pipe",
    });
    const out = await new Response(shown.stdout).text();
    await shown.exited;
    expect(shown.exitCode).toBe(0);
    expect(out).toContain("[REDACTED]");
    expect(out).not.toContain("secret-token-here");
  } finally {
    if (child) await stopCli(child);
    await f.cleanup();
  }
}, 30_000);

test.skipIf(!canRunCli)("CLI loads ~/.looper and project .looper markdown into ctx.resources and exposes helpers", async () => {
  const f = await fixture();
  let child: any;
  try {
    fs.mkdirSync(path.join(f.home, ".looper", "agents"), { recursive: true });
    fs.mkdirSync(path.join(f.project, ".looper", "extensions"), { recursive: true });
    fs.mkdirSync(path.join(f.project, ".looper", "skills"), { recursive: true });
    fs.mkdirSync(path.join(f.project, ".looper", "prompts"), { recursive: true });
    fs.writeFileSync(path.join(f.home, ".looper", "agents", "homeagent.md"), "home agent\n");
    fs.writeFileSync(path.join(f.project, ".looper", "skills", "projectskill.md"), "project skill\n");
    fs.writeFileSync(path.join(f.project, ".looper", "prompts", "projectprompt.md"), "project prompt\n");

    // A temp extension is the only observer of ctx: it prints what it received
    // through ctx.log, which the CLI writes to its per-session log file.
    fs.writeFileSync(path.join(f.project, ".looper", "extensions", "probe.mjs"), `
export default (ctx) => {
  const names = [...ctx.resources.agents, ...ctx.resources.skills, ...ctx.resources.prompts].map(r => r.name);
  ctx.log("RESOURCES " + names.join(","));
  ctx.log("HELPERS " + [typeof ctx.ownership.assertAllowedPath, typeof ctx.verify.preRunVerify].join(","));
};
`);

    child = await startCli(f);
    const logFile = await waitFor(() => {
      const dir = path.join(f.home, ".looper", "run");
      return fs.existsSync(dir) ? fs.readdirSync(dir).some((x) => x.endsWith(".log")) : false;
    }) ? (() => {
      const dir = path.join(f.home, ".looper", "run");
      const name = fs.readdirSync(dir).find((x) => x.endsWith(".log"))!;
      return path.join(dir, name);
    })() : "";
    expect(logFile).not.toBe("");
    expect(await waitFor(() => fs.readFileSync(logFile, "utf8").includes("HELPERS function,function"))).toBe(true);

    const log = fs.readFileSync(logFile, "utf8");
    for (const name of ["homeagent", "projectskill", "projectprompt"]) {
      expect(log).toContain(name);
    }
  } finally {
    if (child) await stopCli(child);
    await f.cleanup();
  }
}, 30_000);
