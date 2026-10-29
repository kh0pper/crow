/**
 * Which cloud provider rows bots may use, per box (roles phase 2, Task 15).
 *
 * Provider rows sync between paired Crows, so any peer can write a row's
 * address or key. The cloud door (/llm/c) therefore forwards only for rows
 * THIS box agreed to, and only while the row still has the address and key it
 * had when it agreed:
 *
 *   dashboard_settings.llm_cloud_door_rows = {[rowId]: {target, keyFp, at, by}}
 *
 * `target` is the row's normalised base URL (origin and path, `normalizeBaseUrl`);
 * `keyFp` is the first 16 hex of HMAC-SHA256(trimmed key) under a random
 * per-box salt (`llm_cloud_consent_salt`, minted once). The key itself is never
 * stored, and the salt keeps the fingerprint from matching a plain hash of the
 * key anywhere else (N7). Both keys are instance scope: never synced.
 *
 * Writes go straight to the global dashboard_settings table (instance-scope
 * keys are read global-direct), one at a time in this process.
 */
import { createHmac, randomBytes } from "node:crypto";
import { normalizeBaseUrl } from "./provider-presets.js";
import { providerRowToObject } from "./provider-row.js";
import { isLocalClassTarget, isForbiddenTarget, isDoorUrl } from "../gateway/models/door-resolve.js";

export const CLOUD_CONSENT_KEY = "llm_cloud_door_rows";
export const CLOUD_CONSENT_SALT_KEY = "llm_cloud_consent_salt";

const SEED_ACTOR = "seed";

// One consent write at a time in this process (read, change, write back).
let chain = Promise.resolve();
function locked(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(() => {}, () => {});
  return run;
}

async function readValue(db, key) {
  const { rows } = await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = ?", args: [key] });
  return rows[0]?.value ?? null;
}

async function writeValue(db, key, value) {
  await db.execute({
    sql: `INSERT INTO dashboard_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))
          ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = datetime('now')`,
    args: [key, value],
  });
}

