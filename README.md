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
v1 core primitives implemented. Workflow plugins (pixel/jev/liza/subagent) are user-side.
See `docs/open-items.md`.
