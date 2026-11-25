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

const DEFAULT_LOCK_TIMEOUT_MS = 10_000;
const DEFAULT_LOCK_POLL_MS = 10;

/** Per-call options win over LOOPER_FILE_LOCK_TIMEOUT_MS, which wins over the 10s default. */
export function fileLockTimeoutMs(): number {
  const raw = process.env.LOOPER_FILE_LOCK_TIMEOUT_MS;
  const ms = raw === undefined ? Number.NaN : Number(raw);
  return Number.isFinite(ms) && ms > 0 ? ms : DEFAULT_LOCK_TIMEOUT_MS;
}

export type FileLockOptions = {
  /** Max wait to acquire, and the age past which an existing lock is stale. */
  timeoutMs?: number;
  pollMs?: number;
};

type LockOwner = { token: string; at: number };

const readOwner = async (lockPath: string): Promise<LockOwner | undefined> => {
  try {
    const [pid, at, token] = (await fs.promises.readFile(lockPath, "utf8")).split(":");
    const ts = Number(at);
    return pid && token && Number.isFinite(ts) ? { token, at: ts } : undefined;
  } catch {
    return undefined;
  }
};

const delay = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * O_EXCL cross-process lock. Recovery moves a stale lock aside with an atomic
 * rename instead of unlinking it: an unlink could delete a lock another
 * contender acquired between the staleness check and the recovery.
 */
export async function withFileLock<T>(
  lockPath: string,
  fn: () => Promise<T>,
  options: FileLockOptions = {},
): Promise<T> {
  const timeoutMs = options.timeoutMs ?? fileLockTimeoutMs();
  const pollMs = options.pollMs ?? DEFAULT_LOCK_POLL_MS;
  const token = crypto.randomUUID();
  const owner = `${process.pid}:${Date.now()}:${token}`;
  const deadline = Date.now() + timeoutMs;
  await fs.promises.mkdir(path.dirname(lockPath), { recursive: true, mode: 0o700 });

  const tryAcquire = async (): Promise<fs.promises.FileHandle | undefined> => {
    let handle: fs.promises.FileHandle;
    try {
      handle = await fs.promises.open(lockPath, "wx", 0o600);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") return undefined;
      throw err;
    }
    try {
      await handle.writeFile(owner, "utf8");
      return handle;
    } catch (err) {
      await handle.close().catch(() => {});
      await fs.promises.unlink(lockPath).catch(() => {});
      throw err;
    }
  };

  let handle: fs.promises.FileHandle | undefined;
  while (!handle) {
    handle = await tryAcquire();
    if (handle) break;
    const current = await readOwner(lockPath);
    if (current && Date.now() - current.at > timeoutMs) {
      const stalePath = `${lockPath}.stale-${token}`;
      try {
        await fs.promises.rename(lockPath, stalePath);
        await fs.promises.unlink(stalePath).catch(() => {});
      } catch {
        // Another contender recovered it first; the next loop sees its lock.
      }
    }
    if (Date.now() >= deadline) throw new Error(`timed out acquiring lock ${lockPath}`);
    await delay(pollMs);
  }

  try {
    return await fn();
  } finally {
    try {
      if ((await readOwner(lockPath))?.token === token) await fs.promises.unlink(lockPath);
    } finally {
      await handle.close();
    }
  }
}

export type AtomicWriteOptions = FileLockOptions & {
  /** Re-read the on-disk value under the lock; the returned value is written. */
  merge?: (onDisk: unknown) => unknown;
};

/** Atomic 0600 write under a cross-process lock, optional read-merge-write. */
export async function atomicWriteJson(file: string, value: unknown, options: AtomicWriteOptions = {}): Promise<void> {
  await fs.promises.mkdir(path.dirname(file), { recursive: true, mode: 0o700 });
  await withFileLock(`${file}.lock`, async () => {
    let merged = value;
    if (options.merge) {
      let onDisk: unknown;
      try {
        onDisk = JSON.parse(await fs.promises.readFile(file, "utf8"));
      } catch {
        // Absent or corrupt file: merge from nothing.
      }
      merged = options.merge(onDisk);
    }
    const tmp = `${file}.tmp-${process.pid}-${Date.now()}-${crypto.randomUUID().slice(0, 8)}`;
    await fs.promises.writeFile(tmp, JSON.stringify(merged, null, 2), { mode: 0o600 });
    await fs.promises.rename(tmp, file);
  }, { timeoutMs: options.timeoutMs, pollMs: options.pollMs });
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
