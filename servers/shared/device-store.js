/**
 * Device registry (dashboard_settings key "meta_glasses_devices"; local scope,
 * not in the sync allowlist). Moved to core from bundles/meta-glasses/server/
 * for the kiosk (spec 2026-10-03 §4.1); the old path is a re-export shim.
 *
 * Record: { id, name, paired_at, last_seen, token_hash, household_profile,
 *   stt_profile_id, ai_profile_slug, tts_profile_id, vision_profile_id,
 *   ocr_enabled, photo_retention, generation, device_kind, companion_features,
 *   kiosk_settings, bound_bot_id }
 *
 * device_kind: "glasses" | "companion" | "kiosk".
 * A KIOSK token is hashed domain-separated (sha256("crow-kiosk-v1:"+token)) and
 * verifies only through verifyToken(..., {kind:"kiosk"}), so no glasses route
 * (and no older installed copy of this store) can ever accept it (ruling R2).
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

const KEY = "meta_glasses_devices";
const UNPAIR_KEY_PREFIX = "meta_glasses_device_unpaired.";
const RETENTION_VALUES = new Set(["never", "30d", "1y"]);
const KIND_VALUES = new Set(["glasses", "companion", "kiosk"]);
const KIOSK_HASH_DOMAIN = "crow-kiosk-v1:";
const HHMM_RE = /^([01]\d|2[0-3]):[0-5]\d$/;

export const DEVICE_KINDS = Object.freeze([...KIND_VALUES]);
export const LAST_SEEN_WRITE_MS = 5 * 60 * 1000;
export const KIOSK_DEFAULTS = Object.freeze({
  follow_up: false,
  follow_up_s: 6,
  memory_integration: false,
  animation: true,
  sleep_start: "22:30",
  sleep_end: "06:30",
  lang: "en",
  vad_hangover_ms: 450,
  stt_model: "default",
  theme: "auto",
});
/** End-of-speech silence wait range (ms), latency lever 1; the panel offers the same range. */
export const KIOSK_VAD_HANGOVER_RANGE = Object.freeze({ min: 300, max: 900 });
/** "default" = the STT profile's own model; "tiny.en" = faster, less accurate (bundles/kiosk/server/profiles.js). */
export const KIOSK_STT_MODEL_CHOICES = Object.freeze(["default", "tiny.en"]);
/** "auto" = dark during the sleep hours (paired) or by the OS scheme (dashboard); "light"/"dark" pin it. */
export const KIOSK_THEME_CHOICES = Object.freeze(["auto", "light", "dark"]);

function sha256Hex(s) {
  return createHash("sha256").update(String(s)).digest("hex");
}

export function tokenHash(token, kind) {
  return sha256Hex(kind === "kiosk" ? KIOSK_HASH_DOMAIN + token : token);
}

function constantTimeEqual(a, b) {
  if (typeof a !== "string" || typeof b !== "string") return false;
  const ba = Buffer.from(a, "hex");
  const bb = Buffer.from(b, "hex");
  if (ba.length === 0 || ba.length !== bb.length) return false;
  return timingSafeEqual(ba, bb);
}

function asBool(v) { return v === true || v === "true" || v === "on" || v === 1 || v === "1"; }

/** Merge + validate kiosk settings. Unknown keys dropped; bad values keep the prior value. */
export function normalizeKioskSettings(input, prior) {
  const base = { ...KIOSK_DEFAULTS, ...(prior && typeof prior === "object" ? prior : {}) };
  let src = input;
  if (typeof src === "string") { try { src = JSON.parse(src); } catch { src = null; } }
  if (!src || typeof src !== "object") return { ...base };
  const out = { ...base };
  for (const k of ["follow_up", "memory_integration", "animation"]) if (k in src) out[k] = asBool(src[k]);
  if ("follow_up_s" in src) {
    const n = Number.parseInt(src.follow_up_s, 10);
    if (Number.isFinite(n)) out.follow_up_s = Math.min(20, Math.max(2, n));
  }
  for (const k of ["sleep_start", "sleep_end"]) if (k in src && HHMM_RE.test(String(src[k]))) out[k] = String(src[k]);
  if ("lang" in src && (src.lang === "en" || src.lang === "es")) out.lang = src.lang;
  if ("vad_hangover_ms" in src) {
    const n = Number.parseInt(src.vad_hangover_ms, 10);
    if (Number.isFinite(n)) out.vad_hangover_ms = Math.min(KIOSK_VAD_HANGOVER_RANGE.max, Math.max(KIOSK_VAD_HANGOVER_RANGE.min, n));   // latency lever 1 (ruling R20)
  }
  if ("stt_model" in src && KIOSK_STT_MODEL_CHOICES.includes(src.stt_model)) out.stt_model = src.stt_model;
  if ("theme" in src && KIOSK_THEME_CHOICES.includes(src.theme)) out.theme = src.theme;
  for (const k of Object.keys(out)) if (!(k in KIOSK_DEFAULTS)) delete out[k];
  return out;
}

