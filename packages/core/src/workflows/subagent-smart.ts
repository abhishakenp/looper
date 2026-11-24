/**
 * Harness-agnostic subagent tool detection — no name branching.
 *
 * Different harnesses name the spawn tool differently (`subagent`, `Task`,
 * `spawn_agent`, ...). Instead of a name set, ask ONE bounded Jev decision over
 * the tool's own description + parameter schema from the request body. The
 * schema is the call signature: a spawn tool has a prompt/task field plus
 * optional model/agent fields. The decision is memoised by exact signature;
 * failures fail open to the deterministic name probe, never a guessed tool.
 */
import type { DecisionQuestion } from "../decide.js";

export interface ToolSignature {
  name: string;
  description?: string;
  schema?: Record<string, any>;
}

export interface SmartDecider {
  decide(q: DecisionQuestion): Promise<{ winner?: string; probabilities: Record<string, number> }>;
}

const LABELS = ["subagent_spawn", "ordinary_tool"] as const;

export function toolsFromRequest(requestBody: any): ToolSignature[] {
  const b = typeof requestBody === "string" ? (() => { try { return JSON.parse(requestBody); } catch { return {}; } })() : requestBody;
  const tools = b?.tools || b?.functions || [];
  return tools.map((t: any) => {
    const fn = t.function || t;
    return { name: String(fn.name || ""), description: typeof fn.description === "string" ? fn.description : "", schema: fn.parameters || fn.input_schema || {} };
  }).filter((t: ToolSignature) => !!t.name);
}

export function signatureText(t: ToolSignature): string {
  const props = t.schema?.properties || {};
  return [
    `tool name: ${t.name}`,
    `description: ${(t.description || "").slice(0, 600)}`,
    `parameters: ${Object.keys(props).slice(0, 20).join(", ")}`,
    `required: ${(t.schema?.required || []).join(", ")}`,
  ].join("\n");
}

const NAME_HINT = /(subagent|spawn[_ -]?agent|delegate|task[_ -]?tool|^task$|^agent$)/i;

/** Semantic detection. Returns the tools judged to spawn subagents. */
export async function detectSubagentToolsSmart(
  requestBody: unknown,
  decider: SmartDecider,
  opts: { threshold?: number; signal?: (m: string) => void } = {},
): Promise<{ tools: ToolSignature[]; via: "semantic" | "fallback"; raw?: any }> {
  const threshold = opts.threshold ?? 0.5;
  const tools = toolsFromRequest(requestBody);
  if (!tools.length) return { tools: [], via: "semantic" };
  try {
    // One question per tool, bounded: descriptions are short and labels are fixed.
    const judged = await Promise.all(tools.map(async (t) => {
      const r = await decider.decide({
        text: signatureText(t),
        context: "Does this tool spawn another agent/subagent to do work asynchronously? Judge from its schema and description, not its name.",
        labels: [...LABELS],
        criteria: {
          subagent_spawn: "launches a child agent/session with a prompt and returns a session id or async result",
          ordinary_tool: "edits files, searches, runs shell, fetches web, or reads state",
        },
      });
      return { t, p: r.probabilities?.subagent_spawn ?? 0, winner: r.winner };
    }));
    const accepted = judged.filter(j => j.p >= threshold && j.winner === "subagent_spawn").map(j => j.t);
    opts.signal?.(`[subagent-smart] judged ${tools.length} tool(s), accepted ${accepted.length}`);
    return { tools: accepted, via: "semantic", raw: judged };
  } catch (e) {
    // Fail-open: deterministic name probe only, explicitly labelled fallback.
    opts.signal?.(`[subagent-smart] fail-open: ${String(e).slice(0, 120)}`);
    return { tools: tools.filter(t => NAME_HINT.test(t.name)), via: "fallback" };
  }
}
