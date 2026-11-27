# looper-bridge

The mitmproxy addon used by Looper. It listens on a unix socket, forwards proxy events (`request`, `responseheaders`, `response_chunk`, `response`, `error`, `done`) as NDJSON, and applies decisions returned by extensions.

This is an internal support package. You do not need to install it directly: [`looper-cli`](../cli/README.md) declares it as a dependency, and `looper` resolves `bridge.py` from that installed dependency.

## Install

```bash
bun add looper-bridge
# or
npm install looper-bridge
```

## Contents

- `bridge.py` — mitmproxy addon. Looper launches it with `mitmdump -s <path-to-bridge.py> --set looper_sock=<socket>`.

Protocol types live in [`looper-sdk`](../sdk/README.md) (`BridgeInbound`, `BridgeOutbound`, `Decision`).
