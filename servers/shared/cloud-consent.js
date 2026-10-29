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
 * A grant records only what the caller saw: the page's opaque token, or the
 * URL and key addProvider just wrote. Nothing is granted automatically (see
 * the note at the end of this file).
 *
 * Writes go straight to the global dashboard_settings table (instance-scope
 * keys are read global-direct), one at a time in this process.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { normalizeBaseUrl } from "./provider-presets.js";
import { providerRowToObject } from "./provider-row.js";
import { isLocalClassTarget, isForbiddenTarget, isDoorUrl } from "../gateway/models/door-resolve.js";
import { DOOR_ID_PREFIX } from "./pi-compat.js";
import { isIP } from "node:net";
import { isPublicIp } from "./ip-classify.js";

export const CLOUD_CONSENT_KEY = "llm_cloud_door_rows";
export const CLOUD_CONSENT_SALT_KEY = "llm_cloud_consent_salt";

const _consentListeners = new Set();
/** Fire-and-forget listeners called after every grant or revoke in this
 * process (the pi models.json sync). Returns the unsubscribe. */
export function onCloudConsentChange(fn) {
  if (typeof fn !== "function") return () => {};
  _consentListeners.add(fn);
  return () => { _consentListeners.delete(fn); };
}
function consentChanged(rowId) {
  for (const fn of _consentListeners) {
    try { fn({ id: rowId }); } catch (err) { console.warn(`[cloud-consent] change listener failed: ${err.message}`); }
  }
}

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

/** A consent expectation: what an entry for `row` would hold, under `salt`. */
function expectationOf(row, salt) {
  return { target: targetOf(row), keyFp: keyFingerprint(row, salt) };
}

/**
 * The opaque token a page renders for `row` (32 hex): an HMAC over the row's
 * id, target and key fingerprint under the salt. It never carries the key or
 * keyFp; another row (even one with the same address and key), address or
 * key gives a different token.
 */
export function consentTokenFor(row, salt) {
  const { target, keyFp } = expectationOf(row, salt);
  const id = typeof row?.id === "string" ? row.id : "";
  return createHmac("sha256", Buffer.from(salt, "hex")).update(JSON.stringify(["consent-token-v2", id, target, keyFp])).digest("hex").slice(0, 32);
}

/** This box's salt, minted on first use (render calls this to put a token on the page). */
export const ensureCloudConsentSalt = (db) => ensureSalt(db);

function sameHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

/**
 * Does `row`, now, still hold what the caller saw? `expect` is either
 * `{consentToken}` (what a page rendered, `consentTokenFor`) or
 * `{baseUrl, apiKey}` (what a caller just wrote). Anything else is false.
 */
function matchesExpectation(row, salt, expect) {
  if (!expect || typeof expect !== "object") return false;
  if (typeof expect.consentToken === "string") return sameHex(expect.consentToken, consentTokenFor(row, salt));
  if (typeof expect.baseUrl === "string") {
    const seen = expectationOf({ baseUrl: expect.baseUrl, apiKey: expect.apiKey ?? null }, salt);
    const now = expectationOf(row, salt);
    return seen.target === now.target && sameHex(seen.keyFp, now.keyFp);
  }
  return false;
}

/**
 * Agree that bots may use row `rowId`, but only if it still holds what the
 * caller saw (`expect`, see matchesExpectation): consent is never recorded
 * for an address or key the operator did not see or write. Refusals:
 * `not_found`, `disabled`, `not_cloud` (a local, door or forbidden address:
 * the cloud door never serves it), `changed` (the row differs from what was
 * seen, or no expectation was given).
 * @returns {Promise<{ok:true}|{ok:false, reason:string}>}
 */
export async function grantCloudConsent(db, rowId, { actor, expect } = {}) {
  if (typeof rowId !== "string" || !rowId) return { ok: false, reason: "not_found" };
  return locked(async () => {
    const row = await providerRow(db, rowId);
    if (!row) return { ok: false, reason: "not_found" };
    if (row.disabled) return { ok: false, reason: "disabled" };
    const why = cloudDoorIneligibleReason(row);
    if (why === "not_cloud") return { ok: false, reason: "not_cloud" };
    if (why) return { ok: false, reason: "not_eligible", why };
    const salt = await ensureSalt(db);
    if (!matchesExpectation(row, salt, expect)) return { ok: false, reason: "changed" };
    const all = parseMap(await readValue(db, CLOUD_CONSENT_KEY));
    all[rowId] = entryFor(row, salt, actor);
    await writeValue(db, CLOUD_CONSENT_KEY, JSON.stringify(all));
    consentChanged(rowId);
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
      consentChanged(rowId);
    }
    return { ok: true };
  });
}

