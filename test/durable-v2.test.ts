import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DurableControlPlane } from "../packages/core/src/durable-v2.js";

const tempDir = (): string => fs.mkdtempSync(path.join(os.tmpdir(), "looper-durable-v2-"));

test("flows and claims survive a restart through the recovery snapshot", async () => {
  const dir = tempDir();
  try {
    const first = new DurableControlPlane(dir);
    await first.init();
    await first.writeFlow("flow-A", { requestId: "req_1", status: "streaming", chunkCount: 3, note: "alpha" });
    await first.writeClaim("claim-1", { flowId: "flow-A", hook: "hold", status: "done" });
    expect((await first.readFlow("flow-A"))?.chunkCount).toBe(3);
    await first.close();

    const second = new DurableControlPlane(dir);
    await second.init();
    expect(await second.readFlow("flow-A")).toMatchObject({
      id: "flow-A",
      status: "streaming",
      chunkCount: 3,
      note: "alpha",
    });
    expect(second.snapshot().claims["claim-1"]).toMatchObject({ id: "claim-1", status: "done" });

    await second.writeFlow("flow-A", { status: "committed", chunkCount: 4 });
    await second.close();

    const third = new DurableControlPlane(dir);
    await third.init();
    expect(await third.readFlow("flow-A")).toMatchObject({ status: "committed", chunkCount: 4 });
    await third.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("recovery snapshot is written atomically with mode 0600", async () => {
  const dir = tempDir();
  try {
    const cp = new DurableControlPlane(dir);
    await cp.init();
    await cp.writeFlow("flow-mode", { status: "open" });
    const stat = fs.statSync(cp.file);
    expect(stat.mode & 0o777).toBe(0o600);
    expect(fs.readdirSync(dir).filter((f) => f.includes(".tmp-"))).toEqual([]);
    await cp.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reads come from the pi-durable session, not from the recovery file", async () => {
  const dir = tempDir();
  try {
    const cp = new DurableControlPlane(dir);
    await cp.init();
    await cp.writeFlow("flow-src", { status: "committed", note: "from-session" });
    fs.writeFileSync(cp.file, JSON.stringify({ version: 1, flows: {}, claims: {}, meta: {} }));
    expect((await cp.readFlow("flow-src"))?.note).toBe("from-session");
    await cp.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("two live instances writing the same stateDir never overwrite each other", async () => {
  const dir = tempDir();
  try {
    // Both hydrate cold from an empty file, then write concurrently.
    fs.writeFileSync(path.join(dir, "durable-v2-snapshot.json"), JSON.stringify({ version: 1, flows: {}, claims: {}, meta: {} }));
    const left = new DurableControlPlane(dir);
    const right = new DurableControlPlane(dir);
    await Promise.all([left.init(), right.init()]);

    const write = async (cp: DurableControlPlane, id: string): Promise<void> => {
      for (let i = 0; i < 20; i++) await cp.writeFlow(`${id}-${i}`, { status: "committed", chunkCount: i });
    };
    await Promise.all([write(left, "flow-A"), write(right, "flow-B")]);

    const onDisk = JSON.parse(fs.readFileSync(left.file, "utf8")) as { flows: Record<string, unknown> };
    for (let i = 0; i < 20; i++) {
      expect(onDisk.flows[`flow-A-${i}`]).toMatchObject({ id: `flow-A-${i}`, chunkCount: i });
      expect(onDisk.flows[`flow-B-${i}`]).toMatchObject({ id: `flow-B-${i}`, chunkCount: i });
    }
    expect(fs.readdirSync(dir).filter((f) => f.includes(".tmp-") || f.includes(".lock"))).toEqual([]);
    await Promise.all([left.close(), right.close()]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("two separate bun processes writing the same stateDir preserve both ids", async () => {
  const dir = tempDir();
  const runner = path.join(dir, "runner.ts");
  try {
    fs.writeFileSync(runner, `
import { DurableControlPlane } from ${JSON.stringify(path.resolve("packages/core/src/durable-v2.ts"))};
const [id, stateDir] = process.argv.slice(2);
const cp = new DurableControlPlane(stateDir);
await cp.init();
for (let i = 0; i < 20; i++) await cp.writeFlow(id + "-" + i, { status: "committed", chunkCount: i });
await cp.close();
`);
    const child = (id: string): Promise<void> => new Promise((resolve, reject) => {
      const proc = Bun.spawn(["bun", "run", runner, id, dir], { cwd: process.cwd(), stdout: "pipe", stderr: "pipe" });
      void proc.exited.then((code) => code === 0 ? resolve() : reject(new Error(`child ${id} exited ${code}`)));
    });
    await Promise.all([child("flow-A"), child("flow-B")]);

    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, "durable-v2-snapshot.json"), "utf8")) as { flows: Record<string, unknown> };
    for (let i = 0; i < 20; i++) {
      expect(onDisk.flows[`flow-A-${i}`]).toMatchObject({ id: `flow-A-${i}`, chunkCount: i });
      expect(onDisk.flows[`flow-B-${i}`]).toMatchObject({ id: `flow-B-${i}`, chunkCount: i });
    }
    expect(fs.readdirSync(dir).filter((f) => f.includes(".tmp-") || f.includes(".lock"))).toEqual([]);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("stale file lock is recovered and the lock is released", async () => {
  const dir = tempDir();
  try {
    const { atomicWriteJson, withFileLock } = await import("../packages/core/src/state.js");
    const lockPath = path.join(dir, "extra.lock");
    fs.writeFileSync(lockPath, `${process.pid}:${Date.now() - 60_000}:stale`);
    await withFileLock(lockPath, async () => {}, { timeoutMs: 100, pollMs: 5 });
    expect(fs.existsSync(lockPath)).toBe(false);

    const file = path.join(dir, "value.json");
    await atomicWriteJson(file, {}, { merge: (disk) => ({ ...(disk as object), a: 1, b: 2 }) });
    await atomicWriteJson(file, {}, { merge: (disk) => ({ ...(disk as object), c: 3, d: 4 }) });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ a: 1, b: 2, c: 3, d: 4 });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test("reconcile marks only non-terminal flows crashed, durably and idempotently", async () => {
  const dir = tempDir();
  try {
    const cp = new DurableControlPlane(dir);
    await cp.init();
    await cp.writeFlow("live", { status: "open" });
    await cp.writeFlow("streaming", { status: "streaming" });
    await cp.writeFlow("finished", { status: "committed" });
    await cp.writeFlow("failed", { status: "error" });

    const result = await cp.reconcile("session-42");
    expect([...result.crashedFlows].sort()).toEqual(["live", "streaming"]);
    expect(await cp.readFlow("live")).toMatchObject({ status: "crashed", crashSession: "session-42" });
    expect((await cp.readFlow("streaming"))?.status).toBe("crashed");
    expect((await cp.readFlow("finished"))?.status).toBe("committed");
    expect((await cp.readFlow("failed"))?.status).toBe("error");
    expect(cp.snapshot().meta["last_reconcile"]).toMatchObject({ sessionId: "session-42" });
    expect((await cp.reconcile("session-43")).crashedFlows).toEqual([]);

    await cp.close();

    const restarted = new DurableControlPlane(dir);
    await restarted.init();
    expect(await restarted.readFlow("live")).toMatchObject({ status: "crashed", crashSession: "session-42" });
    expect((await restarted.readFlow("finished"))?.status).toBe("committed");
    await restarted.close();
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
