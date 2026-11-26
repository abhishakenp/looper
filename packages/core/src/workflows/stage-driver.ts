/**
 * Deterministic Liza stage driver through the looper proxy.
 *
 * Design (operator, 2026-11-25):
 *  - pixel does retrieval/planning/task decomposition (LLM is bad at it);
 *  - LLM is asked only for the MINIMUM shaped answer pixel cannot produce;
 *  - each stage runs in a FRESH-CONTEXT subagent via the harness's own tool
 *    call (full looper visibility, no hidden side channel);
 *  - human is asked only at real gates (via pixel-approve / pairing contract);
 *  - prompt/response patching uses cache-safe two-channel augmentation.
 *
 * The driver emits stage "briefs" — the exact minimum input for one LLM call —
 * and a fresh-context task spec for the harness subagent tool. It never calls
 * an LLM itself; it only shapes what the harness sends.
 */
import { stageChain, MANUAL_TRANSITIONS, type LizaEntryPoint } from "./liza.js";
import { workPackagesFromPixel, buildAugmentations, type WorkPackage } from "./tool-driver.js";
import { toolsFromRequest, detectSubagentToolsSmart, type ToolSignature } from "./subagent-smart.js";

export interface StageBrief {
  stage: string;
  rolePair: string;
  /** Deterministic facts from pixel/Liza CLI — never from LLM memory. */
  facts: string;
  /** The one question the LLM must answer (or undefined if pixel fully decided). */
  question?: string;
  /** Expected answer shape — JSON schema fragment, so response patching can validate. */
  answerShape?: Record<string, unknown>;
  /** Files this stage owns (from pixel scope-task). */
  files: string[];
  /** Human gate title, if this is a manual transition. */
  humanGate?: string;
  /** Fresh-context subagent task spec. */
  subagent: {
    agent: string;
    prompt: string;
    contextPack: string[]; // pixel evidence injected before the LLM sees anything
  };
}

export interface StagePlan {
  entry: LizaEntryPoint;
  chain: string[];
  briefs: StageBrief[];
  gates: string[];
}

export interface PixelFacts {
  targets?: Array<{ path: string; tier: string }>;
  tasks?: Array<{ id?: string; text?: string; files?: string[] }>;
  lizaStatus?: string;
  approvedRefs?: string[];
}

/** Build an entire deterministic stage plan from pixel output — no LLM calls. */
export async function buildStagePlan(
  entry: LizaEntryPoint,
  facts: PixelFacts,
  opts: { uncertain?: boolean; decider?: { decide(q: any): Promise<{ winner?: string; probabilities: Record<string, number> }> }; requestBody?: unknown } = {},
): Promise<StagePlan> {
  const chain = stageChain(entry, !!opts.uncertain);
  const work = workPackagesFromPixel(facts);
  const briefs: StageBrief[] = [];

  for (let i = 0; i < chain.length; i++) {
    const stage = chain[i];
    const stageWork = work.filter(w => i === 0 || w.priority === (i === chain.length - 1 ? "P0" : "P1"));
    const files = stageWork.flatMap(w => w.files || []);
    // Exact targets of the manual transitions in .liza/pipeline.yaml:
    // epic-to-us→us-writing-pair; us-to-coding→architecture-main-pair;
    // architecture-to-code-plan→code-planning-pair; code-plan-to-coding→coding-pair.
    const MANUAL_TARGETS = new Set(["us-writing-pair", "architecture-main-pair", "code-planning-pair", "coding-pair"]);
    const isManual = MANUAL_TARGETS.has(stage);
    briefs.push({
      stage,
      rolePair: stage,
      facts: [
        `entry=${entry}`,
        `stage=${i + 1}/${chain.length}`,
        `pixel targets=${files.join(",") || "none"}`,
        `liza status=${facts.lizaStatus || "unknown"}`,
        `approved refs=${(facts.approvedRefs || []).join(",") || "none"}`,
      ].join("\n"),
      // LLM is asked only for what pixel cannot decide deterministically.
      question: stage.includes("planning") || stage.includes("architect")
        ? "Return ONLY the bounded JSON shape below; pixel has already selected files and constraints. Do not explore the repo."
        : undefined,
      answerShape: stage.includes("planning") || stage.includes("architect")
        ? { type: "object", required: ["tasks"], properties: { tasks: { type: "array", items: { type: "object", required: ["id", "text"], properties: { id: { type: "string" }, text: { type: "string" }, files: { type: "array" } } } } } }
        : undefined,
      files,
      humanGate: isManual ? `gate:${stage}` : undefined,
      subagent: {
        agent: stage,
        prompt: `${stage} — work with pixel evidence only; do not re-explore.\n${facts.lizaStatus || ""}`,
        contextPack: [
          ...files.map(f => `pixel target ${f}`),
          ...(facts.approvedRefs || []).map(r => `approved ${r}`),
        ],
      },
    });
  }
  return { entry, chain, briefs, gates: briefs.filter(b => b.humanGate).map(b => b.humanGate!) };
}

/** Emit the harness tool call arguments for a stage using the detected tool's schema. */
export function stageSubagentArgs(plan: StagePlan, index: number, requestBody: unknown): Record<string, unknown> | null {
  const brief = plan.briefs[index];
  if (!brief) return null;
  const tools = toolsFromRequest(requestBody);
  // Semantic detection is done by the caller when a DecideClient is available;
  // here we pick the tool whose schema fits a fresh-context task.
  const tool = tools.find(t => "prompt" in (t.schema?.properties || {}) || "task" in (t.schema?.properties || {}) || "tasks" in (t.schema?.properties || {}));
  if (!tool) return null;
  const aug = buildAugmentations(tool, [{
    taskId: brief.stage,
    task: brief.subagent.prompt,
    files: brief.files,
    ownership: brief.files.length ? "write" : "read",
    context: brief.subagent.contextPack.join("\n"),
  }]);
  return Object.fromEntries(aug.map(a => [a.field, a.value]));
}
