/**
 * Legacy native provider rows → current gpu_policy shape (queue item 33).
 *
 * Native rows registered before the catalog/port fields existed carry only
 * `{ runtime: "native", mutexGroup }`. The Model Catalog offers Edit (the
 * re-register that repairs a row and re-records its port reservation) only
 * when `gpu_policy.catalogId` resolves (`registered-rows.js` inCatalog), so
 * such a row could not be edited or repaired from the dashboard.
 *
 * The boot upgrade fills ONLY missing keys:
 *   catalogId  the one catalog model the row serves (row.models[].id — the
 *              same "ours" test `registerModel` applies)
 *   port       from a loopback base_url (`http://127.0.0.1:<port>/...`)
 *   quant      when exactly one local registry entry has that catalogId
 *   owner      this instance's id
 * and only on rows this instance owns: `gpu_policy.owner` equal to our id, or
 * (no owner recorded) `instance_id` equal to our id.
 *
 * Why that ownership test is sound here: `instance_id` records the row's LAST
 * WRITER (upsertProvider stamps the local id on every write), not its owner.
 * But the upgrade only ever touches rows with a loopback base_url, and
 * loopback rows never replicate (instance-sync `shouldSyncRow` gates both
 * emit and apply), so such a row can only have been written on this host; a
 * foreign instance_id there means a copied/restored DB, and we skip it. The
 * same rule means the write never syncs to a peer, so it cannot cause lamport
 * churn.
 *
 * All or nothing: a row whose base_url is not loopback with a valid port is
 * skipped entirely — writing `owner` without `port` would make `nativePort`
 * return null for a row that starts fine today. A recorded port that
 * disagrees with the base_url is skipped too. A row is written only when it
 * gains a catalogId or a port; a complete row plans nothing, so the upgrade
 * is idempotent.
 */
import { isDoorUrl } from "./door-resolve.js";
import { isExternalEngine } from "../../shared/provider-engine.js";

const LOOPBACK_HOSTS = new Set(["127.0.0.1", "localhost", "[::1]"]);

function hasKey(gp, key) {
  return gp[key] !== undefined && gp[key] !== null && gp[key] !== "";
}

function ownedHere(row, ownInstanceId) {
  if (!ownInstanceId) return false;
  const owner = row.gpuPolicy?.owner;
  if (owner) return owner === ownInstanceId;
  return row.instance_id === ownInstanceId;
}

function loopbackPort(baseUrl) {
  if (typeof baseUrl !== "string" || isDoorUrl(baseUrl)) return null;
  let url;
  try { url = new URL(baseUrl); } catch { return null; }
  if (url.protocol !== "http:" || !LOOPBACK_HOSTS.has(url.hostname.toLowerCase())) return null;
  const port = Number(url.port);
  return Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : null;
}

function matchCatalogId(row, catalog) {
  const ids = new Set((catalog?.models || []).map((m) => m?.id).filter(Boolean));
  const served = [...new Set((Array.isArray(row.models) ? row.models : []).map((m) => m?.id).filter((id) => ids.has(id)))];
  return served.length === 1 ? served[0] : null;
}

function soleQuant(state, catalogId) {
  const quants = Object.values(state?.registry || {})
    .filter((e) => e && e.catalogId === catalogId && typeof e.quant === "string" && e.quant)
    .map((e) => e.quant);
  const unique = [...new Set(quants)];
  return unique.length === 1 ? unique[0] : null;
}

/**
 * Pure planner.
 * @returns {{ id: string, gpuPolicy: object, filled: string[] }[]}
 */
export function planLegacyRowUpgrades({ rows, catalog, state, ownInstanceId }) {
  const plans = [];
  for (const row of rows || []) {
    const gp = row?.gpuPolicy;
    if (!gp || gp.runtime !== "native" || row.disabled || row.bundleId || isExternalEngine(row)) continue;
    if (hasKey(gp, "catalogId") && hasKey(gp, "port")) continue;
    if (!ownedHere(row, ownInstanceId)) continue;
    const urlPort = loopbackPort(row.baseUrl);
    if (!urlPort) continue;
    if (hasKey(gp, "port") && Number(gp.port) !== urlPort) continue;

    const next = { ...gp };
    const filled = [];
    if (!hasKey(gp, "catalogId")) {
      const catalogId = matchCatalogId(row, catalog);
      if (catalogId) { next.catalogId = catalogId; filled.push("catalogId"); }
    }
    if (!hasKey(gp, "port")) { next.port = urlPort; filled.push("port"); }
    if (!filled.length) continue; // nothing Edit/repair would gain
    if (!hasKey(gp, "quant") && hasKey(next, "catalogId")) {
      const quant = soleQuant(state, next.catalogId);
      if (quant) { next.quant = quant; filled.push("quant"); }
    }
    if (!hasKey(gp, "owner")) { next.owner = ownInstanceId; filled.push("owner"); }
    plans.push({ id: row.id, gpuPolicy: next, filled });
  }
  return plans;
}

/**
 * Plan against the live rows and write each upgrade as a full-row upsert
 * (own row: a normal lamport bump + sync emit). Never throws; one failing row
 * is logged and the rest continue.
 * @returns {Promise<{ id: string, filled: string[] }[]>} the rows written
 */
export async function applyLegacyRowUpgrades({ db, listProvidersAllFn, upsertProviderFn, catalog, state, ownInstanceId, log = console.log }) {
  let rows;
  try {
    rows = await listProvidersAllFn(db);
  } catch (err) {
    log(`[models] legacy row upgrade: could not read provider rows: ${err.message}`);
    return [];
  }
  const byId = new Map(rows.map((r) => [r.id, r]));
  const done = [];
  for (const plan of planLegacyRowUpgrades({ rows, catalog, state, ownInstanceId })) {
    const row = byId.get(plan.id);
    try {
      await upsertProviderFn(db, {
        id: row.id,
        baseUrl: row.baseUrl,
        apiKey: row.apiKey ?? null,
        host: row.host,
        bundleId: row.bundleId ?? null,
        description: row.description ?? null,
        models: row.models,
        disabled: !!row.disabled,
        providerType: row.provider_type ?? null,
        gpuPolicy: plan.gpuPolicy,
      });
      log(`[models] legacy row upgrade: ${row.id} gained ${plan.filled.join(", ")}`);
      done.push({ id: row.id, filled: plan.filled });
    } catch (err) {
      log(`[models] legacy row upgrade: ${row.id} not upgraded: ${err.message}`);
    }
  }
  return done;
}
