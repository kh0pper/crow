/**
 * The strict local check and the operator's "This is local" mark (roles
 * phase 2, Task 19; the owner's ruling (Q2)).
 *
 * Voice and the phone's local slot must run on a provider Crow can prove is
 * local. A provider on a DNS name (box.example.internal, a dotless name, a
 * tailnet name) cannot be proven local without DNS, so the strict check
 * (cloudStatus in model-roles.js) calls it "not proven local". The operator
 * can mark such a row "This is local" on this box:
 *
 *   dashboard_settings.provider_local_marks = {[rowId]: {host, at, by}}
 *
 * `host` is the row's hostname when it was marked (the one the page showed).
 * The mark counts only while the row still has that hostname, so a peer
 * rewriting the row's base URL through sync makes it lapse. A row whose
 * stored `host` is "cloud" (N4), or whose base URL is on a known cloud preset's
 * hostname (presetHostFor: api.z.ai, api.openai.com, ... and their
 * subdomains, any path, port or scheme) whatever its `host` says, is
 * never marked and never counts as local.
 * Marks, the one-time upgrade flag and the notice flag are instance scope:
 * never synced.
 *
 * Who uses marks: voice and the phone local slot (isStrictCloud), the Models
 * page's "where" chip and the cloud warnings. Who never does: the bot safety
 * classifier and the `safety` role (role-picks.js, role-change.js,
 * bot-classifier.mjs, classifier-status.js) and the pi role snapshot.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { isIP } from "node:net";
import { promises as dnsPromises } from "node:dns";
import { cloudStatus, isCloudKey, chainRows } from "./model-roles.js";
import { hostnameOf } from "./provider-host.js";
import { classifyIp, isLocalNetworkIp } from "./ip-classify.js";
import { getOwnAddresses } from "./locality.js";
import { providerRowToObject } from "./provider-row.js";
import { invalidateRoleContext } from "./model-roles-store.js";
import { presetHostFor } from "./provider-recommendations.js";
import { LOCAL_MARKS_KEY, parseMarksMap as parseMap, readLocalMarks } from "./provider-local-marks-read.js";

export { LOCAL_MARKS_KEY, readLocalMarks };
export const LOCAL_MARKS_SEEDED_KEY = "provider_local_marks_seeded";
export const LOCAL_NOTICE_SHOWN_KEY = "provider_local_notice_shown";
/** The value LOCAL_NOTICE_SHOWN_KEY takes once the operator dismisses the Models page banner. */
export const LOCAL_NOTICE_DISMISSED = "dismissed";
export const LOCAL_NOTICE_LINK = "/dashboard/settings?section=llm&tab=providers";

// ---- storage -------------------------------------------------------------------

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


// ---- change listeners ------------------------------------------------------------

const markListeners = new Set();

/** fn(rowId) after a mark is added or removed (the phone local slot refreshes at once). Returns the unsubscribe. */
export function addLocalMarksChangeListener(fn) {
  markListeners.add(fn);
  return () => markListeners.delete(fn);
}

function fireMarkListeners(rowId) {
  for (const fn of markListeners) {
    try {
      const r = fn(rowId);
      if (r && typeof r.catch === "function") r.catch((e) => console.warn("[roles] marks listener failed:", e?.message));
    } catch (e) {
      console.warn("[roles] marks listener failed:", e?.message);
    }
  }
}

// One marks write at a time in this process (read, change, write back).
let chain = Promise.resolve();
function locked(fn) {
  const run = chain.then(fn, fn);
  chain = run.then(() => {}, () => {});
  return run;
}

async function providerRow(db, id) {
  const { rows } = await db.execute({ sql: "SELECT * FROM providers WHERE id = ?", args: [id] });
  return rows[0] ? providerRowToObject(rows[0]) : null;
}

// ---- the page token -----------------------------------------------------------

/**
 * The opaque token the providers tab renders beside a row's "This is local"
 * checkbox (32 hex): an HMAC over the row id and its hostname under this
 * box's cloud-consent salt (servers/shared/cloud-consent.js), domain
 * separated from the consent token. A click on a page rendered before the
 * row's host changed carries a token that no longer matches.
 */
export function localMarkTokenFor(row, salt) {
  const id = typeof row?.id === "string" ? row.id : "";
  const host = hostnameOf(row?.baseUrl ?? row?.base_url) || "";
  return createHmac("sha256", Buffer.from(String(salt), "hex")).update(JSON.stringify(["local-mark-v1", id, host])).digest("hex").slice(0, 32);
}

