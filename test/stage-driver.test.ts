import { test, expect } from "bun:test";
import { buildStagePlan, stageSubagentArgs } from "../packages/core/src/workflows/stage-driver.js";

const FACTS = { targets: [{ path: "a.ts", tier: "P0" }], lizaStatus: "ok", approvedRefs: ["specs/vision.md"] };

test("stage plan follows Liza chain with exact manual gates", async () => {
  const p = await buildStagePlan("general-objective", FACTS);
  expect(p.chain).toEqual(["epic-planning-pair", "us-writing-pair", "architecture-main-pair", "architecture-pair", "code-planning-pair", "coding-pair"]);
  expect(p.gates).toEqual(["gate:us-writing-pair", "gate:architecture-main-pair", "gate:code-planning-pair", "gate:coding-pair"]);
  expect(p.briefs.every(b => b.subagent.contextPack.length > 0)).toBe(true);
});

test("stage args come from the harness tool schema, not a name list", async () => {
  const p = await buildStagePlan("general-objective", FACTS);
  const t3 = { tools: [{ type: "function", function: { name: "subagent", description: "spawn", parameters: { type: "object", properties: { agent: {}, prompt: {} } } } }] };
  const pi = { tools: [{ type: "function", function: { name: "subagent", description: "spawn", parameters: { type: "object", properties: { action: {}, tasks: {} } } } }] };
  expect("prompt" in stageSubagentArgs(p, 0, t3)!).toBe(true);
  expect("tasks" in stageSubagentArgs(p, 0, pi)!).toBe(true);
});
