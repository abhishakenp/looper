# looper-core

Runtime core for Looper: unix-socket bridge server, flow state, hook dispatch, durable state/control plane, subprocess proxying, and proxy workflows.

Most users should install [`looper-cli`](../cli/README.md), which depends on this package. Install this directly only to embed Looper in another program.

## Install

```bash
bun add looper-core
# or
npm install looper-core
```

## Exports

- Bridge and flows: `BridgeServer`, `FlowStore`, `HookRegistry`, `FlowState`
- Proxying: `spawnProxied`, `resolveHarnessBinary`, `buildCaEnv`, `resolveMitmCa`
- State: `DurableState`, `DurableControlPlane`, `LooperDurableRuntime`, `MemoStore`, `WakeBus`, `stateRoot`
- Config: `loadConfig`, `expandTilde`
- Safety and workflows: `safeAppendContext`, `assertAllowedPath`, `canonicalPath`, `isCredentialPath`, `OwnershipBroker`, `preRunVerify`, `VerificationGate`, `detect*`, `inject*`, `liza*`, `toolcall*`, `channels*`, `subagent*`

Types such as `BridgeInbound` and `Decision` come from [`looper-sdk`](../sdk/README.md).

## Example

```ts
import { FlowStore, HookRegistry } from "looper-core";

const flows = new FlowStore();
const hooks = new HookRegistry(flows);

hooks.on("request", (msg) => {
  console.log(msg.t === "request" ? msg.req.url : msg.t);
  return { action: "pass" };
});
```

Check `dist/index.d.ts` for the complete exported surface.
