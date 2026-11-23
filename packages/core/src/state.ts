import fs from "node:fs";
import path from "node:path";

export class DurableState {
  private file: string;
  private data: Record<string, unknown> = {};
  private dirty = false;
  constructor(dir: string, name = "state.json") {
    this.file = path.join(dir, name);
    try { this.data = JSON.parse(fs.readFileSync(this.file, "utf8")); } catch {}
  }
  async get<T>(key: string): Promise<T | undefined> { return this.data[key] as T | undefined; }
  async set<T>(key: string, value: T): Promise<void> { this.data[key] = value; this.dirty = true; await this.flush(); }
  async flush(): Promise<void> {
    if (!this.dirty) return;
    await fs.promises.mkdir(path.dirname(this.file), { recursive: true });
    await fs.promises.writeFile(this.file, JSON.stringify(this.data, null, 2));
    this.dirty = false;
  }
  snapshot() { return { ...this.data }; }
}
