/**
 * Generic tool driver: pixel decides WHAT should run; the harness's own tool
 * call is where it runs. This keeps every subagent visible through looper's
 * request/response hooks — no hidden side channel, no per-harness branching.
 *
 * Flow:
 *  1. detect subagent tool from request body (schema-driven, via Jev)
 *  2. pixel (scope-task/plan/task-state) produces deterministic work packages
 *  3. augment the harness's tool-call arguments in SSE chunks (each package)
 *  4. harness executes its own tool; looper sees the child's traffic (shim/pid)
 *  5. responses feed back as tool results; one wake per generation
 */
import { detectSubagentToolsSmart, type ToolSignature } from "./subagent-smart.js";
import { ToolCallAccumulator } from "./toolcall.js";
import { safeAppendContext } from "./inject.js";
import type { LooperSubtask } from "../scheduler.js";

export interface WorkPackage {
  taskId: string;
  task: string;
  files?: string[];
  ownership?: "read" | "write";
  dependsOn?: string[];
  priority?: "P0" | "P1";
  context?: string; // pixel evidence pack attached to the child
}

export interface DriverDecision {
  tools: ToolSignature[];
  via: "semantic" | "fallback";
  work: WorkPackage[];
  augmentations: Array<{ tool: string; field: string; value: unknown }>;
}

export interface DecideLike {
  decide(q: { text: string; context?: string; labels: string[]; criteria: Record<string, string> }): Promise<{ winner?: string; probabilities: Record<string, number> }>;
}

/** Deterministic work-package builder from pixel output. No LLM decides fan-out. */
export function workPackagesFromPixel(pixelOutput: {
  targets?: Array<{ path: string; tier: string }>;
  tasks?: Array<{ id?: string; text?: string; files?: string[]; dependsOn?: number[] }>;
}, contextPrefix = "[looper pixel context]"): WorkPackage[] {
  const out: WorkPackage[] = [];
  if (pixelOutput.tasks?.length) {
    pixelOutput.tasks.forEach((t, i) => out.push({
      taskId: t.id || `pixel-${i}`,
      task: t.text || "",
      files: t.files,
      ownership: t.files?.length ? "write" : "read",
      dependsOn: (t.dependsOn || []).map(n => `pixel-${n - 1}`),
      priority: i === 0 ? "P0" : "P1",
      context: contextPrefix,
    }));
  } else if (pixelOutput.targets?.length) {
    pixelOutput.targets.forEach((t, i) => out.push({
      taskId: `scope-${i}`,
      task: `Work on ${t.path} (tier ${t.tier})`,
      files: [t.path],
      ownership: "write",
      priority: t.tier === "P0" ? "P0" : "P1",
      context: contextPrefix,
    }));
  }
  return out;
}

/** Map work packages onto the harness tool's OWN dispatch shape, inferred from schema. */
export function buildAugmentations(tool: ToolSignature, work: WorkPackage[]): DriverDecision["augmentations"] {
  const props = tool.schema?.properties || {};
  const out: DriverDecision["augmentations"] = [];
  // Single dispatch field vs parallel/chain fields — decided by the schema, not a name.
  if ("tasks" in props) {
    out.push({ tool: tool.name, field: "tasks", value: work.map(w => ({
      agent: w.taskId, task: w.task, files: w.files, ownership: w.ownership, dependsOn: w.dependsOn,
    })) });
  } else if ("prompt" in props) {
    out.push({ tool: tool.name, field: "prompt", value: work.map(w => `${w.task}\n${w.context || ""}`).join("\n---\n") });
  } else if ("task" in props) {
    out.push({ tool: tool.name, field: "task", value: work.map(w => `${w.task}\n${w.context || ""}`).join("\n---\n") });
  }
  return out;
}

/** Main entry: from a request body + pixel output + decider, produce the plan. */
export async function driveWithPixel(
  requestBody: unknown,
  pixelOutput: { targets?: any[]; tasks?: any[] },
  decider: DecideLike,
): Promise<DriverDecision> {
  const detected = await detectSubagentToolsSmart(requestBody, decider);
  const work = workPackagesFromPixel(pixelOutput);
  const augmentations = detected.tools.length && work.length ? buildAugmentations(detected.tools[0], work) : [];
  return { tools: detected.tools, via: detected.via, work, augmentations };
}
