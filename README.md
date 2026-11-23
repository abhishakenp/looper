# looper

Transparent process-scope proxy harness for any CLI agent harness.

## What it does
- Wraps any harness: `looper <harness> [...args]`
- Intercepts process network traffic via `mitmproxy --mode local` (Rust redirectors)
- TS/Bun core + thin Python bridge addon (NDJSON unix socket)
- Hot-reload extensions from `~/.looper/extensions` and `.looper/extensions`
- NDJSON trace with redaction; `looper trace tail|show`

## Core primitives
- Hooks: `request`, `responseheaders`, `response_chunk`, `response`, `error`
- Decisions: `pass | mutate | respond | drop | stream | buffer`
- Extension ctx: `{ on, flows, log, state, proc }`
- Durable file-backed state, core-owned FlowState
- `proc.spawn` for subprocess/subagent primitives

## Quick start
```bash
bun install
bunx tsc -p packages/sdk/tsconfig.json
bunx tsc -p packages/core/tsconfig.json
bunx tsc -p packages/cli/tsconfig.json
bun packages/cli/src/index.ts curl -sk https://example.com
```

## Extension example
```ts
export default function ({ on, log }: any) {
  on("request", (msg: any) => { log("req", msg.req?.url); return { action: "pass" }; });
}
```

## Status
v1 core implemented and hardened:
- P1 CA trust/env injection for child processes (NODE_EXTRA_CA_CERTS, SSL_CERT_FILE, REQUESTS_CA_BUNDLE, CURL_CA_BUNDLE, GIT_SSL_CAINFO, AWS_CA_BUNDLE, DENO_CERT).
- P2 async claim-flow (`api.hold()` / `claim` decision) with fail-open timeout.
- P3 SSE/stream reload stress verified (50 events, 3 reloads, 0 loss/dup); restart trace integrity verified.
- P4 pi-durable control-plane integration: defineDoc/defineDocFamily/defineTask/MemoryStorage contracts, LooperDurableRuntime, requestId/memo primitives.

Workflow plugins (pixel/jev/liza/subagent) remain user-side in global/project config.
See `docs/open-items.md`.
