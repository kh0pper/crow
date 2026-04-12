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
  return results;
}
