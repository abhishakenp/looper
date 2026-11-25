/**
 * Looper layered configuration.
 *
 * Precedence (lowest → highest), mirroring pi-ultimate's per-extension config:
 *   DEFAULT_LOOPER_CONFIG
 *   ~/.looper/config.json
 *   ~/.looper/settings.json  → "looper" key
 *   <cwd>/.looper/config.json          (trust-gated)
 *   <cwd>/.looper/settings.json        → "looper" key (trust-gated)
 *   $LOOPER_CONFIG                     (path to an extra JSON file)
 *   LOOPER_* env overrides
 *   CLI flags (applied by the caller)
 *
 * Every value is normalized: bad values are clamped or replaced by defaults,
 * unknown keys are ignored. A bad config can never crash the harness.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { DEFAULT_LOOPER_CONFIG, type LooperConfig } from "@looper/sdk";

export type ConfigLayer = { name: string; value: Record<string, unknown> };

export const expandTilde = (p: string): string => {
  if (!p.startsWith("~")) return p;
  if (p === "~") return os.homedir();
  if (p.startsWith("~/")) return path.join(os.homedir(), p.slice(2));
  return p; // "~user" is not expanded
};

export const readJson = (p: string): unknown => {
  try {
    const expanded = expandTilde(p);
    return fs.existsSync(expanded) ? JSON.parse(fs.readFileSync(expanded, "utf8")) : undefined;
  } catch {
    return undefined;
  }
};

/** Plain objects deep-merged; arrays and scalars replace wholesale. */
export function mergeDeep<T extends Record<string, any>>(base: T, override: unknown): T {
  if (!override || typeof override !== "object" || Array.isArray(override)) return base;
  const out: Record<string, any> = { ...base };
  for (const [k, v] of Object.entries(override as Record<string, any>)) {
    const b = (out as Record<string, any>)[k];
    if (v && typeof v === "object" && !Array.isArray(v) && b && typeof b === "object" && !Array.isArray(b)) {
      out[k] = mergeDeep(b as Record<string, any>, v);
    } else if (v !== undefined) {
      out[k] = v;
    }
  }
  return out as T;
}

export const clampInt = (value: unknown, fallback: number, min: number, max: number): number => {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) ? Math.max(min, Math.min(max, Math.round(n))) : fallback;
};

export const oneOf = <T extends string>(value: unknown, allowed: readonly T[], fallback: T): T =>
  typeof value === "string" && (allowed as readonly string[]).includes(value) ? (value as T) : fallback;

const num = (v: unknown, fallback: number, min = 0, max = Number.MAX_SAFE_INTEGER) => clampInt(v, fallback, min, max);
const bool = (v: unknown, fallback: boolean) => typeof v === "boolean" ? v : fallback;
const str = (v: unknown, fallback: string) => typeof v === "string" && v.trim() ? v : fallback;
const strList = (v: unknown, fallback: string[]) => Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()) : fallback;

/** Normalize a merged config object. Unknown keys survive but typed fields are sanitized. */
export function normalizeConfig(input: Record<string, any>): LooperConfig {
  const m = mergeDeep(DEFAULT_LOOPER_CONFIG as Record<string, any>, input) as Record<string, any>;
  const d = DEFAULT_LOOPER_CONFIG as Record<string, any>;

  return {
    ...m,
    traceDir: str(m.traceDir, d.traceDir),
    captureBodies: bool(m.captureBodies, d.captureBodies),
    extensions: strList(m.extensions, d.extensions as string[]),
    bridgeSocket: str(m.bridgeSocket, ""),
    mitmdump: str(m.mitmdump, d.mitmdump),
    logLevel: oneOf(m.logLevel, ["debug", "info", "warn", "error"] as const, "info"),
    interceptMode: oneOf(m.interceptMode, ["local", "regular"] as const, "local"),
    harnessEnv: (m.harnessEnv && typeof m.harnessEnv === "object" && !Array.isArray(m.harnessEnv))
      ? Object.fromEntries(Object.entries(m.harnessEnv).filter(([, v]) => typeof v === "string")) as Record<string, string>
      : {},
    readyTimeoutMs: num(m.readyTimeoutMs, d.readyTimeoutMs, 0, 600_000),
    caTimeoutMs: num(m.caTimeoutMs, d.caTimeoutMs, 0, 60_000),
    proxyPort: num(m.proxyPort, d.proxyPort, 1, 65_535),
    captureScope: oneOf(m.captureScope, ["pid", "name"] as const, "pid"),
    caCert: m.caCert === false ? false : str(m.caCert, ""),
    fanout: {
      enabled: bool(m.fanout?.enabled, false),
      concurrency: num(m.fanout?.concurrency, 8, 1, 32),
      maxParallel: num(m.fanout?.maxParallel, 24, 1, 64),
      maxActiveModelRequests: num(m.fanout?.maxActiveModelRequests, 16, 1, 256),
      maxSpawns: num(m.fanout?.maxSpawns, 64, 1, 512),
      jobTtlMs: num(m.fanout?.jobTtlMs, 1_200_000, 5_000, 21_600_000),
      jobIdleGraceMs: num(m.fanout?.jobIdleGraceMs, 20_000, 100, 600_000),
      supervisorTimeoutMs: num(m.fanout?.supervisorTimeoutMs, 90_000, 1_000, 600_000),
      idleMs: num(m.fanout?.idleMs, 45_000, 1_000, 600_000),
      speculationCap: num(m.fanout?.speculationCap, 4, 0, 64),
      killGraceMs: num(m.fanout?.killGraceMs, 2_000, 0, 60_000),
      readyPolicy: oneOf(m.fanout?.readyPolicy, ["wait", "proceed"] as const, "wait"),
    },
    router: {
      enabled: bool(m.router?.enabled, false),
      timeoutMs: num(m.router?.timeoutMs, 1_500, 100, 60_000),
      backend: oneOf(m.router?.backend, ["jev", "none"] as const, "jev"),
      memoCap: num(m.router?.memoCap, 32, 0, 10_000),
    },
    cache: {
      safeInterception: bool(m.cache?.safeInterception, true),
      stableInjectionPosition: bool(m.cache?.stableInjectionPosition, true),
      dedupeInjections: bool(m.cache?.dedupeInjections, true),
      logMetrics: bool(m.cache?.logMetrics, true),
    },
    trace: {
      redactKeys: strList(m.trace?.redactKeys, d.trace.redactKeys as string[]),
      bodyCapChars: num(m.trace?.bodyCapChars, 0, 0, 10_000_000),
      mode: oneOf(m.trace?.mode, ["redact", "raw"] as const, "redact"),
    },
    security: {
      credentialPaths: strList(m.security?.credentialPaths, d.security.credentialPaths as string[]).map(expandTilde),
      writableRoots: strList(m.security?.writableRoots, []).map(expandTilde),
      trustProjectConfig: bool(m.security?.trustProjectConfig, false),
    },
    reload: {
      debounceMs: num(m.reload?.debounceMs, 200, 0, 60_000),
      disposeGraceMs: num(m.reload?.disposeGraceMs, 5_000, 0, 60_000),
      pollMs: num(m.reload?.pollMs, 2_000, 100, 60_000),
    },
    extensionsConfig: (m.extensionsConfig && typeof m.extensionsConfig === "object" && !Array.isArray(m.extensionsConfig))
      ? m.extensionsConfig : {},
  };
}

