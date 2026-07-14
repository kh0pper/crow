/**
 * Providers DB layer (Phase 5-full governance).
 *
 * Operator-editable provider registry persisted in the `providers` table.
 * Instance-synced via Hypercore so edits on one Crow instance propagate to
 * peers (Lamport-timestamped rows, last-writer wins with conflict log).
 *
 * Precedence:
 *   1. DB rows (if any non-disabled providers exist)
 *   2. models.json on disk (seed / fallback)
 *
 * On first boot or if the DB is empty, the seed() call populates it from
 * models.json so existing users see no behavioral change.
 *
 * `host` column invariant (three allowed values only):
 *   - "local"            → this gateway's own host (127.0.0.1 / loopback)
 *   - "<instance-id>"    → a paired Crow instance (resolve via crow_instances)
 *   - "cloud"            → no host; call base_url directly (OpenAI, Anthropic…)
 *
 * Any new routing code MUST NOT treat a non-"local" value as an implicit
 * remote-peer fetch. Cloud rows use base_url directly and have `bundle_id IS
 * NULL` + a populated `provider_type` (openai, anthropic, google, openrouter,
 * openai-compat, ollama). Local-bundle rows have `bundle_id IS NOT NULL` and
 * `provider_type IS NULL` (adapter inferred from bundle_id/models.json).
 */

import { readFileSync } from "fs";
import { createDbClient } from "../db.js";
import { getOrCreateLocalInstanceId } from "../gateway/instance-registry.js";
import { getOwnAddresses, isLocallyOrchestratable } from "./locality.js";
import { modelsJsonSearchPaths } from "./models-json-paths.js";

function readModelsJson() {
  const merged = { providers: {} };
  const paths = [];
  for (const p of modelsJsonSearchPaths()) {
    try {
      const j = JSON.parse(readFileSync(p, "utf-8"));
      if (j && j.providers) {
        Object.assign(merged.providers, j.providers);
        paths.push(p);
      }
    } catch {}
  }
  return { path: paths.join(", ") || null, config: merged };
}

function inferHost(baseUrl, existingHost) {
  if (existingHost) return existingHost;
  if (!baseUrl) return "local";
  try {
    const h = new URL(baseUrl).hostname;
    if (h === "localhost" || h.startsWith("127.") || h.startsWith("10.") ||
        h.startsWith("192.168.") || h.startsWith("100.")) return "local";
    return "cloud";
  } catch { return "local"; }
}

const API_TO_PROVIDER_TYPE = {
  "openai-completions": "openai-compat",
  "anthropic-messages": "anthropic",
  "google-generative": "google",
  "ollama": "ollama",
};
function inferProviderType(apiField) {
  if (!apiField) return null;
  return API_TO_PROVIDER_TYPE[apiField] || "openai-compat";
}

/**
 * Seed the providers table from models.json IF the table is currently empty.
 * Idempotent: after first run, edits live in the DB, not in models.json.
 * Returns { seeded: number, source: path|null }.
 */
export async function seedProvidersFromModelsJson(db) {
  const dbClient = db || createDbClient();
  const { rows } = await dbClient.execute("SELECT COUNT(*) AS n FROM providers");
  if (Number(rows[0].n) > 0) return { seeded: 0, source: null };

  const { path, config } = readModelsJson();
  if (!config?.providers) return { seeded: 0, source: path };

  const instanceId = getOrCreateLocalInstanceId();
  let count = 0;
  for (const [id, p] of Object.entries(config.providers)) {
    if (id.startsWith("$")) continue; // JSON-schema meta keys
    await dbClient.execute({
      sql: `INSERT OR IGNORE INTO providers
            (id, base_url, api_key, host, bundle_id, description, models, lamport_ts, instance_id)
            VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?)`,
      args: [
        id,
        p.baseUrl || "",
        p.apiKey || null,
        p.host || "local",
        p.bundleId || null,
        p.$description || p.description || null,
        JSON.stringify(p.models || []),
        instanceId,
      ],
    });
    count++;
  }
  return { seeded: count, source: path };
}

/**
 * Return the provider registry in the same shape the old `loadProviders()`
 * returned, so existing callers (providers.js `healthMatrix`, orchestrator
 * `resolveProvider`) continue to work.
 *
 * Shape: { providers: { <id>: { baseUrl, apiKey, host, bundleId, models[] } }, _source }
 */
