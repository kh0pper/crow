/**
 * External-engine marker (spec docs/superpowers/specs/2026-09-23-external-engine-provider-design.md §2.1).
 *
 * A provider row is an EXTERNAL ENGINE when
 *
 *   gpu_policy.engine = { managed: "external", host: "<machine label>", label?: "<engine name>" }
 *
 * Another machine runs it (raven's halogen). Crow never starts, warms,
 * evicts or idle-reverts to it; the only thing any instance ever sends it is
 * a read-only GET <base_url>/models (external-engine-poll.js). `host` is a
 * display/documentation label — NEVER a routing input; providers.host stays
 * "cloud" (PR #382: an unmanaged LAN endpoint is cloud, shown as "network").
 *
 * PURE and import-free on purpose: the orchestrator, providers-db's write
 * validation, the nest health signal and the Providers tab all read it, and
 * none of them may drag another's import chain along.
 */

export const ENGINE_FIELD_MAX = 64;

/** True iff the row is marked externally managed. Exact string match only. */
export function isExternalEngine(p) {
  return p?.gpuPolicy?.engine?.managed === "external";
}

/** Display info for a marked row: `{ host, label }` (trimmed; empty → null), or null if unmarked. */
export function externalEngineInfo(p) {
  if (!isExternalEngine(p)) return null;
  const e = p.gpuPolicy.engine;
  const clean = (v) => (typeof v === "string" && v.trim() ? v.trim() : null);
  return { host: clean(e.host), label: clean(e.label) };
}

/** Why a gpu_policy.engine value is malformed, or null when it is absent or valid. */
export function engineShapeError(engine) {
  if (engine === undefined || engine === null) return null;
  if (typeof engine !== "object" || Array.isArray(engine)) return "gpu_policy.engine must be an object";
  if (engine.managed !== "external") return 'gpu_policy.engine.managed must be exactly "external"';
  if (typeof engine.host !== "string" || !engine.host.trim() || engine.host.length > ENGINE_FIELD_MAX) {
    return `gpu_policy.engine.host must be a non-empty string of at most ${ENGINE_FIELD_MAX} characters`;
  }
  if (engine.label !== undefined && engine.label !== null
      && (typeof engine.label !== "string" || engine.label.length > ENGINE_FIELD_MAX)) {
    return `gpu_policy.engine.label must be a string of at most ${ENGINE_FIELD_MAX} characters`;
  }
  return null;
}

/** The contradiction spec §2.2 forbids: externally managed AND orchestratable here. */
export function externalEngineConflict({ bundleId, gpuPolicy } = {}) {
  if (gpuPolicy?.engine?.managed !== "external") return false;
  return (bundleId != null && bundleId !== "") || gpuPolicy.runtime === "native";
}

/** Thrown by acquireProvider (and the native start funnel) for a marked row. */
export class ExternalEngineError extends Error {
  constructor(providerName, engineHost = null) {
    super(`orchestrator: provider "${providerName}" is an external engine${engineHost ? ` on ${engineHost}` : ""} — Crow never starts, stops or swaps it`);
    this.name = "ExternalEngineError";
    this.code = "external_engine";
    this.provider = providerName;
    this.engineHost = engineHost;
  }
}
