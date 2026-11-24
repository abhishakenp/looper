import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { ToolCallAccumulator } from "../packages/core/src/workflows/toolcall.js";
import { BridgeServer } from "../packages/core/src/bridge-server.js";
import net from "node:net";

const FIXTURE = "/tmp/subagent-toolcall-fixture.jsonl";

test("real captured subagent tool-call chunks accumulate, detect and rewrite", () => {
  if (!fs.existsSync(FIXTURE)) return; // fixture generated from real trace during validation
  const lines = fs.readFileSync(FIXTURE, "utf8").split("\n").filter(l => l.startsWith("data: ") && l !== "data: [DONE]");
  expect(lines.length).toBeGreaterThan(0);
  const chunks = lines.map(l => { try { return JSON.parse(l.slice(6)); } catch { return null; } }).filter(Boolean);
  const acc = new ToolCallAccumulator();
  for (const c of chunks) acc.pushTracked(c);
  const subs = acc.subagentCalls();
  expect(subs.length).toBeGreaterThan(0);
  const rw = acc.completeRewrite(subs[0].index, "[looper] deterministic task context");
  expect(rw).not.toBeNull();
  // Replaced fragment must keep the JSON parseable as a full argument set.
  const full = rw!.replacement;
  const parsed = JSON.parse((acc as any).state.calls.get(subs[0].index).arguments.slice(0, rw!.prefixLen) + full);
  expect(parsed.looper_context).toContain("deterministic task context");
  expect(parsed.agent || parsed.description || parsed.prompt).toBeTruthy();
});

test("bridge delivers a chunk mutate decision back over the unix socket", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "looper-tc-"));
  const sock = path.join(dir, "b.sock");
  const server = new BridgeServer(sock, async (msg: any) => {
    if (msg.t === "response_chunk") return { action: "mutate", chunk: { data: "REWRITTEN" } };
    return { action: "pass" };
  });
  await server.start();
  const got: any[] = [];
  await new Promise<void>((resolve, reject) => {
    const c = net.connect(sock);
    c.on("connect", () => c.write(JSON.stringify({ t: "response_chunk", id: "f1", chunk: { id: "f1", direction: "response", data: "ORIGINAL", done: false } }) + "\n"));
    c.on("data", d => { got.push(...d.toString().trim().split("\n").filter(Boolean).map(JSON.parse)); resolve(); c.end(); });
    c.on("error", reject);
  });
  await server.stop();
  fs.rmSync(dir, { recursive: true, force: true });
  expect(got[0].decision.action).toBe("mutate");
  expect(got[0].decision.chunk.data).toBe("REWRITTEN");
});
