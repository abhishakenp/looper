import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

/** Project key = basename + short hash of absolute path. Keeps checkouts clean. */
export function projectStateKey(cwd: string): string {
  const base = path.basename(cwd).replace(/[^A-Za-z0-9._-]/g, "_") || "project";
  const hash = crypto.createHash("sha1").update(path.resolve(cwd)).digest("hex").slice(0, 8);
  return `${base}-${hash}`;
}

/** Out-of-tree state root: $LOOPER_STATE_DIR or ~/.looper/state. */
export function stateRoot(cwd: string): string {
  const root = process.env.LOOPER_STATE_DIR || path.join(os.homedir(), ".looper", "state");
  return path.join(root, projectStateKey(cwd));
}

/** Atomic 0600 write: temp file in the same dir, then rename. */
export async function atomicWriteJson(file: string, value: unknown): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  await fs.promises.writeFile(tmp, JSON.stringify(value, null, 2), { mode: 0o600 });
  await fs.promises.rename(tmp, file);
}

export class DurableState {
  private filePath: string;
  private data: Record<string, unknown> = {};
  private dirty = false;
  private writeQueue: Promise<void> = Promise.resolve();

  constructor(dir: string, name = "state.json") {
    this.filePath = path.join(dir, name);
    try { this.data = JSON.parse(fs.readFileSync(this.filePath, "utf8")); } catch {}
  }
  get file() { return this.filePath; }
  async get<T>(key: string): Promise<T | undefined> { return this.data[key] as T | undefined; }
  async set<T>(key: string, value: T): Promise<void> { this.data[key] = value; this.dirty = true; await this.flush(); }
  /** Whole-object read-modify-write; never erases sibling keys written by another process. */
  async update(fn: (current: Record<string, unknown>) => Record<string, unknown> | void): Promise<void> {
    try { this.data = JSON.parse(fs.readFileSync(this.filePath, "utf8")); } catch {}
    fn(this.data);
    this.dirty = true;
    await this.flush();
  }
  async flush(): Promise<void> {
    if (!this.dirty) return;
    this.writeQueue = this.writeQueue.then(async () => {
      if (!this.dirty) return;
      await atomicWriteJson(this.filePath, this.data);
      this.dirty = false;
    });
    await this.writeQueue;
  }
  snapshot() { return { ...this.data }; }
}
