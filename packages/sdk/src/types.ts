export type FlowId = string;

export type Decision =
  | { action: "pass" }
  | { action: "mutate"; request?: Partial<ProxyRequest>; response?: Partial<ProxyResponse> }
  | { action: "respond"; response: ProxyResponse }
  | { action: "drop" }
  | { action: "stream" }
  | { action: "buffer" }
  | { action: "claim"; timeoutMs?: number };

export interface ProxyRequest {
  id: FlowId;
  method: string;
  url: string;
  headers: Record<string, string>;
  body?: string; // base64 or utf8; v1 simple
  raw?: unknown;
}

export interface ProxyResponse {
  status: number;
  headers: Record<string, string>;
  body?: string;
}

export interface ProxyResponseHeaders {
  id: FlowId;
  status: number;
  headers: Record<string, string>;
}

export interface ProxyChunk {
  id: FlowId;
  direction: "response" | "request";
  data: string; // base64
  done?: boolean;
}

export interface ProxyError {
  id?: FlowId;
  error: string;
}

export type BridgeInbound =
  | { t: "hello"; pid?: number }
  | { t: "request"; id: FlowId; req: ProxyRequest }
  | { t: "responseheaders"; id: FlowId; res: ProxyResponseHeaders }
  | { t: "response_chunk"; id: FlowId; chunk: ProxyChunk }
  | { t: "response"; id: FlowId; res: ProxyResponse }
  | { t: "error"; id?: FlowId; error: string }
  | { t: "done"; id: FlowId };

export type BridgeOutbound =
  | { t: "decision"; id: FlowId; decision: Decision };

export interface FlowMeta {
  id: FlowId;
  ts: number;
  harness?: string;
  pid?: number;
}

export interface LooperConfig {
  traceDir?: string;
  captureBodies?: boolean;
  extensions?: string[];
  bridgeSocket?: string;
  caCert?: string | false;
  mitmdump?: string;
  logLevel?: "debug" | "info" | "warn" | "error";
  interceptMode?: "local" | "regular";
  harnessEnv?: Record<string, string>;
  /** Wall-clock budget (ms) for mitmproxy local-mode readiness. 0 = wait indefinitely. */
  readyTimeoutMs?: number;
  /** Wall-clock budget (ms) for locating the mitmproxy CA certificate. */
  caTimeoutMs?: number;
  /** mitmproxy listen port when interceptMode is "regular". Default 8080. */
  proxyPort?: number;
  /** "pid" = wrapped process only; "name" = also capture descendant processes. Default pid. */
  captureScope?: "pid" | "name";
  /** Extension context: per-extension config from `config.extensionsConfig[name]`. */
  config?: Record<string, unknown>;
  /** Namespaced workflow config. Each extension owns its subobject. */
  fanout?: {
    enabled?: boolean;
    concurrency?: number;
    maxParallel?: number;
    maxActiveModelRequests?: number;
    maxSpawns?: number;
    jobTtlMs?: number;
    jobIdleGraceMs?: number;
    supervisorTimeoutMs?: number;
    idleMs?: number;
    speculationCap?: number;
    killGraceMs?: number;
    readyPolicy?: "wait" | "proceed";
  };
  router?: { enabled?: boolean; timeoutMs?: number; backend?: "jev" | "none"; memoCap?: number };
  cache?: { safeInterception?: boolean; stableInjectionPosition?: boolean; dedupeInjections?: boolean; logMetrics?: boolean };
  trace?: { redactKeys?: string[]; bodyCapChars?: number; mode?: "redact" | "raw" };
  security?: { credentialPaths?: string[]; writableRoots?: string[]; trustProjectConfig?: boolean };
  reload?: { debounceMs?: number; disposeGraceMs?: number; pollMs?: number };
  /** Per-extension config, namespaced by extension name (file stem). */
  extensionsConfig?: Record<string, unknown>;
}

/** Canonical defaults, exported so extensions and docs read the same source of truth. */
export const DEFAULT_LOOPER_CONFIG: Required<Pick<LooperConfig,
  "readyTimeoutMs" | "caTimeoutMs" | "logLevel" | "interceptMode" | "captureBodies"
