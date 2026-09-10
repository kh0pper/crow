/**
 * perch-model-catalog — the SESSION-FREE model list.
 *
 * `perch-interactive.js`'s `options()` asks the live pi child what models it
 * has (`get_available_models`). That is authoritative for a running session
 * and useless for every other case: a hibernating session has no child (the
 * engine closes one on idle by design, and `adoptRow` brings a restart-
 * orphaned row back hibernating too), and the LAUNCHER has no session at all
 * — it is choosing a model for one that does not exist yet.
 *
 * Both of those need the same answer, so both get it from here. One source,
 * two callers: the hibernating fallback in `options()` and the launcher's
 * `GET /dashboard/perch-api/bots/:id/models`. Two lists that could disagree
 * about what this instance can serve is the defect class this module exists
 * to avoid.
 *
 * WHY `loadProviders()`. It is the DB-first, models.json-fallback registry
 * that already backs `model-availability.js`'s own `defaultDeps()` (:66) —
 * the established session-free path — and the DB read filters `disabled`
 * rows out for us (providers-db.js's `WHERE disabled = 0`).
 *
 * SHAPE. Entries mirror pi's own Model object (its rpc docs' `Model`:
 * `{id, name, provider, baseUrl, …}`), because the drawer, the launcher and
 * `annotateAvailability()` all read them by those names — `baseUrl` in
 * particular is what the availability probe addresses. Every field the
 * provider row carries on the model is preserved; `provider` and `baseUrl`
 * are stamped from the row that owns it.
 *
 * Availability is deliberately NOT decided here: this says what is
 * configured, `annotateAvailability()` says what is reachable, and the two
 * questions stay separable (a probe-free caller can still list).
 *
 * USABILITY, though, IS decided here. `annotateAvailability()` answers
 * "did anything answer at this address", which an embedding endpoint does —
 * on this instance `grackle-embed/qwen3-embedding-0.6b` and
 * `grackle-rerank/qwen3-reranker-0.6b` were listed reading "up" and were one
 * tap from becoming a session's model, which would fail every turn. Provider
 * rows tag those entries (`task: "embed"`, `task: "score"`; the model catalog
 * spells the same vocabulary "embedding"/"rerank" —
 * scripts/validate-model-catalog.js:75), so they are filtered out below.
 * Entries with NO task are kept: that is most of them (every `crow-local`
 * row), and they are chat models. `task: "vision"` is kept too, matching
 * models/manager.js's own `isChatClassRow` — a `-vl-…-instruct` model serves
 * chat completions.
 */
import { loadProviders } from "../shared/providers.js";

/**
 * Tasks a Perch session can never be driven by. An entry is EXCLUDED only
 * when it names one of these — absence means "chat" for every provider row
 * this instance has ever carried, and a strict allowlist would silently empty
 * the picker on any row that simply does not tag its models.
 */
const NON_CHAT_TASKS = new Set(["embed", "embedding", "rerank", "score", "classify"]);

/** Can a Perch session actually be served by this entry? */
export function chatCapable(m) {
  const task = m && typeof m.task === "string" ? m.task.toLowerCase() : null;
  return !(task && NON_CHAT_TASKS.has(task));
}

/**
 * Every model every enabled provider row declares, as pi-shaped entries.
 *
 * @param {{load?: () => {providers?: object}}} [deps] test seam — inject a
 *   provider config instead of reading the DB/models.json.
 * @returns {Array<{provider: string, id: string, baseUrl: string|null}>}
 */
export function providerModelList({ load = loadProviders } = {}) {
  let cfg = null;
  try {
    cfg = load();
  } catch {
    return [];                                   // no registry is an empty list, never a throw
  }
  const providers = (cfg && cfg.providers) || {};
  const out = [];
  for (const [provider, row] of Object.entries(providers)) {
    // `$`-prefixed keys are models.json schema meta, not providers.
    if (!row || provider.startsWith("$")) continue;
    const models = Array.isArray(row.models) ? row.models : [];
    for (const m of models) {
      // A provider row's `models` may hold bare id strings (the shape
      // loadModelOptions() in bot-builder tolerates) or full objects.
      const entry = typeof m === "string" ? { id: m } : m;
      const id = entry && entry.id;
      if (!id) continue;
      if (!chatCapable(entry)) continue;          // an embedding endpoint is not a model to talk to
      out.push({ ...entry, id: String(id), provider, baseUrl: row.baseUrl || null });
    }
  }
  return out;
}

/** "provider/id" — the key `definition.models.default`, `control()`'s model
 *  body and the drawer's `<option value>` all speak. */
export function modelKey(m) {
  return m && m.provider && m.id ? m.provider + "/" + m.id : null;
}

/**
 * The same list, but never the EMPTY-because-cold one.
 *
 * `loadProviders()` is synchronous by contract (providers.js: hot-path callers
 * that cannot be made async), so on a cold process it returns
 * `_cache || loadFromModelsJson()` and fires an UNAWAITED DB refresh. This
 * instance ships no models.json, so the first call after a gateway start
 * answers 0 models and the second, ~1.5 s later, answers all of them.
 *
 * Both of this module's callers are in the async path already and both are
 * harmed by that window: the launcher route would serve `{models: []}`, and a
 * hibernating session's `options()` would answer `[]` — which the drawer
 * renders as the empty, disabled dropdown this whole task exists to remove,
 * and `loadOptions` runs once per `openSession` and never retries.
 *
 * So: when the sync answer is empty, await ONE real refresh and ask again.
 * Discarding the cache is free in exactly that case, because the cache being
 * discarded is the empty one.
 */
export async function providerModelListWarm(deps) {
  const first = providerModelList(deps);
  if (first.length || (deps && deps.load)) return first;   // injected loader: no cache to warm
  try {
    const providers = await import("../shared/providers.js");
    await providers.invalidateAndRefreshProvidersCache();
  } catch {
    return first;                                          // no registry reachable; [] is the honest answer
  }
  return providerModelList(deps);
}
