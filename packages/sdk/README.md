# @looper/sdk

Shared TypeScript contracts used by Looper extensions, `@looper/core`, and `@looper/cli`. Runtime-agnostic: types plus `defineExtension` and `DEFAULT_LOOPER_CONFIG`.

## Install

```bash
bun add @looper/sdk
# or
npm install @looper/sdk
```

## Exports

- Decisions: `Decision` (`pass | mutate | respond | drop | stream | buffer | claim`)
- Bridge messages: `BridgeInbound`, `BridgeOutbound`, `ProxyRequest`, `ProxyResponse`, `ProxyResponseHeaders`, `ProxyChunk`, `ProxyError`, `FlowId`
- Hooks: `HookType`, `HookFn`, `HookApi`, `HoldHandle`
- Extensions: `ProxyExtension`, `ExtensionContext`, `FlowStoreLike`, `ProcContext`, `ProcSpawnOptions`, `defineExtension`
- Config: `LooperConfig`, `DEFAULT_LOOPER_CONFIG`
- Resources: `resources.agents`, `resources.skills`, `resources.prompts`

## Example extension

```ts
import { defineExtension, type HookFn } from "@looper/sdk";

export default defineExtension((ctx) => {
  const onRequest: HookFn = (msg, api) => {
    api.log("request", msg.t === "request" ? msg.req.url : "");
    return { action: "pass" };
  };

  ctx.on("request", onRequest);
  ctx.effect(() => console.log("[ext] unloaded"));
});
```

Load extensions from `~/.looper/extensions` or `<project>/.looper/extensions` when running `looper`.
