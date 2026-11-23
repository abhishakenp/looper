# Open Items / Risks

- [x] **mitmproxy local-mode semantics (macOS):** verified on macOS arm64, mitmproxy 12.2.3, redirector extension activated. `--mode local:<name>` captures child process HTTPS; readiness signal: "Local redirector started/successfully initialized". Proc must wait before spawning harness.
- [ ] **Bridge latency:** sync decision-per-hook over IPC; mitigate with fail-open timeout + “claim flow” async model for expensive hooks.
- [ ] **CA trust:** mitmproxy installs/uses CA; env/OS trust varies by harness/runtime. Need per-harness CA injection story (env vars cover many).
- [ ] **pi-durable API fit:** confirmed runtime/exports exist (`@earendil-works/pi-durable@1.6.0`); need spike to confirm embedding pattern for proxy hook points and FlowState-as-doc/service.
- [ ] **Socket death on crash:** accepted; durable control plane reconciles.
- [ ] **Python glue:** accepted for v1; bridge protocol versioned for future Rust capture daemon replacement.
- [ ] **Linux/Windows local capture:** not verified.