async function readAll(db) {
  const res = await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = ?", args: [KEY] });
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

/** A record without either token hash. */
function redact(record) {
  const { token_hash, kiosk_token_hash, ...rest } = record;
  return rest;
}

/** List paired devices (hashes redacted). */
export async function listDevices(db) {
  const devices = await readAll(db);
  return devices.map(redact);
}

/**
 * Bot Builder's one-device-per-bot rule: unbind every OTHER device bound to
 * botId — but never a kiosk display (a household display shares the bot by
 * design; saving a bot's glasses/companion gateway must not strand it).
 */
export async function unbindBotFromOtherDevices(db, botId, keepId) {
  const devices = await readAll(db);
  let changed = 0;
  for (const d of devices) {
    if (d.bound_bot_id === botId && d.id !== keepId && (d.device_kind || "glasses") !== "kiosk") { d.bound_bot_id = null; changed++; }
  }
  if (changed) await writeAll(db, devices);
  return { unbound: changed };
}

/** Find a device by id. Returns the raw record including token_hash. */
export async function findDevice(db, id) {
  const devices = await readAll(db);
  return devices.find((d) => d.id === id) || null;
}

/**
 * Pair a device: new bearer token, hash stored, plaintext returned once. Same id
 * → token rotation. Re-pair keeps the bot binding, voice profiles and settings.
 * Glasses/companion semantics are byte-for-byte the old store's: an omitted
 * device_kind means "glasses".
 */
export async function pairDevice(db, {
  id, name, generation = "unknown",
  household_profile = null, stt_profile_id = null,
  ai_profile_slug = null, tts_profile_id = null, vision_profile_id = null,
  ocr_enabled = false,
  photo_retention = "never",
  device_kind = "glasses",
  companion_features = null,
  kiosk_settings = null,
}) {
  if (!id) throw new Error("device id required");
  const kind = KIND_VALUES.has(device_kind) ? device_kind : "glasses";
  const token = randomBytes(32).toString("hex");
  // Kiosk (ruling R2): the real hash lives in kiosk_token_hash; token_hash gets
  // 32 random bytes that are the hash of NOTHING anyone holds, so every older
  // verifier (an installed meta-glasses copy compares sha256(<whatever string
  // the caller sends>) to token_hash) refuses a kiosk token — prefixed or not.
  const token_hash = kind === "kiosk" ? randomBytes(32).toString("hex") : tokenHash(token, kind);
  const devices = await readAll(db);
  const now = new Date().toISOString();
  const existing = devices.findIndex((d) => d.id === id);
  const prior = existing >= 0 ? devices[existing] : null;
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
    device_kind: kind,
    companion_features: companion_features ?? (prior ? prior.companion_features ?? null : null),
    bound_bot_id: prior ? (prior.bound_bot_id ?? null) : null,
  };
  if (kind === "kiosk") {
    record.kiosk_token_hash = tokenHash(token, "kiosk");
    record.kiosk_settings = normalizeKioskSettings(kiosk_settings, prior?.kiosk_settings);
  }
  if (existing >= 0) devices[existing] = record;
  else devices.push(record);
  await writeAll(db, devices);
  try {
    await db.execute({ sql: "DELETE FROM dashboard_settings WHERE key = ?", args: [UNPAIR_KEY_PREFIX + id] });
  } catch {}
  return { device: redact(record), token };
}

/** Unpair a device by id. */
export async function unpairDevice(db, id) {
  const devices = await readAll(db);
  const before = devices.length;
  const next = devices.filter((d) => d.id !== id);
  await writeAll(db, next);
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
 * Verify a bearer token against a device id. Returns the device (no hash) or
 * null. A kiosk record verifies ONLY when opts.kind === "kiosk"; a non-kiosk
 * record never verifies when opts.kind === "kiosk". last_seen is rewritten at
 * most once per LAST_SEEN_WRITE_MS (a kiosk reconnects often and every write
 * rewrites the whole JSON list).
 */
export async function verifyToken(db, id, token, opts = {}) {
  if (!id || !token) return null;
  const now = Number.isFinite(opts.now) ? opts.now : Date.now();
  const devices = await readAll(db);
  const idx = devices.findIndex((d) => d.id === id);
  if (idx === -1) return null;
  const record = devices[idx];
  const kind = record.device_kind || "glasses";
  if (opts.kind ? kind !== opts.kind : kind === "kiosk") return null;
  const stored = kind === "kiosk" ? record.kiosk_token_hash : record.token_hash;
  if (!constantTimeEqual(stored, tokenHash(String(token), kind))) return null;
  const last = record.last_seen ? Date.parse(record.last_seen) : NaN;
  if (!Number.isFinite(last) || now - last >= LAST_SEEN_WRITE_MS) {
    record.last_seen = new Date(now).toISOString();
    devices[idx] = record;
    await writeAll(db, devices);
  }
  return redact(record);
}

/** Update overrides on a device. device_kind can never be switched to or from "kiosk" (token hash domain). */
export async function updateDeviceProfiles(db, id, patch) {
  const devices = await readAll(db);
  const idx = devices.findIndex((d) => d.id === id);
  if (idx === -1) return null;
  const cur = devices[idx];
  const allow = ["household_profile", "stt_profile_id", "ai_profile_slug", "tts_profile_id", "vision_profile_id", "ocr_enabled", "photo_retention", "name", "bound_bot_id", "device_kind", "companion_features", "kiosk_settings"];
  for (const k of allow) {
    if (!(k in patch)) continue;
    if (k === "ocr_enabled") {
      cur[k] = asBool(patch[k]);
    } else if (k === "device_kind") {
      const curKind = cur.device_kind || "glasses";
      if (curKind === "kiosk" || patch[k] === "kiosk") continue;
      cur[k] = patch[k] === "companion" ? "companion" : "glasses";
    } else if (k === "companion_features") {
      let v = patch[k];
      if (typeof v === "string") { try { v = v ? JSON.parse(v) : null; } catch { v = cur[k] ?? null; } }
      cur[k] = v ?? null;
    } else if (k === "kiosk_settings") {
      if ((cur.device_kind || "glasses") === "kiosk") cur[k] = normalizeKioskSettings(patch[k], cur[k]);
    } else if (k === "photo_retention") {
      if (RETENTION_VALUES.has(patch[k])) cur[k] = patch[k];
    } else {
      cur[k] = patch[k] === "" ? null : patch[k];
    }
  }
  devices[idx] = cur;
  await writeAll(db, devices);
  return redact(cur);
}
