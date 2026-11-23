/**
 * The decision seam — `pixel classify --jsonl` behind one warm child.
 *
 * This is the same seam ultraflow uses (`flow/crates/pixel-flow-plugin/src/decider.rs`):
 * one bounded question in, one distribution out. No regex parsing of LLM prose,
 * no separate Jev binary. The hosted Jev preset returns native calibrated
 * probabilities; other presets (ollaya/remote/local) are selectable by config.
 */
import { WarmProcess } from "./warm-process.js";
import { MemoStore } from "./memo.js";

export interface DecisionQuestion {
  /** What varies cycle to cycle — the state to judge. */
  text: string;
  /** Framing identical for every label — the question and the rules. */
  context?: string;
  /** Bounded label set. Never invent labels. */
  labels: string[];
  /** Criterion text per label. */
  criteria?: Record<string, string>;
}

export interface DecisionOutcome {
  /** Highest probability among OFFERED labels; earliest on an exact tie. */
  winner?: string;
  winnerIndex?: number;
  probabilities: Record<string, number>;
  predicted?: string;
  model?: string;
  provider?: string;
  confidence?: string;
  epistemics?: Record<string, unknown>;
}

export interface DecideOptions {
  preset?: "jev" | "openrouter" | "ollama" | "local" | "deepseek" | "opencode-go" | "openai" | "clef-ollama" | "clef-cloudflare";
  model?: string;
  engine?: "remote" | "ollaya";
  ollayaUrl?: string;
  timeoutMs?: number;
  memoCap?: number;
  maxLabels?: number;
  log?: (...args: unknown[]) => void;
}

/** Arbitrary labels are never candidates; earliest offered label wins a tie. */
export function argmax(probabilities: Record<string, number>, labels: string[]): { winner?: string; winnerIndex?: number } {
  let best: { index: number; p: number } | undefined;
  for (let i = 0; i < labels.length; i++) {
    const p = probabilities[labels[i]];
    if (typeof p !== "number" || !Number.isFinite(p)) continue;
    if (!best || p > best.p) best = { index: i, p };
  }
  return best ? { winner: labels[best.index], winnerIndex: best.index } : {};
}

export class DecideClient {
  private warm: WarmProcess;
  private memo: MemoStore;
  private opts: Required<Pick<DecideOptions, "preset" | "timeoutMs" | "memoCap" | "maxLabels">> & DecideOptions;

  constructor(opts: DecideOptions = {}) {
    this.opts = { preset: "jev", timeoutMs: 5_000, memoCap: 32, maxLabels: 64, ...opts };
    const args = ["classify", "--jsonl", "--metrics", "off", "--remote-preset", this.opts.preset];
    if (this.opts.model) args.push("--remote-model", this.opts.model);
    if (this.opts.engine) args.push("--engine", this.opts.engine);
    if (this.opts.ollayaUrl) args.push("--ollaya-url", this.opts.ollayaUrl);
    this.warm = new WarmProcess({
      cmd: "pixel",
      args,
      cwd: process.cwd(),
      timeoutMs: this.opts.timeoutMs,
      rawLine: true,
      log: (m) => this.opts.log?.("[decide]", m),
    });
    this.memo = new MemoStore(this.opts.memoCap);
  }

  get pending() { return this.warm.pending; }
  close() { this.warm.close(); }

  /** One bounded question, memoised by exact question; failures are never memoised. */
  async decide(q: DecisionQuestion): Promise<DecisionOutcome> {
    if (!q.labels.length) throw new Error("DecisionQuestion needs at least one label");
    if (q.labels.length > this.opts.maxLabels) throw new Error(`too many labels (${q.labels.length} > ${this.opts.maxLabels})`);
    const key = JSON.stringify([q.text, q.context, q.labels, q.criteria]);
    return this.memo.get(key, async () => {
      const spec = {
        text: q.text,
        context: q.context || "",
        labels: q.labels,
        criteria: q.criteria || {},
      };
      const raw = await this.warm.request(JSON.stringify(spec));
      let msg: any;
      try { msg = JSON.parse(raw); } catch { throw new Error(`decide: invalid reply: ${raw.slice(0, 200)}`); }
      if (!msg.ok) throw new Error(`decide: ${msg.error || "refused"}`);
      const probabilities: Record<string, number> = {};
      for (const label of q.labels) {
        if (typeof msg.probs?.[label] === "number") probabilities[label] = msg.probs[label];
      }
      return {
        ...argmax(probabilities, q.labels),
        probabilities,
        predicted: msg.predicted,
        model: msg.snapshot?.model,
        provider: msg.snapshot?.provider,
        confidence: msg.epistemics?.confidence,
        epistemics: msg.epistemics,
      };
    });
  }

  /** Convenience: classify an LLM response into named buckets for a workflow. */
  async classifyResponse(text: string, labels: string[], criteria: Record<string, string>, context?: string) {
    return this.decide({ text, labels, criteria, context });
  }
}