function sameHex(a, b) {
  if (typeof a !== "string" || typeof b !== "string" || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

// ---- mark / unmark -------------------------------------------------------------

/**
 * Mark row `rowId` "This is local" on this box, recording its current
 * hostname. Refusals, in order: `not_found` (no row, or no hostname),
 * `public_address` (an IP literal that is not on a local network: public,
 * reserved or documentation), `ip_literal` (any other IP literal: its
 * address already says where it runs, so a mark never applies),
 * `flagged_cloud` (stored `host === "cloud"`, N4), `known_cloud` (the base
 * URL is on a known cloud preset's hostname, whatever `host` says), `changed` (the caller's
 * expectation no longer holds).
 *
 * `expect` is `{token}` (what the page rendered, localMarkTokenFor; the
 * salt is read here) or `{host}` (the hostname the caller checked, the
 * upgrade). Without `expect` the row is marked as it is now.
 * @returns {Promise<{ok:true}|{ok:false, reason:string}>}
 */
export async function markLocal(db, rowId, { actor, expect } = {}) {
  if (typeof rowId !== "string" || !rowId) return { ok: false, reason: "not_found" };
  return locked(async () => {
    const row = await providerRow(db, rowId);
    const host = row ? hostnameOf(row.baseUrl) : null;
    if (!row || !host) return { ok: false, reason: "not_found" };
    if (isIP(host)) return { ok: false, reason: isLocalNetworkIp(host) ? "ip_literal" : "public_address" };
    if (row.host === "cloud") return { ok: false, reason: "flagged_cloud" };
    if (presetHostFor(row) !== null) return { ok: false, reason: "known_cloud" };
    if (expect !== undefined) {
      let ok = false;
      if (expect && typeof expect.token === "string") {
        const { readCloudConsentSalt } = await import("./cloud-consent.js");
        const salt = await readCloudConsentSalt(db);
        ok = !!salt && sameHex(expect.token, localMarkTokenFor(row, salt));
      } else if (expect && typeof expect.host === "string") {
        ok = expect.host === host;
      }
      if (!ok) return { ok: false, reason: "changed" };
    }
    const all = parseMap(await readValue(db, LOCAL_MARKS_KEY));
    all[rowId] = { host, at: new Date().toISOString(), by: String(actor || "unknown") };
    await writeValue(db, LOCAL_MARKS_KEY, JSON.stringify(all));
    invalidateRoleContext();
    fireMarkListeners(rowId);
    return { ok: true };
  });
}

/** Remove row `rowId`'s mark (a no-op when there was none). */
export async function unmarkLocal(db, rowId) {
  return locked(async () => {
    const v = await readValue(db, LOCAL_MARKS_KEY);
    if (v == null) return { ok: true };
    const all = parseMap(v);
    if (Object.hasOwn(all, rowId)) {
      delete all[rowId];
      await writeValue(db, LOCAL_MARKS_KEY, JSON.stringify(all));
      invalidateRoleContext();
      fireMarkListeners(rowId);
    }
    return { ok: true };
  });
}

/** Is `row`'s mark present and still for its current hostname? Pure. */
export function isMarkCurrent(row, localMarks) {
  if (!row || !localMarks || typeof row.id !== "string" || !Object.hasOwn(localMarks, row.id)) return false;
  const h = hostnameOf(row.baseUrl);
  return !!h && localMarks[row.id]?.host === h;
}

// ---- the strict predicate --------------------------------------------------------

/** Every row the key's door walk visits (chainRows), each once. */
const rowsOfKey = (key, providers) => [...new Set(chainRows(key, { providers }))];

/**
 * The one predicate voice and the phone local slot use (N4): true when ANY
 * row the key's door walk visits is flagged `host === "cloud"` or sits on a
 * known cloud preset hostname (presetHostFor), or the
 * strict check with marks says some hop is not proven local (isCloudKey
 * judges the worst hop). Pure.
 */
export function isStrictCloud(key, { providers, localMarks, ownAddrs } = {}) {
  if (rowsOfKey(key, providers).some((r) => r.host === "cloud" || presetHostFor(r) !== null)) return true;
  return isCloudKey(key, { providers, localMarks, ...(ownAddrs ? { ownAddrs } : {}) });
}

/** The old check (before the strict one): only a row flagged `host === "cloud"` (on any hop) was cloud. */
export function oldCheckCloud(key, { providers } = {}) {
  return rowsOfKey(key, providers).some((r) => r.host === "cloud");
}

const loggedDisagreements = new Set();

/**
 * One console.warn per `consumer|key` per process when the strict check
 * calls a key cloud and the old one said local (controller ruling b). Tasks
 * 20 and 21 call it.
 */
export function logStrictDisagreement(consumer, key, { strictCloud, oldCloud } = {}) {
  if (!strictCloud || oldCloud) return;
  const id = `${consumer}|${key}`;
  if (loggedDisagreements.has(id)) return;
  loggedDisagreements.add(id);
  console.warn(`[roles] ${consumer} ${key}: not proven local under the strict check (the old check said local)`);
}

// ---- keys in use ---------------------------------------------------------------

/**
 * The keys voice and the phone local slot use today, raw: the voice router's
 * fast and escalate keys (resolveVoiceKeys, env first), the Crow voice bot's
 * `fast_voice_model`, and `phone_local_model`; a `role:` ref is resolved.
 * Unresolvable entries are left out. Never throws.
 * @returns {Promise<string[]>}
 */
export async function strictVoiceKeysInUse(db, { env = process.env } = {}) {
  const out = new Set();
  const { resolveRole } = await import("./model-roles-store.js");
  const { isRoleRef } = await import("./model-roles.js");
  const add = async (k) => {
    if (typeof k !== "string" || !k) return;
    if (!isRoleRef(k)) { out.add(k); return; }
    try {
      const r = await resolveRole(db, k, { need: "chat" });
      if (r && typeof r.key === "string" && r.key) out.add(r.key);
    } catch { /* unresolvable: left out */ }
  };
  try {
    const { resolveVoiceKeys } = await import("./voice-keys.js");
    const v = await resolveVoiceKeys(db, { env });
    await add(v?.fast);
    await add(v?.escalate);
  } catch (err) { console.warn(`[roles] voice keys unreadable: ${err?.message}`); }
  try {
    const { CROW_VOICE_BOT_ID } = await import("./voice-bot.js");
    const { rows } = await db.execute({ sql: "SELECT definition FROM pi_bot_defs WHERE bot_id = ?", args: [CROW_VOICE_BOT_ID] });
    if (rows[0]) {
      let def = null;
      try { def = JSON.parse(rows[0].definition || "{}"); } catch {}
      await add(def?.fast_voice_model);
    }
  } catch { /* no bot table or row */ }
  try { await add(await readValue(db, "phone_local_model")); } catch { /* none */ }
  return [...out];
}

// ---- affected rows ----------------------------------------------------------------

/** A single row's own verdict (no door walk, no marks). */
function rowVerdict(row, ownAddrs) {
  return cloudStatus(`${row.id}/_`, { providers: [row], resolveDoor: (r) => r, ownAddrs });
}

/**
 * Could this row take a "This is local" mark? An enabled row on a DNS name,
 * not flagged `host === "cloud"`, not on a known cloud preset hostname, whose own verdict (no marks) is "unknown".
 * An IP-literal row never qualifies: its address already says what it is.
 */
export function isMarkableRow(row, { ownAddrs } = {}) {
  if (!row || row.disabled || row.host === "cloud" || presetHostFor(row) !== null) return false;
  const h = hostnameOf(row.baseUrl);
  if (!h || isIP(h)) return false;
  return rowVerdict(row, ownAddrs || getOwnAddresses()) === "unknown";
}

/**
 * Rows behind `keys` that the strict check newly refuses: a DNS-named,
 * enabled row whose old check said local (stored host is not "cloud"), whose
 * own verdict is "unknown", and that carries no current mark. Pure.
 * @returns {object[]} provider objects, in first-seen order
 */
export function newlyStrictRows(keys, { providers, localMarks, ownAddrs } = {}) {
  const own = ownAddrs || getOwnAddresses();
  const seen = new Map();
  for (const key of keys || []) {
    for (const row of rowsOfKey(key, providers)) {
      if (seen.has(row.id) || !isMarkableRow(row, { ownAddrs: own }) || isMarkCurrent(row, localMarks)) continue;
      seen.set(row.id, row);
    }
  }
  return [...seen.values()];
}

// ---- the one-time upgrade ----------------------------------------------------------

const isLoopback = (a) => { const c = classifyIp(a); return c.cls === "loopback" && (c.via === null || c.via === "mapped"); };

function withTimeout(promise, ms) {
  let timer;
  return Promise.race([
    Promise.resolve(promise).finally(() => clearTimeout(timer)),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("lookup timed out")), ms); timer.unref?.(); }),
  ]);
}

