// Vega-Lite engine: a fresh worker per render with a memory cap; a timeout (or
// the server's reset) terminates it, which is the CPU-time limit for this engine.
import { Worker } from "node:worker_threads";
const WORKER = new URL("./vega-worker.mjs", import.meta.url);
export function vegaEngine() {
  let current = null;
  return {
    render(source, { timeoutMs }) {
      return new Promise((resolve, reject) => {
        const w = new Worker(WORKER, { workerData: { source }, resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 } });
        current = w;
        let settled = false;
        const finish = (fn, v) => { if (settled) return; settled = true; clearTimeout(t); if (current === w) current = null; w.terminate().catch(() => {}); fn(v); };
        const t = setTimeout(() => finish(reject, Object.assign(new Error("timeout"), { crowTimeout: true })), timeoutMs);
        w.once("message", (m) => (m && typeof m.svg === "string" ? finish(resolve, m.svg) : finish(reject, new Error(String((m && m.error) || "render error")))));
        w.once("error", (e) => finish(reject, e));
        w.once("exit", (code) => finish(reject, new Error(code === 0 ? "render error" : "render error (worker exited)")));
      });
    },
    async reset() { const w = current; current = null; if (w) await w.terminate().catch(() => {}); },
  };
}
