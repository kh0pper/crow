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
 * Upsert a single provider. Bumps lamport_ts and sets instance_id so
 * instance-sync can propagate. Emits a sync change to peers when a
 * syncManager has been attached via setProviderSyncManager.
 */
export async function upsertProvider(db, provider) {
  if (!provider || !provider.id) throw new Error("provider.id required");
  const instanceId = getOrCreateLocalInstanceId();
  const { rows } = await db.execute({
    sql: "SELECT lamport_ts FROM providers WHERE id = ?",
    args: [provider.id],
  });
  const currentTs = rows[0]?.lamport_ts ?? 0;
  const existed = rows.length > 0;
  const newTs = Math.max(Number(currentTs), Number(provider.lamport_ts || 0)) + 1;
  const providerType = provider.providerType ?? provider.provider_type ?? null;

  await db.execute({
    sql: `INSERT INTO providers
          (id, base_url, api_key, host, bundle_id, description, models, disabled, lamport_ts, instance_id, provider_type, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'))
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
 * Continuous reconciler: upsert every provider declared in models.json so
 * post-boot edits to models.json propagate into the DB. Complements
 * seedProvidersFromModelsJson (which runs once on an empty table).
 *
 * Key safety rule: rows currently `disabled=1` are skipped unless
 * `force=true`. This is required because `unregisterProvidersByBundle`
 * uses the disabled flag to mark bundle-uninstall, and a naive reconciler
 * would silently re-enable those rows on the next gateway startup because
 * the bundle's entry still lives in models.json. The `force=true` path is
 * for the explicit "Sync bundle providers" operator action in the LLM
 * settings page — that action's semantics are "I know, re-enable."
 *
 * @param {object} db
 * @param {{ force?: boolean }} opts
 * @returns {Promise<{ upserted: number, skipped_disabled: number, source: string|null }>}
 */
export async function syncProvidersFromModelsJson(db, { force = false } = {}) {
  const dbClient = db || createDbClient();
  const { path, config } = readModelsJson();
  if (!config?.providers) return { upserted: 0, skipped_disabled: 0, source: path };

  const entries = Object.entries(config.providers).filter(([id]) => !id.startsWith("$"));
  if (entries.length === 0) return { upserted: 0, skipped_disabled: 0, source: path };

  const { rows: disabledRows } = await dbClient.execute(
    "SELECT id FROM providers WHERE disabled = 1",
  );
  const disabledIds = new Set(disabledRows.map((r) => r.id));

  let upserted = 0;
  let skippedDisabled = 0;
  for (const [id, p] of entries) {
    if (!force && disabledIds.has(id)) { skippedDisabled++; continue; }
    await upsertProvider(dbClient, {
      id,
      baseUrl: p.baseUrl || "",
      apiKey: p.apiKey ?? null,
      host: p.host || "local",
      bundleId: p.bundleId ?? null,
      description: p.$description || p.description || null,
      models: p.models || [],
      disabled: false,
    });
    upserted++;
  }
  return { upserted, skipped_disabled: skippedDisabled, source: path };
}

// -----------------------------------------------------------------------
// Orchestrator role overrides: per-agent provider/model bindings that
// override the defaults baked into presets.js. Empty table ⇒ presets work
// as shipped. Row present ⇒ preset-resolver.js overlays it.
//
// Orphan handling: when a referenced provider is later disabled or
// deleted, preset-resolver treats it as "unresolvable" and falls back to
// the preset default. No GC needed — overrides survive bundle reinstalls
// by design, so "the override I set yesterday" persists.
// -----------------------------------------------------------------------

function overrideId(presetName, agentName) {
  return `${presetName}:${agentName}`;
}

export async function listRoleOverrides(db) {
  const { rows } = await db.execute({
    sql: "SELECT * FROM orchestrator_role_overrides ORDER BY preset_name, agent_name",
    args: [],
  });
  return rows.map((r) => ({
    id: r.id,
    preset_name: r.preset_name,
    agent_name: r.agent_name,
    provider_id: r.provider_id,
    model_id: r.model_id,
    lamport_ts: r.lamport_ts,
    instance_id: r.instance_id,
    updated_at: r.updated_at,
  }));
}

/**
 * UPSERT a role override. Pass `provider_id: null` to indicate "no provider"
 * but keep the row (rare; prefer clearRoleOverride for "revert to preset
 * default"). `_applyInsert` at instance-sync.js only auto-populates
 * `instance_id` for the `memories` table; every other synced table (us
 * included) relies on the emitter including instance_id in the row payload.
 */
export async function setRoleOverride(db, { preset_name, agent_name, provider_id, model_id }) {
  if (!preset_name || !agent_name) throw new Error("preset_name and agent_name required");
  const id = overrideId(preset_name, agent_name);
  const instanceId = getOrCreateLocalInstanceId();
  const { rows } = await db.execute({
    sql: "SELECT lamport_ts FROM orchestrator_role_overrides WHERE id = ?",
    args: [id],
  });
  const existed = rows.length > 0;
  const newTs = Number(rows[0]?.lamport_ts ?? 0) + 1;

  await db.execute({
    sql: `INSERT INTO orchestrator_role_overrides
          (id, preset_name, agent_name, provider_id, model_id, lamport_ts, instance_id, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, datetime('now'))
          ON CONFLICT(id) DO UPDATE SET
            preset_name = excluded.preset_name,
            agent_name = excluded.agent_name,
            provider_id = excluded.provider_id,
            model_id = excluded.model_id,
            lamport_ts = excluded.lamport_ts,
            instance_id = excluded.instance_id,
            updated_at = datetime('now')`,
    args: [id, preset_name, agent_name, provider_id ?? null, model_id ?? null, newTs, instanceId],
  });

  if (_syncManager) {
    try {
      await _syncManager.emitChange(
        "orchestrator_role_overrides",
        existed ? "update" : "insert",
        {
          id,
          preset_name,
          agent_name,
          provider_id: provider_id ?? null,
          model_id: model_id ?? null,
          lamport_ts: newTs,
          instance_id: instanceId,
        },
      );
    } catch {}
  }
  return { id, lamport_ts: newTs };
}

/**
 * Delete the override row. The resolver treats a missing row as "preset
 * default." Emits a `delete` sync change so paired instances remove their
 * copy too (matches the `_applyDelete` contract at instance-sync.js:552).
 */
export async function clearRoleOverride(db, preset_name, agent_name) {
  if (!preset_name || !agent_name) throw new Error("preset_name and agent_name required");
  const id = overrideId(preset_name, agent_name);
  const { rowsAffected } = await db.execute({
    sql: "DELETE FROM orchestrator_role_overrides WHERE id = ?",
    args: [id],
  });
  if (_syncManager) {
    try { await _syncManager.emitChange("orchestrator_role_overrides", "delete", { id }); } catch {}
  }
  return { id, deleted: Number(rowsAffected || 0) };
}