export async function loadProvidersFromDb(db) {
  const dbClient = db || createDbClient();
  const { rows } = await dbClient.execute({
    sql: "SELECT * FROM providers WHERE disabled = 0 ORDER BY id",
    args: [],
  });
  if (rows.length === 0) return null; // signal fallback

  const providers = {};
  for (const r of rows) {
    let models = [];
    try { models = JSON.parse(r.models || "[]"); } catch {}
    let gpuPolicy = null;
    try { gpuPolicy = r.gpu_policy ? JSON.parse(r.gpu_policy) : null; } catch {}
    providers[r.id] = {
      baseUrl: r.base_url,
      apiKey: r.api_key,
      host: r.host,
      bundleId: r.bundle_id,
      description: r.description,
      models,
      gpuPolicy,
    };
  }
  return { providers, _source: "db:providers" };
}

// -----------------------------------------------------------------------
// Optional syncManager injection — callers that have access to a
// connected InstanceSyncManager (the gateway, typically) can set it here
// so mutations push to paired peers via emitChange. If unset, peers
// still receive updates via pull-side sync (their sync loop scans the
// table periodically by lamport_ts).
// -----------------------------------------------------------------------

let _syncManager = null;
export function setProviderSyncManager(mgr) { _syncManager = mgr || null; }

async function emitSync(op, row) {
  if (!_syncManager) return;
  try { await _syncManager.emitChange("providers", op, row); } catch {}
}

/**
 * Canonical deep-equal for parsed-JSON values: recursive, object-key-order
 * insensitive, array-order sensitive. Used by the upsert no-op comparator so
 * `models` / `gpu_policy` compare on structure, never on string form (a
 * key-order shuffle in models.json must not count as a change).
 */
function canonicalJsonEqual(a, b) {
  if (a === b) return true;
  if (a === null || b === null || typeof a !== "object" || typeof b !== "object") return false;
  const aArr = Array.isArray(a);
  if (aArr !== Array.isArray(b)) return false;
  if (aArr) {
    if (a.length !== b.length) return false;
    return a.every((v, i) => canonicalJsonEqual(v, b[i]));
  }
  const keys = Object.keys(a);
  if (keys.length !== Object.keys(b).length) return false;
  return keys.every((k) => Object.prototype.hasOwnProperty.call(b, k) && canonicalJsonEqual(a[k], b[k]));
}

/**
 * D2 no-op comparator: does the write-image match the stored row on every
 * content column? Normalization rules (spec R1-F6):
 *   - base_url/host/bundle_id/description/provider_type: (x ?? null), String
 *     coercion on non-null (libsql may return non-string cell types).
 *   - disabled: both sides → Number(x) ? 1 : 0 (libsql can return BigInt).
 *   - api_key: null ≡ "" (both mean "no key"), otherwise strict.
 *   - models: canonical deep-equal of JSON.parse(dbRow.models) vs the incoming
 *     array. DB-side parse failure → CHANGED (R2-m3 FAIL-OPEN: the good
 *     incoming content overwrites the corruption; fail-closed would make a
 *     corrupt row permanently unhealable).
 *   - gpu_policy: incoming null/undefined → UNCHANGED by definition (the SQL
 *     uses COALESCE(excluded.gpu_policy, providers.gpu_policy), so a null
 *     write keeps the stored value). Non-null → deep-equal of parsed values;
 *     any parse failure → CHANGED (same fail-open rule).
 */
function upsertIsNoop(existing, w) {
  const s = (x) => (x == null ? null : String(x));
  if (s(existing.base_url) !== s(w.baseUrl)) return false;
  if (s(existing.host) !== s(w.host)) return false;
  if (s(existing.bundle_id) !== s(w.bundleId)) return false;
  if (s(existing.description) !== s(w.description)) return false;
  if (s(existing.provider_type) !== s(w.providerType)) return false;
  if ((Number(existing.disabled) ? 1 : 0) !== (Number(w.disabled) ? 1 : 0)) return false;
  const keyNorm = (x) => (x == null ? "" : String(x));
  if (keyNorm(existing.api_key) !== keyNorm(w.apiKey)) return false;
  let dbModels;
  try { dbModels = JSON.parse(existing.models); } catch { return false; } // fail-open
  if (!canonicalJsonEqual(dbModels, w.models)) return false;
  if (w.gpuPolicy != null) {
    let dbPolicy, incomingPolicy;
    try { dbPolicy = existing.gpu_policy == null ? null : JSON.parse(existing.gpu_policy); } catch { return false; } // fail-open
    try { incomingPolicy = JSON.parse(w.gpuPolicy); } catch { return false; } // fail-open
    if (!canonicalJsonEqual(dbPolicy, incomingPolicy)) return false;
  }
  return true;
}

