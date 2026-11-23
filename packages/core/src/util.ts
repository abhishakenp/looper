import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

export function resolveHarnessBinary(harness: string): string {
  if (harness === "looper") harness = "opencode";
  try {
    const r = execSync(`which ${harness} 2>/dev/null`, { encoding: "utf8", stdio: ["pipe","pipe","ignore"] }).trim();
    if (r && !r.includes("looper")) return r;
  } catch {}
  const common = [
    `/opt/homebrew/bin/${harness}`,
    `/usr/local/bin/${harness}`,
    path.join(process.env.HOME || "", ".local/bin", harness),
    path.join(process.env.HOME || "", ".bun/bin", harness),
    path.join(process.env.HOME || "", ".opencode/bin", harness),
  ];
  for (const p of common) { try { if (fs.existsSync(p)) return p; } catch {} }
  return harness;
}
