/**
 * Cache-safe context injection — append a constant block AFTER the cached prefix.
 * Copy into ~/.looper/extensions/ to enable. See safeAppendContext for guarantees.
 */
import { parseBody, safeAppendContext } from "looper-core";

export default function ({ on, log, state }: any) {
  const seen = {
    get: <T>(k: string) => state.get<T>(k),
    set: <T>(k: string, v: T) => state.set(k, v),
  };
  on("request", async (msg: any) => {
    const body = parseBody(msg.req?.body);
    if (!body || body.__sse || typeof body !== "object") return { action: "pass" };
    const result = await safeAppendContext({
      body,
      key: "working-dir",
      context: `[working directory] ${process.cwd()}`,
      seen,
      log: (m: string) => log(m),
    } as any);
    if (result.boundary.cacheKey !== "none" && (log as any)) {
      log(`[cache] ${result.boundary.cacheKey} boundary=${result.boundary.boundaryIndex} injected=${result.injected}`);
    }
    return result.decision;
  }, "cache:inject");
}
