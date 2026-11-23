import net from "node:net";
import fs from "node:fs";
import path from "node:path";
import type { BridgeInbound, BridgeOutbound, Decision, FlowId } from "@looper/sdk";

export type HookHandler = (msg: BridgeInbound) => Promise<Decision> | Decision;

export class BridgeServer {
  private server?: net.Server;
  private handler: HookHandler;
  private socketPath: string;
  private pendingClaims = new Map<FlowId, net.Socket>();
  constructor(socketPath: string, handler: HookHandler) {
    this.socketPath = socketPath;
    this.handler = handler;
  }
  async start(): Promise<void> {
    await fs.promises.mkdir(path.dirname(this.socketPath), { recursive: true });
    try { await fs.promises.unlink(this.socketPath); } catch {}
    await new Promise<void>((resolve, reject) => {
      const s = net.createServer((conn) => this.onConn(conn));
      s.on("error", reject);
      s.listen(this.socketPath, () => { this.server = s; resolve(); });
    });
  }
  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((r) => this.server!.close(() => r()));
    try { await fs.promises.unlink(this.socketPath); } catch {}
  }
  private onConn(conn: net.Socket) {
    let buf = "";
    conn.on("close", () => {
      for (const [id, c] of this.pendingClaims) if (c === conn) this.pendingClaims.delete(id);
    });
    conn.on("data", async (chunk) => {
      buf += chunk.toString("utf8");
      while (buf.includes("\n")) {
        const idx = buf.indexOf("\n");
        const line = buf.slice(0, idx); buf = buf.slice(idx + 1);
        if (!line.trim()) continue;
        let msg: BridgeInbound;
        try { msg = JSON.parse(line); } catch { continue; }
        this.handle(msg, conn).catch(() => {});
      }
    });
  }
  /** Number of flows currently held on an async claim. */
  get pendingClaimCount() { return this.pendingClaims.size; }
  get pendingClaimIds(): FlowId[] { return [...this.pendingClaims.keys()]; }
  /** Bounded wait for outstanding claims to settle before unloading an extension. */
  async waitForClaims(timeoutMs: number): Promise<boolean> {
    const deadline = timeoutMs > 0 ? Date.now() + timeoutMs : Infinity;
    while (this.pendingClaims.size > 0 && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 50));
    }
    return this.pendingClaims.size === 0;
  }
  /** Fail-open every outstanding claim (used on shutdown / reload timeout). */
  failOpenClaims(): FlowId[] {
    const ids = [...this.pendingClaims.keys()];
    for (const id of ids) this.sendDecision(id, { action: "pass" });
    return ids;
  }
  sendDecision(id: FlowId, decision: Decision) {
    const conn = this.pendingClaims.get(id);
    if (!conn) return false;
    this.pendingClaims.delete(id);
    const out: BridgeOutbound = { t: "decision", id, decision };
    try { conn.write(JSON.stringify(out) + "\n"); return true; } catch { return false; }
  }
  private async handle(msg: BridgeInbound, conn: net.Socket) {
    if (msg.t === "hello") return;
    const id: FlowId | undefined = (msg as any).id;
    let decision: Decision = { action: "pass" };
    try {
      decision = await this.handler(msg);
    } catch {
      decision = { action: "pass" };
    }
    if (id) {
      if (decision.action === "claim") {
        this.pendingClaims.set(id, conn);
      }
      const out: BridgeOutbound = { t: "decision", id, decision };
      try { conn.write(JSON.stringify(out) + "\n"); } catch {}
    }
  }
}
