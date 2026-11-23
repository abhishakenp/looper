export type FlowId = string;

export type Decision =
  | { action: "pass" }
  | { action: "mutate"; request?: Partial<ProxyRequest>; response?: Partial<ProxyResponse> }
  | { action: "respond"; response: ProxyResponse }
  | { action: "drop" }
  | { action: "stream" }
  | { action: "buffer" };

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

export interface HookApi {
  flowId: FlowId;
  meta: FlowMeta;
  log: (msg: string, data?: unknown) => void;
  state: {
    get<T>(key: string): Promise<T | undefined>;
    set<T>(key: string, value: T): Promise<void>;
  };
}

export type HookType = "request" | "responseheaders" | "response_chunk" | "response" | "error";
export type HookFn = (msg: BridgeInbound, api: HookApi) => Promise<Decision | void> | Decision | void;
