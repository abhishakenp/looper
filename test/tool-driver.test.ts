import { test, expect } from "bun:test";
import { workPackagesFromPixel, buildAugmentations, toolsFromRequest } from "../packages/core/src/workflows/tool-driver.js";

const T3 = { tools: [{ type: "function", function: { name: "subagent", description: "Spawns an agent in a child session", parameters: { type: "object", properties: { agent: {}, description: {}, prompt: {}, model: {}, sessionID: {} } } } }] };
const PI = { tools: [{ type: "function", function: { name: "subagent", description: "Delegate to isolated subagents", parameters: { type: "object", properties: { action: {}, agent: {}, task: {}, tasks: {}, chain: {}, dependsOn: {} } } } }] };

test("pixel scope output becomes deterministic work packages", () => {
  const w = workPackagesFromPixel({ targets: [{ path: "a.ts", tier: "P0" }, { path: "b.ts", tier: "P1" }] });
  expect(w.length).toBe(2);
  expect(w[0].priority).toBe("P0");
  expect(w[1].priority).toBe("P1");
  expect(w[0].ownership).toBe("write");
});

test("same work maps to each harness tool's own schema — no name branching", () => {
  const w = workPackagesFromPixel({ targets: [{ path: "a.ts", tier: "P0" }, { path: "b.ts", tier: "P1" }] });
  const t3 = buildAugmentations(toolsFromRequest(T3)[0], w);
  const pi = buildAugmentations(toolsFromRequest(PI)[0], w);
  expect(t3[0].field).toBe("prompt"); // T3 has prompt, no tasks
  expect(pi[0].field).toBe("tasks");  // Pi has tasks[]
  expect((pi[0].value as any[]).length).toBe(2);
});
