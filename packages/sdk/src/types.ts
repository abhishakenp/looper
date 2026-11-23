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
}

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
  on: (type: HookType, fn: HookFn, name?: string) => void;
  flows: FlowStoreLike;
  log: (...args: unknown[]) => void;
  state: { get<T>(key: string): Promise<T | undefined>; set<T>(key: string, value: T): Promise<void> };
  proc: ProcContext;
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