/**
 * Upsert a single provider. Bumps lamport_ts and sets instance_id so
 * instance-sync can propagate. Emits a sync change to peers when a
 * syncManager has been attached via setProviderSyncManager.
 *
 * No-op suppression (D2): when the row exists and every content column
 * matches the write-image (per upsertIsNoop's normalization), returns
 * `{ id, lamport_ts: <current>, unchanged: true }` WITHOUT writing, bumping
 * lamport, or emitting to peers — unchanged content must never manufacture
 * sync churn (the 211-conflict restart war).
 */
export async function upsertProvider(db, provider) {
  if (!provider || !provider.id) throw new Error("provider.id required");
  const instanceId = getOrCreateLocalInstanceId();
  const { rows } = await db.execute({
    sql: "SELECT * FROM providers WHERE id = ?",
    args: [provider.id],
  });
  const currentTs = rows[0]?.lamport_ts ?? 0;
  const existed = rows.length > 0;
  const providerType = provider.providerType ?? provider.provider_type ?? null;
  const gpuPolicy = provider.gpuPolicy != null ? JSON.stringify(provider.gpuPolicy) : (provider.gpu_policy ?? null);

  if (existed && upsertIsNoop(rows[0], {
    baseUrl: provider.baseUrl || provider.base_url || "",
    apiKey: provider.apiKey ?? provider.api_key ?? null,
    host: provider.host || "local",
    bundleId: provider.bundleId ?? provider.bundle_id ?? null,
    description: provider.description ?? null,
    models: provider.models || [],
    disabled: provider.disabled ? 1 : 0,
    providerType,
    gpuPolicy,
  })) {
    return { id: provider.id, lamport_ts: Number(currentTs), unchanged: true };
  }

  const newTs = Math.max(Number(currentTs), Number(provider.lamport_ts || 0)) + 1;

  await db.execute({
    sql: `INSERT INTO providers
          (id, base_url, api_key, host, bundle_id, description, models, disabled, lamport_ts, instance_id, provider_type, gpu_policy, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT(id) DO UPDATE SET
            base_url = excluded.base_url,
            api_key = excluded.api_key,
            host = excluded.host,
            bundle_id = excluded.bundle_id,
            description = excluded.description,
            models = excluded.models,
            disabled = excluded.disabled,
            lamport_ts = excluded.lamport_ts,
            instance_id = excluded.instance_id,
            provider_type = excluded.provider_type,
            gpu_policy = COALESCE(excluded.gpu_policy, providers.gpu_policy),
            updated_at = datetime('now')`,
    args: [
      provider.id,
      provider.baseUrl || provider.base_url || "",
      provider.apiKey ?? provider.api_key ?? null,
      provider.host || "local",
      provider.bundleId ?? provider.bundle_id ?? null,
      provider.description ?? null,
      JSON.stringify(provider.models || []),
      provider.disabled ? 1 : 0,
      newTs,
      instanceId,
      providerType,
      gpuPolicy,
    ],
  });

  await emitSync(existed ? "update" : "insert", {
    id: provider.id,
    base_url: provider.baseUrl || provider.base_url || "",
    api_key: provider.apiKey ?? provider.api_key ?? null,
    host: provider.host || "local",
    bundle_id: provider.bundleId ?? provider.bundle_id ?? null,
    description: provider.description ?? null,
    models: JSON.stringify(provider.models || []),
    disabled: provider.disabled ? 1 : 0,
    lamport_ts: newTs,
    instance_id: instanceId,
    provider_type: providerType,
    gpu_policy: gpuPolicy,
  });

  return { id: provider.id, lamport_ts: newTs };
}

/**
 * Soft-delete by setting disabled=1 (preserves history + allows sync of
 * the deletion fact). A hard-delete would race with sync replays.
 */
export async function disableProvider(db, id) {
  const instanceId = getOrCreateLocalInstanceId();
  const { rows } = await db.execute({
    sql: "SELECT * FROM providers WHERE id = ?",
    args: [id],
  });
  if (rows.length === 0) return { ok: false, reason: "not_found" };
  const newTs = Number(rows[0].lamport_ts || 0) + 1;
  await db.execute({
    sql: "UPDATE providers SET disabled = 1, lamport_ts = ?, instance_id = ?, updated_at = datetime('now') WHERE id = ?",
    args: [newTs, instanceId, id],
  });
  await emitSync("update", { ...rows[0], disabled: 1, lamport_ts: newTs, instance_id: instanceId });
  return { ok: true, lamport_ts: newTs };
}

