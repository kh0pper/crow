/**
 * Gateway startup migrations.
 *
 * Each migration has a unique `id`. Run status is tracked in
 * `dashboard_settings.migrations` (JSON object: {[id]: runAtIso}).
 *
 * Migrations are atomic: the data changes and the version marker write
 * go through a single `db.batch()` call so a crash mid-run cannot leave
 * half-state.
 */

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { randomBytes } from "node:crypto";

/** Read the migrations registry (object keyed by migration id). */
async function readMigrationsState(db) {
  try {
    const res = await db.execute({
      sql: "SELECT value FROM dashboard_settings WHERE key = 'migrations'",
      args: [],
    });
    return JSON.parse(res.rows[0]?.value || "{}");
  } catch {
    return {};
  }
}

/** Read companion .env as a plain object (missing file → {}). */
function readCompanionEnv() {
  const envPath = join(homedir(), ".crow", "bundles", "companion", ".env");
  if (!existsSync(envPath)) return {};
  const env = {};
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const m = line.match(/^([A-Z_][A-Z0-9_]*)=(.*)$/);
    if (m) env[m[1]] = m[2];
  }
  return env;
}

/** Read dashboard_settings by key (string). */
async function readSetting(db, key) {
  const res = await db.execute({
    sql: "SELECT value FROM dashboard_settings WHERE key = ?",
    args: [key],
  });
  return res.rows[0]?.value || null;
}

/**
 * Migration: seed an Edge TTS profile from legacy Companion config.
 *
 * Runs when:
 *   - no tts_profiles row of provider=edge exists, AND
 *   - either dashboard_settings.tts_voice OR companion .env's
 *     COMPANION_TTS_VOICE points to a voice.
 *
 * Side effects:
 *   - inserts a "Edge TTS (Companion default)" profile, marked default
 *     only if there are zero existing profiles.
 *   - mirrors the seeded voice into dashboard_settings.tts_voice.
 *   - writes the migration version marker.
 * All in one atomic batch.
 */
