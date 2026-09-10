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
 */
import { loadProviders } from "../shared/providers.js";

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