/**
 * List all providers (including disabled) for the settings panel.
 */
export async function listProvidersAll(db) {
  const { rows } = await db.execute("SELECT * FROM providers ORDER BY disabled ASC, id");
  return rows.map((r) => {
    let models = [];
    try { models = JSON.parse(r.models || "[]"); } catch {}
    let gpuPolicy = null;
    try { gpuPolicy = r.gpu_policy ? JSON.parse(r.gpu_policy) : null; } catch {}
    return {
      id: r.id,
      baseUrl: r.base_url,
      apiKey: r.api_key,
      host: r.host,
      bundleId: r.bundle_id,
      provider_type: r.provider_type || null,
      description: r.description,
      models,
      gpuPolicy,
      disabled: !!r.disabled,
      lamport_ts: r.lamport_ts,
      instance_id: r.instance_id,
      created_at: r.created_at,
      updated_at: r.updated_at,
    };
  });
}

/**
 * Register a provider from a bundle manifest.providers[] entry on install.
 *
 * Expands baseUrlTemplate placeholders:
 *   {host_ip} — tailscale_ip of the target instance (or 127.0.0.1 for local)
 *   {port}    — manifest.port
 *
 * @param {object} args
 * @param {object} args.db
 * @param {object} args.manifest     the bundle's manifest.json
 * @param {object} args.providerDef  one entry from manifest.providers[]
 * @param {number} args.port         the bundle's declared port
 * @param {string} args.hostIp       resolved host IP
 */
export async function registerProviderFromManifest({ db, manifest, providerDef, port, hostIp, providerType = null }) {
  const baseUrl = (providerDef.baseUrlTemplate || "")
    .replace("{host_ip}", hostIp)
    .replace("{port}", String(port));
  return upsertProvider(db, {
    id: providerDef.id,
    baseUrl,
    apiKey: providerDef.apiKey ?? null,
    host: manifest.host || "local",
    bundleId: manifest.id,
    description: providerDef.description || manifest.description || null,
    models: providerDef.models || [],
    disabled: false,
    providerType,
  });
}

/**
 * Soft-remove providers registered by a given bundle on uninstall.
 */
export async function unregisterProvidersByBundle(db, bundleId) {
  const { rows } = await db.execute({
    sql: "SELECT id FROM providers WHERE bundle_id = ? AND disabled = 0",
    args: [bundleId],
  });
  for (const r of rows) await disableProvider(db, r.id);
  return { disabled: rows.length };
}

/**
 * D1 decision table for the owner-asserts reconciler. Pure — exported for
 * exhaustive unit-testing of the matrix (tests/providers-reconcile-gate.test.js).
 *
 *   seed          → row absent from DB: insert it (any instance may seed).
 *   assert        → owned + enabled (or owned + disabled + force): full
 *                   re-assert from models.json (D2 makes converged runs no-ops).
 *   skip_unowned  → present + NOT owned + enabled: the DB/sync copy is
 *                   authoritative; this instance's file must not assert.
 *                   Force does NOT override this (spec R-Q1: force never
 *                   asserts file content over an enabled unowned row).
 *   skip_disabled → disabled without force: today's bundle-uninstall guard.
 *   reenable      → present + NOT owned + disabled + force: flip disabled→0
 *                   preserving DB content (never assert this file's copy).
 */
export function reconcileDecision({ owned, present, disabled, force }) {
  if (!present) return "seed";
  if (owned) {
    if (!disabled) return "assert";
    return force ? "assert" : "skip_disabled";
  }
  if (!disabled) return "skip_unowned";
  return force ? "reenable" : "skip_disabled";
}

/**
 * Re-enable a provider row WITHOUT asserting models.json content over it —
 * the force path for unowned+disabled rows (spec R1-F5 / R2-M2).
 *
 * CRITICAL (R2-M2): this must round-trip through the PARSED listProvidersAll
 * shape (models as an array, gpuPolicy as an object). Spreading a raw
 * `SELECT *` row into upsertProvider would double-encode its string `models`
 * through the unconditional JSON.stringify in the upsert write path.
 * In-tree precedent: the llm_provider_enable action (providers-tab.js).
 *
 * Returns the upsertProvider result, or null when the id doesn't exist.
 */
export async function reenableProviderPreservingContent(db, id) {
  const all = await listProvidersAll(db);
  const row = all.find((p) => p.id === id);
  if (!row) return null;
  return upsertProvider(db, { ...row, disabled: false });
}

