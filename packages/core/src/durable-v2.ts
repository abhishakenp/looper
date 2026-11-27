import { createSession, defineDoc, defineDocFamily, MemoryStorage } from "@earendil-works/pi-durable";
import type { JsonObject, Session } from "@earendil-works/pi-durable";
import type { FlowId } from "looper-sdk";
import fs from "node:fs";
import path from "node:path";
import { atomicWriteJson } from "./state.js";

// The control plane is a set of pi-durable documents. MemoryStorage alone is
// not durable: a 0600 snapshot file is written after every commit so a new
// process can hydrate the documents before serving reads.

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
type DurableContext = Parameters<Session["commit"]>[1];

// pi-durable takes a Chord `Context` but does not export one, and Chord is not a
// dependency of this workspace. Only these fields are read on the paths used
// here; telemetry errors are swallowed by the Session's own report path.
const context = {
  abortSignal: undefined,
  telemetry: { addEvent() {} },
  value: () => undefined,
  toString: () => "looper.durable-v2",
} as unknown as DurableContext;

export type FlowStatus = "open" | "streaming" | "committed" | "done" | "error" | "crashed";
export type ClaimStatus = "pending" | "done" | "error" | "crashed";

/** Stored flow shape. The index signature keeps every field strict JSON for the document definition. */
export type FlowRecord = {
  id: string;
  requestId: string;
  status: FlowStatus;
  chunkCount: number;
  updatedAt: number;
  crashedAt: number;
  crashSession: string;
  [key: string]: JsonValue;
};

export type ClaimRecord = {
  id: string;
  flowId: string;
  hook: string;
  status: ClaimStatus;
  updatedAt: number;
  [key: string]: JsonValue;
};

export type FlowPatch = {
  status?: FlowStatus;
  requestId?: string;
  chunkCount?: number;
  crashedAt?: number;
  crashSession?: string;
  [key: string]: JsonValue | undefined;
};

export type ClaimPatch = {
  status?: ClaimStatus;
  flowId?: string;
  hook?: string;
  [key: string]: JsonValue | undefined;
};

export type DurableV2Snapshot = {
  version: 1;
  flows: Record<string, FlowRecord>;
  claims: Record<string, ClaimRecord>;
  meta: Record<string, JsonValue>;
};

export type FlowSeed = { id: string };
export type ClaimSeed = { id: string };
export type MetaRecord = { values: Record<string, JsonValue> };

export const FlowDoc = defineDocFamily<FlowRecord, FlowSeed>({
  kind: "looper.v2.flow",
  version: 1,
  scope: "session",
  family: true,
  initial: (seed: FlowSeed): FlowRecord => ({
    id: seed.id,
    requestId: "",
    status: "open",
    chunkCount: 0,
    updatedAt: 0,
    crashedAt: 0,
    crashSession: "",
  }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 8,
});

export const ClaimDoc = defineDocFamily<ClaimRecord, ClaimSeed>({
  kind: "looper.v2.claim",
  version: 1,
  scope: "session",
  family: true,
  initial: (seed: ClaimSeed): ClaimRecord => ({
    id: seed.id,
    flowId: "",
    hook: "",
    status: "pending",
    updatedAt: 0,
  }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 8,
});

export const MetaDoc = defineDoc<MetaRecord>({
  kind: "looper.v2.meta",
  version: 1,
  scope: "session",
  initial: (): MetaRecord => ({ values: {} }),
  checkpointWhen: (_value, _ops, info) => info.deltasSinceBase >= 4,
});

/** Terminal states mirror the existing LooperDurableRuntime's reconcile vocabulary. */
const TERMINAL_STATUSES = new Set<FlowStatus>(["done", "error", "committed", "crashed"]);

const emptySnapshot = (): DurableV2Snapshot => ({ version: 1, flows: {}, claims: {}, meta: {} });
const clone = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Only keys touched by this operation may win over the on-disk snapshot. */
type ChangedKeys = { flows?: string[]; claims?: string[]; meta?: string[] };

const assignDefined = (target: Record<string, JsonValue>, patch: Record<string, JsonValue | undefined>): void => {
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) target[key] = value;
  }
};

const isSnapshot = (value: unknown): value is DurableV2Snapshot => {
  const s = value as Partial<DurableV2Snapshot> | null;
  return !!s && s.version === 1 && !!s.flows && !!s.claims && !!s.meta && typeof s.flows === "object" && typeof s.claims === "object" && typeof s.meta === "object";
};

/**
 * L4 control plane. Every mutation is a pi-durable Session commit; the atomic
 * file is the recovery record that lets a fresh Session hydrate the documents.
 */
export class DurableControlPlane {
  readonly file: string;
  private session: Session | undefined;
  private data: DurableV2Snapshot = emptySnapshot();
  private chain: Promise<unknown> = Promise.resolve();
  private closed = false;

  constructor(stateDir: string) {
    this.file = path.join(stateDir, "durable-v2-snapshot.json");
  }

  /** Serialize all operations: one mutation line in the Session, one writer of the snapshot file. */
  private serialized<T>(operation: () => Promise<T>): Promise<T> {
    const run = this.chain.then(operation, operation);
    this.chain = run.catch(() => {});
    return run;
  }