async function defaultNotify(db, { names }) {
  const [{ createNotification }, { t, fill }] = await Promise.all([
    import("./notifications.js"),
    import("../gateway/dashboard/shared/i18n.js"),
  ]);
  let lang = "en";
  try { const l = await readValue(db, "language"); if (l === "es") lang = "es"; } catch {}
  await createNotification(db, {
    title: fill(t("providers.localNotice", lang), { names: names.join(", ") }),
    type: "system",
    source: "roles:local-marks",
    action_url: LOCAL_NOTICE_LINK,
  });
}

let upgradeRunning = null; // the run in progress in this process (one box, one DB)

/**
 * Run once per box (guarded by `provider_local_marks_seeded`), off the boot
 * path. For each row behind a key voice or the phone local slot uses
 * (newlyStrictRows: DNS name, old check said local, not proven local now):
 * when every address `lookupFn(host, {all:true})` returns within `timeoutMs`
 * is loopback or one of `ownAddrs`, mark it with actor `upgrade` (controller
 * ruling a); otherwise it is `affected`. A lookup that errors or times out
 * goes to `errors`, and the seeded flag stays unset so the next boot retries
 * (minor f). When `affected` is non-empty and `provider_local_notice_shown`
 * is unset, `notifyFn` sends one notification and the flag is set; if it
 * throws, the seeded flag also stays unset, so the next boot retries. Two
 * calls at once in one process share one run. Every run that is not skipped
 * logs one line with its counts, "nothing to mark" included.
 * @returns {Promise<{marked:string[], affected:string[], errors:string[], skipped?:true}>}
 */
