/**
 * Device registry stored in dashboard_settings under key "meta_glasses_devices".
 *
 * Crow is single-user at the bundle_settings layer today, so we keep a flat
 * list of paired devices here. Each device record is:
 *
 *   {
 *     id: string,              // caller-supplied handle (e.g. BT MAC hash)
 *     name: string,             // user-facing label ("Kevin's Ray-Bans")
 *     paired_at: iso,           // when it was paired
 *     last_seen: iso | null,    // last successful /session connect
 *     token_hash: string,       // sha256(bearer_token) — never store plaintext
 *     household_profile: string | null, // Companion persona slug, optional
 *     stt_profile_id: string | null,    // override (else default)
 *     ai_profile_slug: string | null,   // override (else default)
 *     tts_profile_id: string | null,    // override (else default)
 *     bound_bot_id: string | null,      // Slice B: pi_bot_defs.bot_id this
 *                                        // device binds to. When set, the bound
 *                                        // bot drives the fast voice turn and
 *                                        // SUPERSEDES ai_profile_slug; the
 *                                        // tts/stt/vision_profile_id remain the
 *                                        // voice plumbing. One device → one bot.
 *     generation: "gen2" | "unknown"    // pairing-time capability probe
 *   }
 *
 * The bearer token itself is returned to the Android client once at pair time
 * and never stored in plaintext on the server.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const KEY = "meta_glasses_devices";
const UNPAIR_KEY_PREFIX = "meta_glasses_device_unpaired.";
const RETENTION_VALUES = new Set(["never", "30d", "1y"]);

function sha256Hex(s) {
  return createHash("sha256").update(String(s)).digest("hex");
}

function constantTimeEqual(a, b) {
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

async function readAll(db) {
  const res = await db.execute({
    sql: "SELECT value FROM dashboard_settings WHERE key = ?",
    args: [KEY],
  });
  if (!res.rows[0]?.value) return [];
  try { return JSON.parse(res.rows[0].value); } catch { return []; }
}

async function writeAll(db, devices) {
  const v = JSON.stringify(devices);
  await db.execute({
    sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')",
    args: [KEY, v, v],
  });
}

/** List paired devices (token_hash redacted). */
export async function listDevices(db) {
  const devices = await readAll(db);
  return devices.map(({ token_hash, ...rest }) => rest);
}

/** Find a device by id. Returns the raw record including token_hash. */
export async function findDevice(db, id) {
  const devices = await readAll(db);
  return devices.find(d => d.id === id) || null;
}

/**
 * Pair a device. Generates a new bearer token, stores its hash, and returns
 * the plaintext token exactly once to the caller. If the device already
 * exists (same id), the token is rotated — any prior session with the old
 * token will 401 on next upgrade.
 */
export async function pairDevice(db, {
  id, name, generation = "unknown",
  household_profile = null, stt_profile_id = null,
  ai_profile_slug = null, tts_profile_id = null, vision_profile_id = null,
  ocr_enabled = false,
  photo_retention = "never",
  // device_kind distinguishes a meta-glasses device from a companion kiosk so
  // each gateway only claims its own devices. companion_features holds the
  // per-device companion toggles (avatar/voice/social) that drive the kiosk UI.
  device_kind = "glasses",
  companion_features = null,
}) {
  if (!id) throw new Error("device id required");
  const token = randomBytes(32).toString("hex");
  const token_hash = sha256Hex(token);
  const devices = await readAll(db);
  const now = new Date().toISOString();
  const existing = devices.findIndex(d => d.id === id);
  const prior = existing >= 0 ? devices[existing] : null;
  // Re-pair (token rotation, e.g. after an app reinstall) must NOT silently
  // wipe the operator's bot binding or voice profiles. The app's pair call
  // only sends id/name/generation, so any field it omits falls back to the
  // prior record — same principle the ocr_enabled toggle already used.
  const priorOcr = prior ? !!prior.ocr_enabled : false;
  const priorRetention = prior ? prior.photo_retention : null;
  const retention = RETENTION_VALUES.has(photo_retention)
    ? photo_retention
    : (priorRetention && RETENTION_VALUES.has(priorRetention) ? priorRetention : "never");
  const keep = (val, key) => (val != null ? val : (prior ? prior[key] ?? null : null));
  const record = {
    id,
    name: name || id,
    paired_at: prior ? prior.paired_at : now,
    last_seen: null,
    token_hash,
    household_profile: keep(household_profile, "household_profile"),
    stt_profile_id: keep(stt_profile_id, "stt_profile_id"),
    ai_profile_slug: keep(ai_profile_slug, "ai_profile_slug"),
    tts_profile_id: keep(tts_profile_id, "tts_profile_id"),
    vision_profile_id: keep(vision_profile_id, "vision_profile_id"),
    ocr_enabled: !!(ocr_enabled || priorOcr),
    photo_retention: retention,
    generation,
    device_kind: device_kind === "companion" ? "companion" : "glasses",
    companion_features: companion_features ?? (prior ? prior.companion_features ?? null : null),
    // Preserve the Bot Builder binding across re-pair — un-binding on token
    // rotation was a silent footgun (operator would have to re-bind every reinstall).
    bound_bot_id: prior ? (prior.bound_bot_id ?? null) : null,
  };
  if (existing >= 0) devices[existing] = record;
  else devices.push(record);
  await writeAll(db, devices);
  // Clear any stale unpair marker so the orphan sweep doesn't delete
  // re-paired photos. Best-effort; DELETE of a non-existent row is a no-op.
  try {
    await db.execute({
      sql: "DELETE FROM dashboard_settings WHERE key = ?",
      args: [UNPAIR_KEY_PREFIX + id],
    });
  } catch {}
  return { device: { ...record, token_hash: undefined }, token };
}

