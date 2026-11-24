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