function envOverrides(env: Record<string, string | undefined>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  const map: Array<[string, (v: string) => void]> = [
    ["LOOPER_MITMDUMP", (v) => { out.mitmdump = v; }],
    ["LOOPER_LOG_LEVEL", (v) => { out.logLevel = v; }],
    ["LOOPER_TRACE_DIR", (v) => { out.traceDir = v; }],
    ["LOOPER_READY_TIMEOUT_MS", (v) => { out.readyTimeoutMs = Number(v); }],
    ["LOOPER_CA_TIMEOUT_MS", (v) => { out.caTimeoutMs = Number(v); }],
    ["LOOPER_PROXY_PORT", (v) => { out.proxyPort = Number(v); }],
    ["LOOPER_CAPTURE_BODIES", (v) => { out.captureBodies = v === "1" || v === "true"; }],
    ["LOOPER_TRUST_PROJECT_CONFIG", (v) => { out.security = { trustProjectConfig: v === "1" || v === "true" }; }],
    ["LOOPER_FANOUT_CONCURRENCY", (v) => { out.fanout = { concurrency: Number(v) }; }],
    ["LOOPER_ROUTER_TIMEOUT_MS", (v) => { out.router = { timeoutMs: Number(v) }; }],
    ["LOOPER_CONFIG", (v) => {
      const extra = readJson(v);
      if (extra && typeof extra === "object") Object.assign(out, extra);
    }],
  ];
  for (const [key, apply] of map) {
    const v = env[key];
    if (v !== undefined && v !== "") {
      try { apply(v); } catch { /* a bad env value never crashes the harness */ }
    }
  }
  return out;
}

/** Load all layers and return a single normalized config + the ordered layers used. */
export function loadConfig(cwd: string, env: Record<string, string | undefined> = process.env): { config: LooperConfig; layers: ConfigLayer[]; projectTrusted: boolean } {
  const layers: ConfigLayer[] = [];
  const push = (name: string, value: unknown) => {
    if (value && typeof value === "object" && !Array.isArray(value)) layers.push({ name, value: value as Record<string, unknown> });
  };
  push("defaults", DEFAULT_LOOPER_CONFIG as unknown as Record<string, unknown>);
  push("~/.looper/config.json", readJson("~/.looper/config.json"));
  const globalSettings = readJson("~/.looper/settings.json") as Record<string, any> | undefined;
  push("~/.looper/settings.json[looper]", globalSettings?.looper);
  // Project layers are trust-gated: opt-in via global config or env.
  const projectTrusted = (globalSettings?.looper as any)?.security?.trustProjectConfig === true
    || (readJson("~/.looper/config.json") as any)?.security?.trustProjectConfig === true
    || env.LOOPER_TRUST_PROJECT_CONFIG === "1";
  if (projectTrusted) {
    push(".looper/config.json", readJson(path.join(cwd, ".looper", "config.json")));
    const projectSettings = readJson(path.join(cwd, ".looper", "settings.json")) as Record<string, any> | undefined;
    push(".looper/settings.json[looper]", projectSettings?.looper);
  }
  push("env", envOverrides(env));
  let merged: Record<string, unknown> = {};
  for (const l of layers) merged = mergeDeep(merged, l.value);
  return { config: normalizeConfig(merged), layers, projectTrusted };
}