/**
 * Continuous reconciler: assert models.json entries into the DB — but only
 * the entries this instance OWNS (single-writer by endpoint ownership).
 *
 * Why the ownership gate (the 211-conflict war, spec D1): models.json is
 * per-machine (repo file + git-untracked ~/.pi/agent/models.json overlay),
 * so copies drift across the fleet. The old reconciler had every instance
 * unconditionally assert its own file into fleet-synced rows on every boot —
 * two drifted files ⇒ an infinite sync ping-pong (181 recurring
 * providers/crow-local conflict rows) with peers' stale metadata overwriting
 * the owner's truth. The volatile truth "what does the server at this
 * endpoint serve" has exactly one natural owner: the instance whose address
 * the baseUrl points at. Only that owner asserts; sync propagates the
 * owner's copy to everyone else. Rows absent from the DB are still seeded by
 * any instance (cloud rows have no owner and are seed-once, then
 * dashboard/force-edited).
 *
 * Loopback baseUrls are co-owned by design (every instance's own-address set
 * contains loopback) — harmless, because shouldSyncRow('providers') keeps
 * loopback rows off the sync wire entirely (D9): each instance asserts its
 * own file's loopback rows into its own DB only.
 *
 * Disabled-row safety rule (unchanged): rows `disabled=1` are skipped unless
 * `force=true`, because `unregisterProvidersByBundle` uses the flag to mark
 * bundle-uninstall. Force ("Sync bundle providers" button) means "I know,
 * re-enable": owned rows get today's full re-assert; UNOWNED rows are only
 * flipped back to enabled with their DB content preserved (see
 * reenableProviderPreservingContent).
 *
 * `ownAddrs` is recomputed on EVERY call (never module-cached) so the hourly
 * reconcile sees tailscale coming up after boot and tailnet/DHCP IP changes.
 * Injectable for tests.
 *
 * @param {object} db
 * @param {{ force?: boolean, ownAddrs?: Set<string> }} opts
 * @returns {Promise<{ upserted: number, unchanged: number, skipped_disabled: number,
 *                     skipped_unowned: number, reenabled: number, source: string|null }>}
 *   `upserted` counts actual writes; `unchanged` counts owned entries whose
 *   content already converged (D2 no-op suppression).
 */
export async function syncProvidersFromModelsJson(db, { force = false, ownAddrs } = {}) {
  const dbClient = db || createDbClient();
  const addrs = ownAddrs || getOwnAddresses(); // fresh every run — see doc comment
  const { path, config } = readModelsJson();
  const counters = { upserted: 0, unchanged: 0, skipped_disabled: 0, skipped_unowned: 0, reenabled: 0 };
  if (!config?.providers) return { ...counters, source: path };

  const entries = Object.entries(config.providers).filter(([id]) => !id.startsWith("$"));
  if (entries.length === 0) return { ...counters, source: path };

  const { rows: existingRows } = await dbClient.execute("SELECT id, disabled FROM providers");
  const existing = new Map(existingRows.map((r) => [r.id, r]));

  for (const [id, p] of entries) {
    const cur = existing.get(id);
    const decision = reconcileDecision({
      owned: isLocallyOrchestratable({ baseUrl: p.baseUrl }, addrs),
      present: cur !== undefined,
      disabled: cur !== undefined && !!Number(cur.disabled),
      force,
    });
    if (decision === "skip_disabled") { counters.skipped_disabled++; continue; }
    if (decision === "skip_unowned") { counters.skipped_unowned++; continue; }
    if (decision === "reenable") {
      const res = await reenableProviderPreservingContent(dbClient, id);
      if (res) counters.reenabled++;
      continue;
    }
    // "seed" | "assert" — full assert from the file entry.
    const gpuPolicy = (p.mutexGroup || p.alwaysResident || p.defaultMember)
      ? { mutexGroup: p.mutexGroup ?? null, alwaysResident: !!p.alwaysResident, defaultMember: !!p.defaultMember }
      : null;
    const res = await upsertProvider(dbClient, {
      id,
      baseUrl: p.baseUrl || "",
      apiKey: p.apiKey ?? null,
      host: inferHost(p.baseUrl, p.host),
      bundleId: p.bundleId ?? null,
      description: p.$description || p.description || null,
      models: p.models || [],
      disabled: false,
      providerType: inferProviderType(p.api) || p.providerType || null,
      gpuPolicy,
    });
    if (res.unchanged) counters.unchanged++;
    else counters.upserted++;
  }
  return { ...counters, source: path };
}
