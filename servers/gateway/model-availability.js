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
 *   "up"          something answered at the model's baseUrl
 *   "on_demand"   nothing answered (or there is no baseUrl), but this gateway
 *                 can warm the provider — a bundle it owns, directly or through
 *                 the alias→sibling resolution resolveWarmableProviderName does
 *   "unavailable" nothing answered, and nothing here will start it
 *
 * WHY THIS PROBES RATHER THAN ASKING THE ORCHESTRATOR. The first version
 * delegated to gpu-orchestrator's `isProviderReady()`. On a live instance that
 * marked 14 of 16 models "not running", including seven Z.AI cloud models that
 * work perfectly, for two independent reasons:
 *
 *   1. `isProviderReady` requires a 2xx, because it answers a RESIDENCY
 *      question. An authenticated cloud API answers 401 to an unauthenticated
 *      probe, and a 401 proves the endpoint is up.
 *   2. It resolves the provider through the orchestrator's own provider config.
 *      `crow-local-122b` answered 200 on :8004 and was still reported
 *      unavailable, because that lookup did not carry the row.
 *
 * Availability and residency are different questions. This asks only "did
 * anything answer at this address", against the `baseUrl` pi already puts on
 * every model entry, so neither the 2xx rule nor the config lookup applies.
 * A refused connection — nothing listening at all — stays the real negative.
 *
 * gpu-orchestrator is still imported DYNAMICALLY, and only for the warmability
 * question, and only when the caller injects no seams. That keeps its
 * child_process/db chain out of the dashboard render path and out of the unit
 * test, the same discipline provider-health.js's header spells out.
 */

/** @typedef {"up"|"on_demand"|"unavailable"} Availability */

const PROBE_TIMEOUT_MS = 2_000;

/**
 * Did anything answer at this base URL? Returns the HTTP status, or throws.
 * Any status counts — see the header: a 401 from a cloud API means "up".
 */
async function defaultFetchStatus(baseUrl) {
  const res = await fetch(`${baseUrl.replace(/\/+$/, "")}/models`, {
    signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
  });
  return res.status;
}

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
    fetchStatus: defaultFetchStatus,
    resolveWarmable: (name) => orch.resolveWarmableProviderName(cfg, name),
  };
}

/**
 * Annotate each model with `availability`. Additive: every field on the input
 * entry is preserved.
 *
 * Probes once per distinct baseUrl, not once per model and not once per
 * provider — several provider rows routinely alias the same endpoint (on this
 * instance `crow-local`, `crow-chat`, `crow-swap-coder` and `crow-swap-deep`
 * all point at :8003), so per-provider probing would hit one port four times.
 *
 * Never throws and never drops a model. A probe that fails for any reason falls
 * through to the warmability question, and then to "unavailable", which is the
 * honest answer: we could not confirm anything is there.
 *
 * @param {Array<object>|null|undefined} models
 * @param {{fetchStatus?: (baseUrl:string)=>Promise<number>,
 *          resolveWarmable?: (name:string)=>string|null}} [deps]
 * @returns {Promise<Array<object & {availability: Availability}>>}
 */
export async function annotateAvailability(models, deps) {
  const list = Array.isArray(models) ? models : [];
  if (list.length === 0) return [];

  const { fetchStatus, resolveWarmable } = deps || (await defaultDeps());

  const urls = [...new Set(list.map((m) => m && m.baseUrl).filter(Boolean))];
  const answered = new Map();
  await Promise.all(
    urls.map(async (url) => {
      try {
        const status = await fetchStatus(url);
        answered.set(url, Number.isFinite(status));
      } catch {
        answered.set(url, false); // nothing listening
      }
    })
  );

  const warmable = new Map();
  const warmableFor = (name) => {
    if (!warmable.has(name)) {
      let target = null;
      try {
        target = resolveWarmable(name);
      } catch {
        target = null;
      }
      warmable.set(name, target);
    }
    return warmable.get(name);
  };

  return list.map((m) => {
    const url = m && m.baseUrl;
    if (url && answered.get(url)) return { ...m, availability: "up" };
    const name = m && m.provider;
    return { ...m, availability: name && warmableFor(name) ? "on_demand" : "unavailable" };
  });
}