/**
 * May bots use `row` now? `entry` is the row's OWN consent entry
 * (`readCloudConsent(db)[rowId]`), never the whole map. "ok", or why not:
 * "not_consented" (no usable entry), "host_changed" (origin or path differ),
 * "key_changed" (another key, or no salt to check it with). Pure.
 */
export function consentVerdict(row, entry, { salt } = {}) {
  if (!entry || typeof entry !== "object" || typeof entry.target !== "string" || typeof entry.keyFp !== "string") return "not_consented";
  if (entry.target !== targetOf(row)) return "host_changed";
  if (typeof salt !== "string" || !/^[0-9a-f]{64}$/.test(salt)) return "key_changed";
  return sameHex(entry.keyFp, keyFingerprint(row, salt)) ? "ok" : "key_changed";
}

/** A row the cloud door could serve: a public address, never a door, loopback, LAN or tailnet one. */
export function isCloudRow(row) {
  const url = row?.baseUrl ?? row?.base_url;
  if (typeof url !== "string" || !url) return false;
  return !isLocalClassTarget(url) && !isForbiddenTarget(url) && !isDoorUrl(url);
}

const OPENAI_FAMILY = new Set([null, undefined, "", "openai-compat", "openai"]);

/**
 * Why the cloud door would never serve `row`, or null when it could (consent
 * aside). The one rule the providers-tab switch, grantCloudConsent, the pi
 * models.json door entries and the door's resolveCloudTarget share, checked
 * in this order:
 *   "disabled", "not_cloud" (`isCloudTarget`, default isCloudRow),
 *   "forbidden_target" (a scheme other than http(s), userinfo in the URL, or
 *   an IP literal that is not public: `isPublicIp`, the door's own check),
 *   "reserved_id" (crow-c-*, any case: the door entries' own namespace),
 *   "local_only", "insecure" (not https; `allowInsecure(url)` is the door
 *   tests' seam for a plain-http fake upstream), "unsupported_type" (neither
 *   the openai family nor anthropic), "no_key" (empty, blank or "none").
 * Pure.
 */
export function cloudDoorIneligibleReason(row, { isCloudTarget = (url) => isCloudRow({ baseUrl: url }), allowInsecure = () => false } = {}) {
  if (!row || typeof row !== "object" || row.disabled) return "disabled";
  const url = row.baseUrl ?? row.base_url;
  if (typeof url !== "string" || !url || !isCloudTarget(url)) return "not_cloud";
  let u;
  try { u = new URL(url); } catch { return "forbidden_target"; }
  const host = u.hostname.replace(/^\[|\]$/g, "");
  if ((u.protocol !== "http:" && u.protocol !== "https:") || u.username || u.password || (isIP(host) && !isPublicIp(host))) return "forbidden_target";
  if (typeof row.id === "string" && row.id.toLowerCase().startsWith(DOOR_ID_PREFIX)) return "reserved_id";
  if (row.gpuPolicy?.local_only === true || row.gpu_policy?.local_only === true) return "local_only";
  if (u.protocol !== "https:" && !allowInsecure(url)) return "insecure";
  const type = row.provider_type ?? row.providerType;
  if (type !== "anthropic" && !OPENAI_FAMILY.has(type)) return "unsupported_type";
  const key = keyOf(row);
  if (!key || key === "none") return "no_key";
  return null;
}

/** May the cloud door serve `row` at all (consent aside)? See cloudDoorIneligibleReason. */
export function cloudDoorEligible(row, opts) { return cloudDoorIneligibleReason(row, opts) === null; }

// There is deliberately NO automatic seed (fix round 1, Task 15). A one-time
// "grant the rows this box wrote" pass would have to trust
// providers.instance_id, and inbound sync keeps whatever instance_id a peer
// sends, so nothing local proves this box wrote a row. A row is consented only
// by an explicit act on this box: its own addProvider (for the URL and key it
// just wrote) or the operator's "Let bots use this provider" switch. Bots do
// not reach cloud rows through the door before this ships, so nothing that
// works today stops. The Phase 3 convert pass will offer a one-time consent
// step for existing cloud rows, shown to the operator.