async function seedEdgeTtsProfile(db, stateBefore) {
  // Idempotent — if already run, skip.
  if (stateBefore["2026-04-12_seed_edge_tts_profile"]) return { ran: false, reason: "already-run" };

  // If any edge tts profile already exists, don't create a duplicate.
  const existingTtsRaw = await readSetting(db, "tts_profiles");
  let existing = [];
  try { existing = JSON.parse(existingTtsRaw || "[]"); } catch {}
  if (existing.some(p => p.provider === "edge")) {
    // Still mark the migration as run so we don't re-check every boot.
    const state = { ...stateBefore, "2026-04-12_seed_edge_tts_profile": new Date().toISOString() };
    await db.execute({
      sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('migrations', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')",
      args: [JSON.stringify(state), JSON.stringify(state)],
    });
    return { ran: false, reason: "edge-profile-exists" };
  }

  // Source the voice from either the legacy dashboard setting or the companion .env.
  const legacyVoice = await readSetting(db, "tts_voice");
  const companionEnv = readCompanionEnv();
  const companionVoice = companionEnv.COMPANION_TTS_VOICE;
  const sourceVoice = legacyVoice || companionVoice;
  if (!sourceVoice) {
    // Nothing to migrate. Mark the migration as run so we don't keep
    // checking — the user can create profiles manually when they're ready.
    const state = { ...stateBefore, "2026-04-12_seed_edge_tts_profile": new Date().toISOString() };
    await db.execute({
      sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('migrations', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')",
      args: [JSON.stringify(state), JSON.stringify(state)],
    });
    return { ran: false, reason: "no-source-voice" };
  }

  // If a profile already exists with the same name, suffix for disambiguation.
  const takenNames = new Set(existing.map(p => p.name));
  let name = "Edge TTS (Companion default)";
  if (takenNames.has(name)) {
    name = `Edge TTS (Companion default, migrated ${new Date().toISOString().slice(0,10)})`;
  }

  const newProfile = {
    id: randomBytes(4).toString("hex"),
    name,
    provider: "edge",
    apiKey: "",
    baseUrl: "",
    defaultVoice: sourceVoice,
    isDefault: existing.length === 0,
  };
  const updatedProfiles = [...existing, newProfile];

  // Mirror seeded voice so bundles/media keeps working.
  const newMirror = sourceVoice;

  // Stamp migration state marker.
  const newState = {
    ...stateBefore,
    "2026-04-12_seed_edge_tts_profile": new Date().toISOString(),
  };

  // Atomic batch: profile insert + voice mirror + migrations state.
  await db.batch(
    [
      {
        sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('tts_profiles', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')",
        args: [JSON.stringify(updatedProfiles), JSON.stringify(updatedProfiles)],
      },
      {
        sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('tts_voice', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')",
        args: [newMirror, newMirror],
      },
      {
        sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('migrations', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')",
        args: [JSON.stringify(newState), JSON.stringify(newState)],
      },
    ],
    "write"
  );

  return { ran: true, profileName: name, voice: sourceVoice };
}

/**
 * Migration: ensure sync_conflicts has the `op` column (W4-1).
 *
 * init-db adds it via addColumnIfMissing, but a fleet host that pulls code
 * and restarts WITHOUT running init-db would otherwise run conflict-logging
 * INSERTs that name the column — and in _checkConflict a failed INSERT falls
 * through to "apply", silently overwriting newer local data with a stale
 * remote row. Closing that window at gateway boot keeps deploy ordering
 * (pull → restart, init-db forgotten) safe.
 *
 * Idempotent by construction (PRAGMA check, no state marker needed).
 */
async function ensureSyncConflictsOpColumn(db) {
  const { rows } = await db.execute({ sql: "PRAGMA table_info(sync_conflicts)", args: [] });
  if (rows.length === 0) return { ran: false, reason: "no-table" }; // init-db never ran; core-table auto-init handles that case
  if (rows.some((r) => r.name === "op")) return { ran: false, reason: "already-present" };
  await db.execute({ sql: "ALTER TABLE sync_conflicts ADD COLUMN op TEXT DEFAULT 'update'", args: [] });
  return { ran: true };
}

/**
 * Migration: ensure the `dashboard_pending_2fa` table exists.
 *
 * dashboard/totp.js stores the short-lived pending-2FA token here. It used to
 * INSERT token_type='pending_2fa' into oauth_tokens, whose
 * CHECK(token_type IN ('access','refresh')) rejected it — so on any install
 * with dashboard 2FA enabled, a CORRECT password produced "Login temporarily
 * unavailable (server database error)" (attemptLogin's DB-failure path) and
 * the dashboard was unreachable. Installs with 2FA off never hit it, because
 * sessions use token_type='access'.
 *
 * init-db.js creates the table, but a host that pulls code and restarts
 * WITHOUT running init-db would still be locked out — the same deploy-ordering
 * window ensureSyncConflictsOpColumn closes above. Purely additive
 * (CREATE TABLE IF NOT EXISTS): no rebuild of a live table, nothing dropped.
 * Idempotent by construction, so no state marker.
 */
async function ensurePending2faTable(db) {
  const { rows } = await db.execute({
    sql: "SELECT name FROM sqlite_master WHERE type='table' AND name='dashboard_pending_2fa'",
    args: [],
  });
  if (rows.length > 0) return { ran: false, reason: "already-present" };
  await db.execute({
    sql: `CREATE TABLE IF NOT EXISTS dashboard_pending_2fa (
            token TEXT PRIMARY KEY,
            meta TEXT,
            expires_at TEXT NOT NULL,
            created_at TEXT DEFAULT (datetime('now'))
          )`,
    args: [],
  });
  await db.execute({
    sql: "CREATE INDEX IF NOT EXISTS idx_pending_2fa_expires ON dashboard_pending_2fa(expires_at)",
    args: [],
  });
  return { ran: true };
}

/**
 * Run all startup migrations. Safe to call multiple times (each migration
 * tracks its own run state and skips if already applied).
 */
export async function runGatewayMigrations(db) {
  const state = await readMigrationsState(db);
  const results = [];
  try {
    results.push({ id: "2026-04-12_seed_edge_tts_profile", ...(await seedEdgeTtsProfile(db, state)) });
  } catch (err) {
    results.push({ id: "2026-04-12_seed_edge_tts_profile", error: err.message });
  }
  try {
    results.push({ id: "2026-06-11_sync_conflicts_op_column", ...(await ensureSyncConflictsOpColumn(db)) });
  } catch (err) {
    results.push({ id: "2026-06-11_sync_conflicts_op_column", error: err.message });
  }
  try {
    results.push({ id: "2026-09-09_dashboard_pending_2fa_table", ...(await ensurePending2faTable(db)) });
  } catch (err) {
    results.push({ id: "2026-09-09_dashboard_pending_2fa_table", error: err.message });
  }
  return results;
}
