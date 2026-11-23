# Open Items / Risks (v1)

- **mitmproxy local-mode semantics:** verify process-scoping syntax/behavior on macOS 12.2.3 for child-process capture; confirm inbound+outbound coverage for our harness targets.
- **Bridge latency:** sync decision-per-hook over IPC; mitigate with fail-open timeout + “claim flow” async model for expensive hooks.
- **CA trust:** mitmproxy installs/uses CA; env/OS trust varies by harness/runtime. Need per-harness CA injection story (env vars cover many).
- **pi-durable API fit:** confirmed runtime/exports exist (`@earendil-works/pi-durable@1.6.0`); need spike to confirm embedding pattern for proxy hook points and FlowState-as-doc/service.
- **Socket death on crash:** accepted; durable control plane reconciles.
- **Python glue:** accepted for v1; bridge protocol versioned for future Rust capture daemon replacement.