/** Unpair a device by id. */
export async function unpairDevice(db, id) {
  const devices = await readAll(db);
  const before = devices.length;
  const next = devices.filter(d => d.id !== id);
  await writeAll(db, next);
  // Record the unpair timestamp for the orphan-sweep pass in the retention
  // cron. Photos linger for ORPHAN_GRACE_DAYS (see pruneGlassesPhotos in
  // bundles/meta-glasses/panel/routes.js) before deletion. Re-pair clears
  // this marker and resets the clock.
  if (before !== next.length) {
    try {
      const now = new Date().toISOString();
      await db.execute({
        sql: `INSERT INTO dashboard_settings (key, value, updated_at)
              VALUES (?, ?, datetime('now'))
              ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
        args: [UNPAIR_KEY_PREFIX + id, now],
      });
    } catch {}
  }
  return { removed: before - next.length };
}

/**
 * Verify a bearer token against a device id. Returns the device record
 * (without the hash) on success, null on failure. Updates last_seen.
 */
export async function verifyToken(db, id, token) {
  if (!id || !token) return null;
  const devices = await readAll(db);
  const idx = devices.findIndex(d => d.id === id);
  if (idx === -1) return null;
  const record = devices[idx];
  const probe = sha256Hex(token);
  if (!constantTimeEqual(record.token_hash, probe)) return null;
  record.last_seen = new Date().toISOString();
  devices[idx] = record;
  await writeAll(db, devices);
  const { token_hash, ...rest } = record;
  return rest;
}

/** Update profile overrides on a device. */
export async function updateDeviceProfiles(db, id, patch) {
  const devices = await readAll(db);
  const idx = devices.findIndex(d => d.id === id);
  if (idx === -1) return null;
  const allow = ["household_profile", "stt_profile_id", "ai_profile_slug", "tts_profile_id", "vision_profile_id", "ocr_enabled", "photo_retention", "name", "bound_bot_id", "device_kind", "companion_features"];
  for (const k of allow) {
    if (k in patch) {
      // ocr_enabled is a boolean; coerce HTML-form strings "true"/"false"/"on".
      if (k === "ocr_enabled") {
        const v = patch[k];
        devices[idx][k] = v === true || v === "true" || v === "on" || v === 1;
      } else if (k === "device_kind") {
        devices[idx][k] = patch[k] === "companion" ? "companion" : "glasses";
      } else if (k === "companion_features") {
        // Accept an object directly or a JSON string (HTML form). null clears.
        let v = patch[k];
        if (typeof v === "string") { try { v = v ? JSON.parse(v) : null; } catch { v = devices[idx][k] ?? null; } }
        devices[idx][k] = v ?? null;
      } else if (k === "photo_retention") {
        // Reject unknown retention values; leave prior value untouched.
        if (RETENTION_VALUES.has(patch[k])) devices[idx][k] = patch[k];
      } else {
        devices[idx][k] = patch[k] === "" ? null : patch[k];
      }
    }
  }
  await writeAll(db, devices);
  const { token_hash, ...rest } = devices[idx];
  return rest;
}