function parseMap(v) {
  try {
    const parsed = v ? JSON.parse(v) : {};
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch { return {}; }
}

/** The whole consent map, or {} when none is stored or it does not parse. */
export async function readCloudConsent(db) {
  try { return parseMap(await readValue(db, CLOUD_CONSENT_KEY)); } catch { return {}; }
}

/** This box's salt (64 hex), or null when none has been minted. */
export async function readCloudConsentSalt(db) {
  try {
    const v = await readValue(db, CLOUD_CONSENT_SALT_KEY);
    return typeof v === "string" && /^[0-9a-f]{64}$/.test(v) ? v : null;
  } catch { return null; }
}

/** The salt, minted on first use. INSERT OR IGNORE, so two processes agree on one. */
async function ensureSalt(db) {
  const have = await readCloudConsentSalt(db);
  if (have) return have;
  await db.execute({
    sql: "INSERT OR IGNORE INTO dashboard_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))",
    args: [CLOUD_CONSENT_SALT_KEY, randomBytes(32).toString("hex")],
  });
  const salt = await readCloudConsentSalt(db);
  if (!salt) throw new Error("cloud consent salt unreadable");
  return salt;
}

const keyOf = (row) => {
  const raw = row?.apiKey ?? row?.api_key;
  return typeof raw === "string" ? raw.trim() : "";
};
const targetOf = (row) => normalizeBaseUrl(row?.baseUrl ?? row?.base_url);

/** First 16 hex of HMAC-SHA256(trimmed key) under `salt`; never the key or its plain hash. */
function keyFingerprint(row, salt) {
  return createHmac("sha256", Buffer.from(salt, "hex")).update(keyOf(row)).digest("hex").slice(0, 16);
}

function entryFor(row, salt, by) {
  return { target: targetOf(row), keyFp: keyFingerprint(row, salt), at: new Date().toISOString(), by: String(by || "unknown") };
}

async function providerRow(db, id) {
  const { rows } = await db.execute({ sql: "SELECT * FROM providers WHERE id = ?", args: [id] });
  return rows[0] ? providerRowToObject(rows[0]) : null;
}

/**
 * Agree that bots may use row `rowId` at its current address and key.
 * `{ok:false, reason:"not_found"}` when there is no such row.
 */
export async function grantCloudConsent(db, rowId, { actor } = {}) {
  if (typeof rowId !== "string" || !rowId) return { ok: false, reason: "not_found" };
  return locked(async () => {
    const row = await providerRow(db, rowId);
    if (!row) return { ok: false, reason: "not_found" };
    const salt = await ensureSalt(db);
    const all = parseMap(await readValue(db, CLOUD_CONSENT_KEY));
    all[rowId] = entryFor(row, salt, actor);
    await writeValue(db, CLOUD_CONSENT_KEY, JSON.stringify(all));
    return { ok: true };
  });
}

/** Withdraw consent for `rowId` (a no-op when there was none). */
export async function revokeCloudConsent(db, rowId) {
  return locked(async () => {
    const v = await readValue(db, CLOUD_CONSENT_KEY);
    if (v == null) return { ok: true };
    const all = parseMap(v);
    if (Object.hasOwn(all, rowId)) {
      delete all[rowId];
      await writeValue(db, CLOUD_CONSENT_KEY, JSON.stringify(all));
    }
    return { ok: true };
  });
}

/**
 * May bots use `row` now? `consent` is the row's own entry (or the whole map,
 * when `row.id` is set). "ok", or why not: "not_consented" (no usable entry),
 * "host_changed" (origin or path differ), "key_changed" (another key, or no
 * salt to check it with). Pure.
 */
export function consentVerdict(row, consent, { salt } = {}) {
  let entry = consent;
  if (entry && typeof entry === "object" && typeof entry.target !== "string" && row?.id && Object.hasOwn(entry, row.id)) entry = entry[row.id];
  if (!entry || typeof entry !== "object" || typeof entry.target !== "string" || typeof entry.keyFp !== "string") return "not_consented";
  if (entry.target !== targetOf(row)) return "host_changed";
  if (typeof salt !== "string" || !/^[0-9a-f]{64}$/.test(salt)) return "key_changed";
  return entry.keyFp === keyFingerprint(row, salt) ? "ok" : "key_changed";
}

/** A row the cloud door could serve: a public address, never a door, loopback, LAN or tailnet one. */
export function isCloudRow(row) {
  const url = row?.baseUrl ?? row?.base_url;
  if (typeof url !== "string" || !url) return false;
  return !isLocalClassTarget(url) && !isForbiddenTarget(url) && !isDoorUrl(url);
}

/**
 * One-time seed for boxes upgrading into consent: only while the consent key
 * is absent, grant every enabled cloud row whose `instance_id` is this box's
 * own id (rows this box wrote). A row a peer wrote, or one with no instance id
 * at all, is never seeded. With no own id known, nothing is written, so a
 * later boot can still seed.
 */
export async function seedCloudConsent(db, { ownInstanceId } = {}) {
  if (typeof ownInstanceId !== "string" || !ownInstanceId) return { seeded: [] };
  return locked(async () => {
    if ((await readValue(db, CLOUD_CONSENT_KEY)) != null) return { seeded: [] };
    const { rows } = await db.execute("SELECT * FROM providers WHERE disabled = 0 ORDER BY id");
    const mine = rows.map(providerRowToObject).filter((r) => r.instance_id === ownInstanceId && isCloudRow(r));
    const all = {};
    if (mine.length) {
      const salt = await ensureSalt(db);
      for (const r of mine) all[r.id] = entryFor(r, salt, SEED_ACTOR);
    }
    // Insert only if still absent: the seed never overwrites a real grant.
    await db.execute({
      sql: "INSERT OR IGNORE INTO dashboard_settings (key, value, updated_at) VALUES (?, ?, datetime('now'))",
      args: [CLOUD_CONSENT_KEY, JSON.stringify(all)],
    });
    return { seeded: mine.map((r) => r.id) };
  });
}
