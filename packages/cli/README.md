# @looper/cli

Looper wraps any CLI agent harness in a transparent, process-scoped HTTPS proxy. Extensions observe and decide on requests/responses through a unix-socket bridge, with NDJSON traces and file-backed durable state.

## Requirements

- Bun (`#!/usr/bin/env bun` shebang on the `looper` binary)
- mitmproxy — `mitmdump` on PATH (12.x verified)

## Install

```bash
npm install -g @looper/cli
# or
bun add -g @looper/cli
```

## Usage

```bash
looper <harness> [args...]        # run harness through the proxy
looper trace tail [file]          # follow latest ~/.looper/traces/*.ndjson
looper trace show [file]          # print a trace
```

Example:

```bash
looper curl -sk https://example.com
```

## Configuration

Layered config is loaded from `~/.looper` and `<project>/.looper`; project layers are trust-gated. Extensions live in `~/.looper/extensions` and `<project>/.looper/extensions` and hot-reload on change. Markdown policy files under `~/.looper/{agents,skills,prompts}` and the project equivalent are exposed to extensions as `ctx.resources`.

Common config keys: `extensions`, `traceDir`, `trace.redactKeys`, `trace.mode`, `interceptMode`, `proxyPort`, `captureScope`, `harnessEnv`, `reload.debounceMs`. The full type is `LooperConfig` in [`@looper/sdk`](../sdk/README.md).

CA trust env vars (`NODE_EXTRA_CA_CERTS`, `SSL_CERT_FILE`, `REQUESTS_CA_BUNDLE`, `CURL_CA_BUNDLE`, `GIT_SSL_CAINFO`, `AWS_CA_BUNDLE`, `DENO_CERT`) are injected into the child process so the mitmproxy CA is trusted.

## Extensions

```ts
import { defineExtension, type HookFn } from "@looper/sdk";

export default defineExtension((ctx) => {
  ctx.on("request", ((msg) => {
    ctx.log("request", msg.t === "request" ? msg.req.url : msg.t);
    return { action: "pass" };
  }) as HookFn);
});
```

Hooks: `request`, `responseheaders`, `response_chunk`, `response`, `error`. Decisions: `pass`, `mutate`, `respond`, `drop`, `stream`, `buffer`, `claim` (async via `api.hold()` / `ctx.hold()`).

## Dependencies

- [`@looper/core`](../core/README.md) — proxy core
- [`@looper/sdk`](../sdk/README.md) — shared types
- [`@looper/bridge`](../bridge/README.md) — mitmproxy addon
