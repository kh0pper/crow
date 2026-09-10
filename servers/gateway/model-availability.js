/**
 * model-availability — can a bot actually USE this model right now?
 *
 * The interactive drawer's model picker lists every model the instance's
 * provider rows declare. That list says nothing about whether anything is
 * listening, so a row pointing at a port that only comes up inside a
 * hand-run window (`crow-dsv4` → 127.0.0.1:8020 is the live example) sits in
 * the dropdown looking exactly like a working choice, and every turn that
 * picks it fails on connection refused.
 *
 * Three states, because "reachable" alone would be a lie about on-demand
 * providers — the gateway genuinely will start those when a turn asks:
 *
 *   "up"          the provider answers a probe right now
 *   "on_demand"   silent, but this gateway can warm it (a bundle it owns,
 *                 directly or through the alias→sibling resolution
 *                 resolveWarmableProviderName does)
 *   "unavailable" silent, and nothing here will start it — a windowed
 *                 endpoint, or a bundle that belongs to a peer instance
 *
 * gpu-orchestrator is imported DYNAMICALLY, and only when the caller does not
 * inject its own seams. That keeps the orchestrator's child_process/db chain
 * out of the dashboard render path and out of the unit test, the same
 * discipline provider-health.js's header spells out for the same reason.
 */

/** @typedef {"up"|"on_demand"|"unavailable"} Availability */

async function defaultDeps() {
  const [orch, providers] = await Promise.all([
    import("./gpu-orchestrator.js"),
    import("../shared/providers.js"),
  ]);
  // resolveWarmableProviderName takes the provider config explicitly (no
  // default), and gpu-orchestrator's own loadProviders is a private one-line
  // wrapper around this same cached loader.
  const cfg = providers.loadProviders();
  return {
    isProviderReady: orch.isProviderReady,
    resolveWarmable: (name) => orch.resolveWarmableProviderName(cfg, name),
  };
}

/**
 * Annotate each model with `availability`. Additive: every field on the input
 * entry is preserved.
 *
 * Probes once per PROVIDER, not once per model — several models routinely share
 * one provider, and on an instance with a dozen rows the difference is a dozen
 * probes instead of one per dropdown entry.
 *
 * Never throws and never drops a model. A probe that fails for any reason
 * (network, a provider name the orchestrator does not know) resolves to
 * "unavailable", which is the honest answer: we could not confirm it works.
 *
 * @param {Array<object>|null|undefined} models
 * @param {{isProviderReady?: (name:string)=>Promise<boolean>,
 *          resolveWarmable?: (name:string)=>string|null}} [deps]
 * @returns {Promise<Array<object & {availability: Availability}>>}
 */
export async function annotateAvailability(models, deps) {
  const list = Array.isArray(models) ? models : [];
  if (list.length === 0) return [];

  const { isProviderReady, resolveWarmable } = deps || (await defaultDeps());

  const providers = [...new Set(list.map((m) => m && m.provider).filter(Boolean))];
  const state = new Map();
  await Promise.all(
    providers.map(async (name) => {
      let ready = false;
      try {
        ready = !!(await isProviderReady(name));
      } catch {
        ready = false;
      }
      if (ready) return void state.set(name, "up");
      let warmable = null;
      try {
        warmable = resolveWarmable(name);
      } catch {
        warmable = null;
      }
      state.set(name, warmable ? "on_demand" : "unavailable");
    })
  );

  return list.map((m) => ({
    ...m,
    availability: state.get(m && m.provider) || "unavailable",
  }));
}
