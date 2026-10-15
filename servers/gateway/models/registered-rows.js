/**
 * The Model Catalog's registered-models snapshot (models plan 3a): the
 * lifecycle listing (lifecycle.js `buildModelsListing`, via the shared core)
 * enriched with what the panel needs to decide its actions. Shared by
 * `GET /api/models/registered` and the panel's server render so the two
 * can never disagree. Pure apart from the core's own reads.
 */
import { doorKindOf } from "./door-resolve.js";
import { servingClassOf, startAffordance } from "./serving-class.js";

/**
 * @param {object} args
 * @param {object} args.core    a lifecycle core (lifecycle-core.js)
 * @param {object} args.catalog the model catalog ({ models: [...] })
 * @param {boolean} args.orchestrationDisabled
 * @param {object} [args.env]  environment (CROW_LLAMA_SERVER_BIN)
 * @returns {{ rows: object[], groups: string[], roles: string[], orchestrationDisabled: boolean, llamaServerBin: string|null }}
 */
export function registeredSnapshot({ core, catalog, orchestrationDisabled, env = process.env }) {
  const providers = core.providers() || {};
  const byCatalogId = new Map((catalog?.models || []).map((m) => [m.id, m]));
  const rows = core.listing().map((row) => {
    const gp = providers[row.provider]?.gpuPolicy || {};
    const catalogId = gp.catalogId ?? null;
    const model = catalogId ? byCatalogId.get(catalogId) : null;
    const servingClass = model ? servingClassOf(model) : null;
    const own = row.managed === "native" && row.status !== "foreign";
    const startable = !orchestrationDisabled && own && startAffordance(servingClass) === "start";
    return {
      ...row,
      catalogId,
      inCatalog: !!model,
      launch: gp.launch ?? null,
      alwaysResident: !!gp.alwaysResident,
      defaultMember: !!gp.defaultMember,
      servingClass,
      startable,
      // Edit / Unregister: own native rows only (external and foreign rows
      // are read-only here).
      own,
    };
  });
  const groups = [...new Set(rows.map((r) => r.mutexGroup).filter((g) => typeof g === "string" && g))].sort();
  // Suggested provider ids (spec §6): the enabled bundle rows' ids, the
  // roles a native model can later take over in a migration window.
  const roles = Object.entries(providers).filter(([, p]) => doorKindOf(p) === "bundle").map(([id]) => id).sort();
  // A host-level llama-server override from the environment is shown
  // read-only (it is set outside the dashboard).
  const llamaServerBin = typeof env?.CROW_LLAMA_SERVER_BIN === "string" && env.CROW_LLAMA_SERVER_BIN.trim() ? env.CROW_LLAMA_SERVER_BIN.trim() : null;
  return { rows, groups, roles, orchestrationDisabled: !!orchestrationDisabled, llamaServerBin };
}
