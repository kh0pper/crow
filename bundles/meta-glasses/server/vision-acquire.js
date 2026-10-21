/**
 * Ask the GPU orchestrator to make a vision provider resident before a look
 * turn calls it. Best effort: it never throws, so the vision call always goes
 * ahead and surfaces its own error.
 *
 * Two refusals are expected states, not faults, and stay quiet:
 *   - model_orchestration_disabled: this host never starts models
 *     (CROW_DISABLE_MODEL_ORCHESTRATION); the provider is dialed as-is;
 *   - external_engine: the provider is another box's engine that Crow never
 *     starts, stops or swaps.
 * Anything else is logged once through `warn`.
 *
 * @param {{ acquire: ((providerId: string) => Promise<unknown>) | null, providerId: string, warn?: (msg: string) => void }} args
 */
const QUIET = new Set(["model_orchestration_disabled", "external_engine"]);

export async function acquireVisionProvider({ acquire, providerId, warn = (m) => console.warn(m) }) {
  try {
    if (typeof acquire !== "function") throw new Error("orchestrator unavailable");
    await acquire(providerId);
  } catch (err) {
    if (QUIET.has(err?.code)) return;
    warn(`[meta-glasses] gpu-orchestrator acquire(${providerId}) failed: ${err?.message || err}`);
  }
}
