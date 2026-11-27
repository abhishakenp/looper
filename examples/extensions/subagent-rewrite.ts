/**
 * Live chunk-level subagent call rewrite. Injects deterministic context into
 * the subagent tool's arguments before the harness executes it.
 */
import { ToolCallAccumulator } from "looper-core";

const G = globalThis as any;
G.__looper_acc = G.__looper_acc || new Map();

export default function ({ on, log }: any) {
  on("response_chunk", (msg: any) => {
    if (msg.chunk?.done) return { action: "pass" };
    const raw = msg.chunk?.data;
    if (!raw) return { action: "pass" };
    let s: string;
    try { s = Buffer.from(raw, "base64").toString("utf8"); } catch { return { action: "pass" }; }
    const chunks = ToolCallAccumulator.parseSse(s);
    if (!chunks.length) return { action: "pass" };
    const fid = msg.id;
    let acc: ToolCallAccumulator = G.__looper_acc.get(fid);
    if (!acc) { acc = new ToolCallAccumulator(); G.__looper_acc.set(fid, acc); }
    for (const c of chunks) acc.pushTracked(c);
    for (const call of acc.subagentCalls()) {
      const rw = acc.completeRewrite(call.index, "[looper] injected deterministic task context");
      if (rw) {
        const out = ToolCallAccumulator.rewriteRawArguments(s, rw.current, rw.replacement);
        if (out !== s) {
          log("[subagent-rewrite] mutated chunk", call.name, "prefix", rw.prefixLen);
          return { action: "mutate", chunk: { data: Buffer.from(out).toString("base64") } };
        }
      }
    }
    return { action: "pass" };
  }, "subagent:rewrite");
}
