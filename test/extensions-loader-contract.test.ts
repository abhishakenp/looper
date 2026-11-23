import { test, expect } from "bun:test";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/** Structural contract every looper extension file must satisfy:
 *  default-export a factory function, or export a setup function.
 *  A stray helper at the top of an extension dir breaks every looper startup.
 */
async function extensionFactory(file: string): Promise<unknown> {
  const mod = await import(new URL(`file://${file}?t=${Date.now()}`).href);
  const ext = mod.default || mod.extension || mod;
  if (typeof ext === "function") return ext;
  if (ext && typeof ext.setup === "function") return ext.setup;
  if (typeof mod.setup === "function") return mod.setup;
  return undefined;
}

test("every file in the real extension dirs exports a factory", async () => {
  const dirs = [
    path.join(os.homedir(), ".looper", "extensions"),
    path.join(process.cwd(), ".looper", "extensions"),
  ];
  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir).filter(x => /\.(ts|js|mjs)$/.test(x))) {
      const factory = await extensionFactory(path.join(dir, f));
      expect(typeof factory, `${f} must export a factory`).toBe("function");
    }
  }
});

test("a missing factory is detected", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "looper-ext-contract-"));
  const file = path.join(dir, "bad.ts");
  fs.writeFileSync(file, "export const helper = 1;\n");
  const factory = await extensionFactory(file);
  expect(factory).toBeUndefined();
  fs.rmSync(dir, { recursive: true, force: true });
});