>> & LooperConfig = {
  traceDir: "~/.looper/traces",
  captureBodies: false,
  extensions: [],
  bridgeSocket: "",
  caCert: undefined,
  mitmdump: "mitmdump",
  logLevel: "info",
  interceptMode: "local",
  harnessEnv: {},
  readyTimeoutMs: 30_000,
  caTimeoutMs: 3_000,
  proxyPort: 8080,
  fanout: {
    enabled: false,
    concurrency: 8,
    maxParallel: 24,
    maxActiveModelRequests: 16,
    maxSpawns: 64,
    jobTtlMs: 1_200_000,
    jobIdleGraceMs: 20_000,
    supervisorTimeoutMs: 90_000,
    idleMs: 45_000,
    speculationCap: 4,
    killGraceMs: 2_000,
    readyPolicy: "wait",
  },
  router: { enabled: false, timeoutMs: 1_500, backend: "jev", memoCap: 32 },
  cache: { safeInterception: true, stableInjectionPosition: true, dedupeInjections: true, logMetrics: true },
  trace: { redactKeys: ["authorization", "cookie", "token", "api-key", "api_key", "secret", "password"], bodyCapChars: 0, mode: "redact" },
  security: { credentialPaths: ["~/.ssh", "~/.aws", "~/.config/gh", "~/.mitmproxy"], writableRoots: [], trustProjectConfig: false },
  reload: { debounceMs: 200, disposeGraceMs: 5_000, pollMs: 2_000 },
  extensionsConfig: {},
};

export interface HoldHandle {
  claim: Decision;
  resolve: (decision: Decision) => void;
}

export interface HookApi {
  flowId: FlowId;
  requestId: string;
  meta: FlowMeta;
  log: (msg: string, data?: unknown) => void;
  state: {
    get<T>(key: string): Promise<T | undefined>;
    set<T>(key: string, value: T): Promise<void>;
  };
  hold: (timeoutMs?: number) => HoldHandle;
  memo<T>(key: string, fn: () => Promise<T> | T): Promise<T>;
}

export type HookType = "request" | "responseheaders" | "response_chunk" | "response" | "error";
export type HookFn = (msg: BridgeInbound, api: HookApi) => Promise<Decision | void> | Decision | void;

export interface ProxyExtension {
  name: string;
  setup: (ctx: ExtensionContext) => void | Promise<void>;
}

export interface ProcSpawnOptions {
  harness?: string;
  args?: string[];
  cwd?: string;
  env?: Record<string, string>;
  mitmdump?: string;
  bridgeScript?: string;
  socketPath?: string;
  intercept?: string;
  caCert?: string | false;
}

export interface ProcContext {
  /** Original harness name as invoked via looper */
  harness: string;
  /** Original argv passed to harness (never mutated) */
  args: readonly string[];
  cwd: string;
  env: Record<string, string | undefined>;
  bin: string;
  intercept: string;
  bridgeScript: string;
  socketPath: string;
  /** Spawn a proxied subprocess. Defaults inherit the current looper/harness invocation details. */
  spawn: (overrides?: ProcSpawnOptions) => Promise<any>;
  /** Raw low-level spawnProxied */
  spawnProxied: (opts: any) => Promise<any>;
}

export interface ExtensionContext {
  on: (type: HookType, fn: HookFn, name?: string) => () => void;
  flows: FlowStoreLike;
  log: (...args: unknown[]) => void;
  state: { get<T>(key: string): Promise<T | undefined>; set<T>(key: string, value: T): Promise<void> };
  proc: ProcContext;
  /** Bounded, failure-safe memo shared across flows (router verdicts, classifications). */
  memo: <T>(key: string, fn: () => Promise<T> | T) => Promise<T>;
  /** Deterministic correlation id for a flow. */
  requestId: (flowId?: FlowId) => string;
  /** Claim a flow from extension code; resolve() delivers the decision to the bridge. */
  hold: (flowId: FlowId, timeoutMs?: number) => HoldHandle;
  /** Register a disposer that runs when THIS extension is reloaded or removed. */
  effect: (disposer: () => void) => void;
  /** This extension's namespaced config (`config.extensionsConfig[fileStem]`). */
  config: Record<string, unknown>;
  /** User-side policy markdown from ~/.looper and .looper (agents/skills/prompts). */
  resources: { agents: any[]; skills: any[]; prompts: any[] };
  /** One-wake-per-generation bus for parent follow-ups. */
  wake: { emit(generation: number, text: string): boolean; drain(): any[]; setBusy(v: boolean): void; pending: number };
}

export interface FlowStoreLike {
  get(id: FlowId): unknown;
  ensure(id: FlowId, meta?: Partial<FlowMeta>): unknown;
  getData<T>(id: FlowId, key: string): T | undefined;
  setData(id: FlowId, key: string, value: unknown): void;
}

export function defineExtension(ext: ProxyExtension | ((ctx: ExtensionContext) => void | Promise<void>)): ProxyExtension | ((ctx: ExtensionContext) => void | Promise<void>) {
  return ext;
}
