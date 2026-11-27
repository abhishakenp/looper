import { defineDoc, defineDocFamily, defineTask, MemoryStorage } from "@earendil-works/pi-durable";
import type { FlowId, FlowMeta } from "looper-sdk";
import fs from "node:fs";
import path from "node:path";
import { stateRoot, atomicWriteJson } from "./state.js";

// --- pi-durable document contracts (L4 control plane) ---

export const FlowRecordDoc: any = defineDocFamily<any, any>({
  kind: "looper.flow",
  version: 1,
  scope: "session",
  family: true,
  initial: (seed: { id: FlowId; requestId: string; meta: FlowMeta }) => ({
    id: seed.id,
    requestId: seed.requestId,
    meta: seed.meta as any,
    status: "open" as "open" | "streaming" | "committed" | "error",
    chunkCount: 0,
    updatedAt: Date.now(),
  }),
  checkpointWhen: (_value: any, _ops: any, info: any) => (info?.deltasSinceBase ?? 0) >= 8,
});

export const ExtensionStateDoc: any = defineDoc<any>({
  kind: "looper.extension_state",
  version: 1,
  scope: "session",
  initial: () => ({ values: {} as Record<string, any>, updatedAt: Date.now() }),
  checkpointWhen: (_value: any, _ops: any, info: any) => (info?.deltasSinceBase ?? 0) >= 4,
});

// --- async hook task (pi-durable task model) ---

export type ClaimInput = { flowId: FlowId; requestId: string; hook: string; timeoutMs: number };
export type ClaimState = { phase: "waiting"; until: number } | { phase: "done" };
export type ClaimResult = { decision: unknown };

export const ClaimTask: any = defineTask<ClaimInput, ClaimState, ClaimResult>({
  name: "looper.claim",
  version: 1,
  initial: (input) => ({ phase: "waiting", until: Date.now() + Math.max(100, input.timeoutMs) }),
  phases: {
    waiting: async (task: any, runtime: any, context: any) => {
      const cp = task.state?.checkpoint ?? task.state;
      const until = cp?.phase === "waiting" ? cp.until : Date.now();
      await runtime.sleepUntil(until, { phase: "done" }, context);
    },
    done: async (_task: any, runtime: any, context: any) => {
      await runtime.commit(() => ({ status: "terminal" as const, outcome: { status: "completed" as const, result: { decision: { action: "pass" } } } }), context);
    },
  },
  abort: async (_task: any, runtime: any, context: any) => {
    await runtime.commit(() => ({ status: "terminal" as const, outcome: { status: "aborted" as const } }), context);
  },
});

// --- lightweight runtime wrapper ---

export class LooperDurableRuntime {
  readonly storage = new MemoryStorage();
  readonly docs = { FlowRecordDoc, ExtensionStateDoc };
  readonly tasks = { ClaimTask };
  private snapshotFile: string;
  private snapshot: Record<string, unknown> = {};

  constructor(dir: string) {
    // Prefer the out-of-tree state root; fall back to the supplied dir only if
    // an existing snapshot is there (migration), keeping the checkout clean.
    const outOfTree = stateRoot(dir);
    const legacy = path.join(dir, "durable-snapshot.json");
    this.snapshotFile = fs.existsSync(legacy) && !fs.existsSync(path.join(outOfTree, "durable-snapshot.json"))
      ? legacy
      : path.join(outOfTree, "durable-snapshot.json");
    try { this.snapshot = JSON.parse(fs.readFileSync(this.snapshotFile, "utf8")); } catch {}
  }

  get file() { return this.snapshotFile; }
  getSnapshot<T>(key: string): T | undefined { return this.snapshot[key] as T | undefined; }
  async setSnapshot<T>(key: string, value: T): Promise<void> {
    this.snapshot[key] = value;
    await atomicWriteJson(this.snapshotFile, this.snapshot);
  }

  /** Control-plane identity for observability/correlation. */
  requestId(flowId: FlowId): string { return `req_${flowId}`; }

  /** Reconcile durable control plane after crash/restart. Live TCP cannot survive crash. */
  async reconcile(sessionId: string): Promise<{ crashedFlows: string[] }> {
    const crashedFlows: string[] = [];
    const now = Date.now();
    for (const [k, v] of Object.entries(this.snapshot)) {
      if (!k.startsWith("flow:") || !k.endsWith(":last")) continue;
      const rec = v as any;
      const status = rec?.status || rec?.t;
      // flows that never reached done/error are considered crashed/orphaned
      if (status && !["done", "error", "committed", "crashed"].includes(status)) {
        rec.status = "crashed";
        rec.crashedAt = now;
        rec.crashSession = sessionId;
        this.snapshot[k] = rec;
        crashedFlows.push(k);
      }
    }
    this.snapshot["looper:last_reconcile"] = { ts: now, sessionId, crashedFlows };
    await atomicWriteJson(this.snapshotFile, this.snapshot);
    return { crashedFlows };
  }
}