export async function upgradeLocalMarks(db, { lookupFn = dnsPromises.lookup, ownAddrs, notifyFn = defaultNotify, timeoutMs = 3000, env = process.env } = {}) {
  if (upgradeRunning) return upgradeRunning;
  const run = (async () => {
    if (await readValue(db, LOCAL_MARKS_SEEDED_KEY)) return { marked: [], affected: [], errors: [], skipped: true };
    const own = ownAddrs || getOwnAddresses();
    const keys = await strictVoiceKeysInUse(db, { env });
    const { rows } = await db.execute("SELECT * FROM providers");
    const providers = rows.map(providerRowToObject);
    const candidates = newlyStrictRows(keys, { providers, localMarks: await readLocalMarks(db), ownAddrs: own });
    const marked = [], affected = [], errors = [];
    for (const row of candidates) {
      const host = hostnameOf(row.baseUrl);
      let addrs;
      try {
        addrs = await withTimeout(lookupFn(host, { all: true }), timeoutMs);
      } catch (err) {
        console.warn(`[roles] local check for ${row.id}: lookup failed (${err?.message})`);
        errors.push(row.id);
        continue;
      }
      const list = Array.isArray(addrs) ? addrs : addrs ? [addrs] : [];
      const ours = list.length > 0 && list.every((a) => typeof a?.address === "string" && (isLoopback(a.address) || own.has(a.address)));
      if (ours && (await markLocal(db, row.id, { actor: "upgrade", expect: { host } })).ok) marked.push(row.id);
      else affected.push(row.id);
    }
    let noticePending = false;
    if (affected.length && !(await readValue(db, LOCAL_NOTICE_SHOWN_KEY))) {
      try {
        await notifyFn(db, { names: affected });
        await writeValue(db, LOCAL_NOTICE_SHOWN_KEY, new Date().toISOString());
      } catch (err) {
        noticePending = true; // retried with the whole upgrade at the next boot
        console.warn(`[roles] local notice not sent: ${err?.message}`);
      }
    }
    if (!errors.length && !noticePending) await writeValue(db, LOCAL_MARKS_SEEDED_KEY, new Date().toISOString());
    // One line on every run that did work (the PR gate reads the boot log), "nothing to mark" included.
    console.log(candidates.length
      ? `[roles] local marks upgrade: ${candidates.length} candidates; marked ${marked.join(", ") || "none"}; not proven local ${affected.join(", ") || "none"}; lookup failed ${errors.join(", ") || "none"}`
      : `[roles] local marks upgrade: nothing to mark (0 candidates, ${keys.length} keys checked)`);
    return { marked, affected, errors };
  })();
  upgradeRunning = run;
  try { return await run; } finally { if (upgradeRunning === run) upgradeRunning = null; }
}