  private async hydrate(): Promise<void> {
    if (this.session) return;
    if (this.closed) throw new Error("DurableControlPlane is closed");
    this.session = createSession(new MemoryStorage());

    let restored = emptySnapshot();
    try {
      const parsed: unknown = JSON.parse(await fs.promises.readFile(this.file, "utf8"));
      if (isSnapshot(parsed)) restored = parsed;
    } catch {
      // Absent or corrupt file: start with an empty control plane.
    }
    this.data = restored;

    const flowIds = Object.keys(restored.flows);
    const claimIds = Object.keys(restored.claims);
    if (flowIds.length === 0 && claimIds.length === 0 && Object.keys(restored.meta).length === 0) return;

    await this.session.commit(async (tx) => {
      for (const id of flowIds) assignDefined(await tx.doc(FlowDoc, id, { id }), restored.flows[id]);
      for (const id of claimIds) assignDefined(await tx.doc(ClaimDoc, id, { id }), restored.claims[id]);
      const meta = await tx.doc(MetaDoc);
      assignDefined(meta.values, restored.meta);
    }, context);
  }

  /**
   * Re-read the snapshot while holding the cross-process lock, then merge only
   * the keys this operation changed. Another live instance's keys survive,
   * even when both processes hydrate from the same empty file.
   */
  private async persist(changed?: ChangedKeys): Promise<void> {
    let merged: DurableV2Snapshot = this.data;
    await atomicWriteJson(this.file, this.data, {
      merge: (onDisk) => {
        const disk = isSnapshot(onDisk) ? onDisk : emptySnapshot();
        merged = { version: 1, flows: { ...disk.flows }, claims: { ...disk.claims }, meta: { ...disk.meta } };
        for (const id of changed?.flows ?? Object.keys(this.data.flows)) {
          if (this.data.flows[id]) merged.flows[id] = clone(this.data.flows[id]);
        }
        for (const id of changed?.claims ?? Object.keys(this.data.claims)) {
          if (this.data.claims[id]) merged.claims[id] = clone(this.data.claims[id]);
        }
        for (const key of changed?.meta ?? Object.keys(this.data.meta)) {
          if (key in this.data.meta) merged.meta[key] = clone(this.data.meta[key]);
        }
        return merged;
      },
    });
    this.data = merged;
  }

  async init(): Promise<void> {
    await this.serialized(() => this.hydrate());
  }

  private async commitFlow(flowId: FlowId, patch: FlowPatch): Promise<FlowRecord> {
    const id = String(flowId);
    if (!id) throw new Error("flowId must not be empty");
    const now = Date.now();
    await this.session!.commit(async (tx) => {
      const draft = await tx.doc(FlowDoc, id, { id });
      assignDefined(draft as Record<string, JsonValue>, patch as Record<string, JsonValue | undefined>);
      draft.id = id;
      draft.updatedAt = now;
    }, context);
    const stored = await this.session!.snapshot(FlowDoc, id, context);
    if (!stored) throw new Error(`flow ${id} missing after commit`);
    return clone(stored);
  }

  async writeFlow(flowId: FlowId, patch: FlowPatch): Promise<FlowRecord> {
    return this.serialized(async () => {
      await this.hydrate();
      const record = await this.commitFlow(flowId, patch);
      this.data.flows[record.id] = record;
      await this.persist({ flows: [record.id] });
      return record;
    });
  }

  async readFlow(flowId: FlowId): Promise<FlowRecord | undefined> {
    return this.serialized(async () => {
      await this.hydrate();
      const stored = await this.session!.snapshot(FlowDoc, String(flowId), context);
      return stored ? clone(stored) : undefined;
    });
  }

  private async commitClaim(claimId: string, patch: ClaimPatch): Promise<ClaimRecord> {
    const id = String(claimId);
    if (!id) throw new Error("claimId must not be empty");
    const now = Date.now();
    await this.session!.commit(async (tx) => {
      const draft = await tx.doc(ClaimDoc, id, { id });
      assignDefined(draft as Record<string, JsonValue>, patch as Record<string, JsonValue | undefined>);
      draft.id = id;
      draft.updatedAt = now;
    }, context);
    const stored = await this.session!.snapshot(ClaimDoc, id, context);
    if (!stored) throw new Error(`claim ${id} missing after commit`);
    return clone(stored);
  }

  async writeClaim(claimId: string, patch: ClaimPatch): Promise<ClaimRecord> {
    return this.serialized(async () => {
      await this.hydrate();
      const record = await this.commitClaim(claimId, patch);
      this.data.claims[record.id] = record;
      await this.persist({ claims: [record.id] });
      return record;
    });
  }

  /** Copy of the recovery snapshot; mutating it cannot change durable state. */
  snapshot(): DurableV2Snapshot {
    return clone(this.data);
  }

  async reconcile(sessionId: string): Promise<{ crashedFlows: string[] }> {
    return this.serialized(async () => {
      await this.hydrate();
      const now = Date.now();
      const crashedFlows: string[] = [];
      for (const [id, record] of Object.entries(this.data.flows)) {
        if (!TERMINAL_STATUSES.has(record.status)) crashedFlows.push(id);
      }

      await this.session!.commit(async (tx) => {
        for (const id of crashedFlows) {
          const draft = await tx.doc(FlowDoc, id, { id });
          draft.status = "crashed";
          draft.crashedAt = now;
          draft.crashSession = sessionId;
          draft.updatedAt = now;
        }
        const meta = await tx.doc(MetaDoc);
        meta.values["last_reconcile"] = { ts: now, sessionId, crashedFlows } as unknown as JsonValue;
      }, context);

      for (const id of crashedFlows) {
        const stored = await this.session!.snapshot(FlowDoc, id, context);
        if (stored) this.data.flows[id] = clone(stored);
      }
      const meta = await this.session!.snapshot(MetaDoc, context);
      if (meta) this.data.meta = clone(meta.values);
      await this.persist({ flows: crashedFlows, meta: meta ? Object.keys(meta.values) : [] });
      return { crashedFlows };
    });
  }

  async close(): Promise<void> {
    await this.serialized(async () => {
      if (this.session) {
        await this.session.close(context);
        this.session = undefined;
      }
      this.closed = true;
    });
  }
}
