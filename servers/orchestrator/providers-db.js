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
 */

import { readFileSync } from "fs";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { createDbClient } from "../db.js";
import { getOrCreateLocalInstanceId } from "../gateway/instance-registry.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const MODELS_JSON_SEARCH_PATHS = [
  resolve(__dirname, "../../models.json"),
  resolve(__dirname, "../../bundles/crowclaw/config/agents/main/models.json"),
  resolve(__dirname, "../../config/models.json"),
];

function readModelsJson() {
  for (const p of MODELS_JSON_SEARCH_PATHS) {
    try { return { path: p, config: JSON.parse(readFileSync(p, "utf-8")) }; } catch {}
  }
  return { path: null, config: { providers: {} } };
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
    providers[r.id] = {
      baseUrl: r.base_url,
      apiKey: r.api_key,
      host: r.host,
      bundleId: r.bundle_id,
      description: r.description,
      models,
    };
  }
  return { providers, _source: "db:providers" };
}

/**
 * Upsert a single provider. Bumps lamport_ts and sets instance_id so
 * instance-sync can propagate.
 */
export async function upsertProvider(db, provider) {
  if (!provider || !provider.id) throw new Error("provider.id required");
  const instanceId = getOrCreateLocalInstanceId();
  const { rows } = await db.execute({
    sql: "SELECT lamport_ts FROM providers WHERE id = ?",
    args: [provider.id],
  });
  const currentTs = rows[0]?.lamport_ts ?? 0;
  const newTs = Math.max(Number(currentTs), Number(provider.lamport_ts || 0)) + 1;

  await db.execute({
    sql: `INSERT INTO providers
          (id, base_url, api_key, host, bundle_id, description, models, disabled, lamport_ts, instance_id, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
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
    ],
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
    sql: "SELECT lamport_ts FROM providers WHERE id = ?",
    args: [id],
  });
  if (rows.length === 0) return { ok: false, reason: "not_found" };
  const newTs = Number(rows[0].lamport_ts || 0) + 1;
  await db.execute({
    sql: "UPDATE providers SET disabled = 1, lamport_ts = ?, instance_id = ?, updated_at = datetime('now') WHERE id = ?",
    args: [newTs, instanceId, id],
  });
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
    return {
      id: r.id,
      baseUrl: r.base_url,
      apiKey: r.api_key,
      host: r.host,
      bundleId: r.bundle_id,
      description: r.description,
      models,
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
export async function registerProviderFromManifest({ db, manifest, providerDef, port, hostIp }) {
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
