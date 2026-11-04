/**
 * Crow's off-site copy of its own database: the nightly encrypted upload to the satellite's vault,
 * the retention plan, and the weekly read-back check (SAT-8 part B, spec §12).
 *
 * FUNCTIONS ONLY. The timers exist as templates under `scripts/systemd/` and are enabled at deploy
 * time; nothing here registers a timer, and nothing here runs unless a caller asks.
 *
 *   runOffsiteUpload → gate on a keychain Export, pick the newest local `crow.db` backup, encrypt
 *                      it with `crow-vault/v1`, stream it to the vault, confirm the satellite's
 *                      signed manifest reports the same size and sha256, then apply retention
 *                      (7 daily + 4 weekly).
 *   runOffsiteVerify → fetch the newest vault file back, check it against the signed manifest,
 *                      decrypt it with the rollback check, open it read-only, and require
 *                      `PRAGMA integrity_check` = ok and a memory count ≥ 90 % of the live DB's.
 *   planRetention    → the pure retention decision (names in, keep/remove out).
 *
 * Both jobs first sweep this user's leftover scratch directories (`crow-offsite-*` under the temp
 * dir, older than two hours): a run killed mid-flight would otherwise leave a decrypted crow.db
 * behind. A SIGTERM/SIGINT handler (`installScratchCleanupOnSignal`, installed by the timer's entry
 * point) does the same for the scratch of the run that is dying.
 *
 * The key never leaves this module's call frames: it is not logged, not returned, and not put in a
 * notification. Notification text names no key, path or hostname either (§12.3).
 *
 * A failure raises ONE notification a day per reason, deduplicated in `dashboard_settings` the same
 * way the health monitor does it (`health_last_notified`): a JSON map of reason → last ISO time with
 * a 24 h window, persisted so a restart does not re-notify.
 */
import { createHash, randomBytes } from "node:crypto";
import {
  closeSync, constants as fsc, createReadStream, lstatSync, mkdtempSync, openSync, readdirSync, renameSync, rmSync,
  unlinkSync, writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import Database from "better-sqlite3";
import { decryptVault, encryptVault } from "../../shared/crow-vault.js";
import { satelliteBaseUrl, readCapped, sendOnce } from "./client.js";
import { loadMgmtKey } from "./mgmt-keys.js";
import { listSatellites } from "./store.js";
import { signBytes, requestSigningString, signRequest, verifyResponse, sha256Hex } from "../../shared/satellite-protocol.js";
import { ensureOffsiteKey, offsiteKeyInExport } from "./offsite-key.js";
import { loadKeychainKey } from "../keychain/key.js";
import { createNotification } from "../../shared/notifications.js";
import { getOrCreateLocalInstanceId } from "../instance-registry.js";
import { loadIdentityIfPresent } from "../../sharing/identity.js";
import { listOwnBackups, localBackupContext, ownBackupRegex } from "../../shared/backup-naming.js";

const DAY = 24 * 60 * 60 * 1000;
export const KEEP_DAILY = 7;
export const KEEP_WEEKLY = 4;
/** A newest vault file older than this is an alarm: the nightly upload has stopped working. */
export const VERIFY_MAX_AGE_MS = 36 * 60 * 60 * 1000;
/** One notification per reason per this window (the health monitor's 24 h rule). */
export const NOTIFY_WINDOW_MS = DAY;
export const UPLOAD_TIMEOUT_MS = 30 * 60 * 1000;
export const DOWNLOAD_TIMEOUT_MS = 30 * 60 * 1000;
/** Where the vault status lives (read by the Servers page) and the notification markers. */
export const STATUS_SETTING = "offsite_vault_status";
export const NOTIFY_SETTING = "offsite_vault_notified";

/** `crow-db-<YYYYMMDD>.vault`. */
export const VAULT_NAME = /^crow-db-(\d{4})(\d{2})(\d{2})\.vault$/;

const isoDay = (ms) => new Date(ms).toISOString().slice(0, 10);
const utcMidnight = (ms) => Date.parse(`${isoDay(ms)}T00:00:00Z`);

/** "2026-11-02" → "crow-db-20261102.vault" (the name the satellite stores). */
export function vaultNameForDate(date) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(date))) throw new Error("vaultNameForDate: date must be YYYY-MM-DD");
  return `crow-db-${date.replaceAll("-", "")}.vault`;
}

/** {name, date, ms} for a vault file name, or null when it is not one. */
export function parseVaultName(name) {
  const m = VAULT_NAME.exec(typeof name === "string" ? name : "");
  if (!m) return null;
  const date = `${m[1]}-${m[2]}-${m[3]}`;
  const ms = Date.parse(`${date}T00:00:00Z`);
  // A real calendar day: 2026-02-30 and friends are not retention candidates.
  if (!Number.isFinite(ms) || new Date(ms).toISOString().slice(0, 10) !== date) return null;
  return { name, date, ms };
}

/**
 * The retention decision (spec §12.3): keep the 7 newest files dated TODAY OR EARLIER and the
 * Sunday of each of the last 4 weeks; everything else that is a vault file is removed. `today` is
 * a Date, an ISO timestamp or a `YYYY-MM-DD` day (UTC). Pure: no I/O, no clock.
 *
 * A week whose Sunday has no file contributes nothing — a gap is not filled with a nearby day, so a
 * "weekly" restore point is always really a Sunday.
 *
 * A file dated after `today` (a satellite clock that ran ahead, or a manual copy) is kept and never
 * deleted: retention only deletes what it can reason about. Those files take no daily slot either,
 * so a vault full of future-dated names can never push the real days out of the window — and
 * `keepName` (the file this upload just placed) is kept whatever the dates say, so retention can
 * never delete the copy that was confirmed a moment ago.
 *
 * @param {string[]} names
 * @param {Date|string|number} today
 * @param {{daily?:number, weekly?:number, keepName?:string|null}} [opts]
 * @returns {{keep:string[], remove:string[]}} names, in date order
 */
export function planRetention(names, today, { daily = KEEP_DAILY, weekly = KEEP_WEEKLY, keepName = null } = {}) {
  const todayMs = typeof today === "number" ? utcMidnight(today) : utcMidnight(Date.parse(today instanceof Date ? today.toISOString() : String(today)));
  const byDay = new Map();
  for (const name of Array.isArray(names) ? names : []) {
    const p = parseVaultName(name);
    if (p) byDay.set(p.date, name); // one file per day; a duplicate name collapses
  }
  const days = [...byDay.keys()].sort().reverse(); // newest first
  const dayMs = (d) => Date.parse(`${d}T00:00:00Z`);
  // Only real (today or earlier) days compete for the daily slots. A future-dated name is kept
  // below, but it never takes a slot: that is what stops a clock that ran ahead from pushing every
  // real day out of the window (and then deleting tonight's upload).
  const past = days.filter((d) => dayMs(d) <= todayMs);
  const keep = new Set(past.slice(0, Math.max(0, daily)));
  // The most recent Sunday on or before today, then one per week going back.
  const thisSunday = todayMs - new Date(todayMs).getUTCDay() * DAY;
  for (let i = 0; i < weekly; i++) {
    const d = isoDay(thisSunday - i * 7 * DAY);
    if (byDay.has(d)) keep.add(d);
  }
  for (const day of days) if (dayMs(day) > todayMs) keep.add(day);
  const fresh = keepName ? parseVaultName(keepName) : null;
  if (fresh && byDay.has(fresh.date)) keep.add(fresh.date);
  const order = (list) => [...list].sort();
  return { keep: order(keep).map((d) => byDay.get(d)), remove: order(days.filter((d) => !keep.has(d))).map((d) => byDay.get(d)) };
}

/**
 * The satellite that hosts the vault: the one paired record (spec §5.3, §8: one vault, one host).
 *
 * Stable by construction: the first by pairing time (`created_at`, which IS the paired_at clock —
 * the row has no separate column) among the non-revoked rows, whatever its status. An
 * "unreachable" row is still the vault's host, and trying it is how a server that has been down
 * for days produces its nightly alarm; skipping it would silently move the vault (and its
 * retention history) to another server, and hide exactly the case the alert exists for. More than
 * one paired server is a setup mistake rather than a choice, so only the first is ever used.
 */
export async function pickOffsiteSatellite(db) {
  const paired = (await listSatellites(db)).filter((s) => s.status !== "revoked");
  if (!paired.length) return null;
  const pairedAt = (s) => Date.parse(String(s.created_at ?? "")) || 0;
  paired.sort((a, b) => pairedAt(a) - pairedAt(b) || String(a.id).localeCompare(String(b.id)));
  return paired[0];
}

// ── scratch directories ─────────────────────────────────────────────────────

/** Every scratch directory these jobs create starts with this. */
export const SCRATCH_PREFIX = "crow-offsite-";
/** A leftover scratch dir older than this is debris from a killed run and is swept. */
export const SCRATCH_MAX_AGE_MS = 2 * 60 * 60 * 1000;

/** Scratch dirs THIS process is using right now (so a signal can remove them). */
const liveScratch = new Set();

/** mkdtemp under the temp dir with the off-site prefix, tracked for the signal cleanup. */
export function makeScratch(prefix = SCRATCH_PREFIX) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  liveScratch.add(dir);
  return dir;
}

/** Remove one scratch dir and forget it. Never throws: cleanup must not fail a job. */
export function dropScratch(dir) {
  if (!dir) return;
  liveScratch.delete(dir);
  try { rmSync(dir, { recursive: true, force: true }); } catch { /* already gone */ }
}

/** Remove every scratch dir this process still holds (the SIGTERM/SIGINT path). */
export function cleanupScratch() {
  const dirs = [...liveScratch];
  for (const d of dirs) dropScratch(d);
  return dirs.length;
}

/**
 * Sweep this user's leftover scratch directories: entries of the temp dir whose name starts with
 * `crow-offsite-`, older than `olderThanMs`, and a REGULAR directory (lstat: a symlink is never
 * followed and never removed, so a link planted at the prefix cannot make this delete anything
 * else). Returns the names it removed.
 */
export function sweepScratchDirs({ dir = tmpdir(), now = Date.now(), olderThanMs = SCRATCH_MAX_AGE_MS } = {}) {
  const swept = [];
  const cutoff = now - olderThanMs;
  let names = [];
  try { names = readdirSync(dir); } catch { return swept; }
  for (const name of names) {
    if (!name.startsWith(SCRATCH_PREFIX)) continue;
    const path = join(dir, name);
    try {
      const st = lstatSync(path);
      if (!st.isDirectory() || st.isSymbolicLink()) continue; // a link is not ours to follow or delete
      if (st.mtimeMs > cutoff) continue; // a live run's scratch: the dir's mtime moves as it fills
      rmSync(path, { recursive: true, force: true });
      liveScratch.delete(path);
      swept.push(name);
    } catch { /* raced with its own cleanup */ }
  }
  return swept;
}

/**
 * The timer's signal handling: remove this run's scratch (a killed verify would otherwise leave a
 * decrypted crow.db in the temp dir) and then exit. Returns an uninstall function (for tests).
 */
export function installScratchCleanupOnSignal({ exit = (code) => process.exit(code) } = {}) {
  const onSignal = (signal) => {
    try { cleanupScratch(); } catch { /* nothing left to do */ }
    exit(signal === "SIGINT" ? 130 : 143); // 128 + the signal number, as a shell reports it
  };
  const onTerm = () => onSignal("SIGTERM");
  const onInt = () => onSignal("SIGINT");
  process.on("SIGTERM", onTerm);
  process.on("SIGINT", onInt);
  return () => { process.off("SIGTERM", onTerm); process.off("SIGINT", onInt); };
}

// ── local backup ────────────────────────────────────────────────────────────

/**
 * The newest of THIS instance's own `crow.db` backups in the nightly backup directory
 * (`<label>-<date>.db`, written by the gateway's backup run — servers/shared/backup-naming.js).
 * Newest by the date in the name, then by mtime, so a manual "backup now" on the same day wins.
 */
export function findNewestBackup({ dir, env = process.env } = {}) {
  const ctx = localBackupContext(env);
  const re = ownBackupRegex(ctx.label, ctx.tag);
  const files = listOwnBackups(dir || ctx.dir, ctx.label, ctx.tag);
  const dated = [];
  for (const f of files) {
    const m = re.exec(f.name);
    if (!m) continue;
    dated.push({ ...f, date: m[1] });
  }
  if (!dated.length) return null;
  dated.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : b.mtimeMs - a.mtimeMs));
  return dated[0];
}

// ── settings bookkeeping ────────────────────────────────────────────────────

async function readSettingJson(db, key) {
  try {
    const { rows } = await db.execute({ sql: "SELECT value FROM dashboard_settings WHERE key = ?", args: [key] });
    const v = JSON.parse(rows?.[0]?.value ?? "null");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

async function writeSettingJson(db, key, value) {
  try {
    const text = JSON.stringify(value);
    await db.execute({
      sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES (?, ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = ?, updated_at = datetime('now')",
      args: [key, text, text],
    });
    return true;
  } catch {
    return false; // bookkeeping never breaks a backup
  }
}

/** What the Servers page shows: when the last upload and the last successful check happened. */
export async function readOffsiteStatus(db) {
  return readSettingJson(db, STATUS_SETTING);
}

async function recordStatus(db, patch) {
  const current = await readSettingJson(db, STATUS_SETTING);
  await writeSettingJson(db, STATUS_SETTING, { ...current, ...patch });
}

/**
 * One notification per reason per day, persisted (the health monitor's `health_last_notified`
 * rule). A refused notification (the type is switched off) still marks the day: the owner said no.
 */
export async function notifyOnceADay(db, code, notification, { now = Date.now, notify = createNotification } = {}) {
  const seen = await readSettingJson(db, NOTIFY_SETTING);
  const last = Date.parse(seen[code] ?? "");
  const t = now();
  if (Number.isFinite(last) && t - last < NOTIFY_WINDOW_MS) return false;
  // Only the newest few reasons are kept: this map is bookkeeping, not a log.
  const next = { ...seen, [code]: new Date(t).toISOString() };
  const recent = Object.entries(next).sort((a, b) => String(b[1]).localeCompare(String(a[1]))).slice(0, 12);
  await writeSettingJson(db, NOTIFY_SETTING, Object.fromEntries(recent));
  try {
    await notify(db, notification);
  } catch {
    /* a notification failure must never fail the backup */
  }
  return true;
}

// ── the vault API, crow side ────────────────────────────────────────────────

const caller = "owner-local"; // the vault is crow's own: never a bot, never a peer

/** Signed GET vault → the manifest array [{name, size, sha256, mtime}]. */
export async function listVault({ sat, mgmtKey = null, fetchImpl = globalThis.fetch, env = process.env } = {}) {
  const key = mgmtKey || loadMgmtKey(sat.id, { env });
  if (!key) throw Object.assign(new Error("no management key"), { code: "no_mgmt_key" });
  const path = "/satellite/v1/vault";
  const headers = { Accept: "application/json", ...signRequest(key.ed25519_priv, { method: "GET", pathQuery: path, body: "", satelliteId: sat.id, caller }) };
  const res = await sendOnce(fetchImpl, satelliteBaseUrl(sat.tailnet_host) + path, { method: "GET", headers, body: "", timeoutMs: 15000 });
  const raw = await readCapped(res, 1024 * 1024);
  const sig = res.headers.get("x-crow-sat-resp-sig");
  const ok = typeof sig === "string" && verifyResponse(sat.satellite_pubkey, { requestNonce: headers["X-Crow-Sat-Nonce"], status: res.status, bodySha256: sha256Hex(raw) }, sig);
  if (!ok) throw Object.assign(new Error("bad response signature"), { code: "bad_response_sig" });
  const json = JSON.parse(raw.toString("utf8"));
  if (res.status !== 200) throw Object.assign(new Error(String(json?.error || `status_${res.status}`)), { code: json?.error || `status_${res.status}` });
  if (!Array.isArray(json)) throw Object.assign(new Error("the manifest is not a list"), { code: "bad_manifest" });
  return json;
}

/** Length of a file plus its sha256, streamed (a vault file is over 100 MB). */
function fingerprint(file) {
  return new Promise((ok, fail) => {
    const h = createHash("sha256");
    let size = 0;
    createReadStream(file)
      .on("error", fail)
      .on("data", (d) => { size += d.length; h.update(d); })
      .on("end", () => ok({ size, sha256: h.digest("hex") }));
  });
}

/**
 * Signed streamed PUT of one vault file. The signature covers `sha256` (which the body must hash
 * to), given up front in `X-Crow-Sat-Body-Sha256`, because a 100 MB body cannot be buffered — this
 * is the one route where the signed hash is not computed from bytes in memory.
 * Resolves {status, json}; never throws (an unreachable satellite is status 0).
 */
export async function putVaultFile({ sat, file, size, sha256, mgmtKey = null, fetchImpl = globalThis.fetch, env = process.env, timeoutMs = UPLOAD_TIMEOUT_MS } = {}) {
  const key = mgmtKey || loadMgmtKey(sat.id, { env });
  if (!key) return { status: 0, json: { error: "no_mgmt_key" } };
  const path = `/satellite/v1/vault/${encodeURIComponent(basename(file))}`;
  const ts = String(Date.now());
  const nonce = randomBytes(16).toString("hex");
  const str = requestSigningString({ method: "PUT", pathQuery: path, bodySha256: sha256, ts, nonce, satelliteId: sat.id, caller });
  const headers = {
    Accept: "application/json",
    "Content-Type": "application/octet-stream",
    "Content-Length": String(size),
    "X-Crow-Sat-Body-Sha256": sha256,
    "X-Crow-Sat-Sig": signBytes(key.ed25519_priv, Buffer.from(str, "utf8")),
    "X-Crow-Sat-Ts": ts,
    "X-Crow-Sat-Nonce": nonce,
    "X-Crow-Sat-Caller": caller,
  };
  let res;
  try {
    res = await fetchImpl(satelliteBaseUrl(sat.tailnet_host) + path, {
      method: "PUT",
      headers,
      body: createReadStream(file),
      duplex: "half", // a streamed body needs it (undici); harmless for any other fetch
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    return { status: 0, json: { error: "unreachable", message: String(err?.message || err).slice(0, 200) } };
  }
  let raw = Buffer.alloc(0);
  try {
    raw = await readCapped(res, 64 * 1024);
  } catch {
    return { status: res.status, json: { error: "bad_response" } };
  }
  const sig = res.headers.get("x-crow-sat-resp-sig");
  const sigOk = typeof sig === "string" && verifyResponse(sat.satellite_pubkey, { requestNonce: nonce, status: res.status, bodySha256: sha256Hex(raw) }, sig);
  if (!sigOk) return { status: res.status, json: { error: "bad_response_sig" } };
  try {
    return { status: res.status, json: JSON.parse(raw.toString("utf8")) };
  } catch {
    return { status: res.status, json: { error: "bad_response" } };
  }
}

/**
 * Signed GET of one vault file, streamed to `dest` at 0600 and kept only when its size and sha256
 * match the signed manifest entry. Returns {ok:true, size, sha256} or {ok:false, code}.
 */
export async function downloadVaultFile({ sat, name, dest, size, sha256, mgmtKey = null, fetchImpl = globalThis.fetch, env = process.env, timeoutMs = DOWNLOAD_TIMEOUT_MS } = {}) {
  const key = mgmtKey || loadMgmtKey(sat.id, { env });
  if (!key) return { ok: false, code: "no_mgmt_key" };
  const path = `/satellite/v1/vault/${encodeURIComponent(name)}`;
  const headers = {
    Accept: "application/octet-stream",
    ...signRequest(key.ed25519_priv, { method: "GET", pathQuery: path, body: "", satelliteId: sat.id, caller }),
  };
  let res;
  try {
    res = await sendOnce(fetchImpl, satelliteBaseUrl(sat.tailnet_host) + path, { method: "GET", headers, body: "", timeoutMs });
  } catch (err) {
    return { ok: false, code: err?.code || "unreachable" };
  }
  const ct = String(res.headers.get("content-type") || "").toLowerCase().split(";")[0].trim();
  if (res.status !== 200 || ct !== "application/octet-stream" || !res.body) {
    try { await res.body?.cancel(); } catch { /* gone */ }
    return { ok: false, code: res.status !== 200 ? `status_${res.status}` : "bad_content_type" };
  }
  const part = `${dest}.part`;
  let fd = null;
  let keep = false;
  try {
    fd = openSync(part, fsc.O_WRONLY | fsc.O_CREAT | fsc.O_EXCL | (fsc.O_NOFOLLOW || 0), 0o600);
    const h = createHash("sha256");
    let got = 0;
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      got += value.byteLength;
      if (got > size) {
        try { await reader.cancel(); } catch { /* gone */ }
        return { ok: false, code: "size_mismatch" };
      }
      h.update(value);
      writeSync(fd, value);
    }
    closeSync(fd);
    fd = null;
    if (got !== size) return { ok: false, code: "size_mismatch" };
    if (h.digest("hex") !== sha256) return { ok: false, code: "sha256_mismatch" };
    renameSync(part, dest);
    keep = true;
    return { ok: true, size: got, sha256 };
  } catch {
    return { ok: false, code: "write_failed" };
  } finally {
    if (fd !== null) { try { closeSync(fd); } catch { /* closed */ } }
    if (!keep) { try { unlinkSync(part); } catch { /* never created */ } }
  }
}

/** Signed DELETE of one vault file. */
export async function deleteVaultFile({ sat, name, mgmtKey = null, fetchImpl = globalThis.fetch, env = process.env } = {}) {
  const key = mgmtKey || loadMgmtKey(sat.id, { env });
  if (!key) throw Object.assign(new Error("no management key"), { code: "no_mgmt_key" });
  const path = `/satellite/v1/vault/${encodeURIComponent(name)}`;
  const headers = { Accept: "application/json", ...signRequest(key.ed25519_priv, { method: "DELETE", pathQuery: path, body: "", satelliteId: sat.id, caller }) };
  const res = await sendOnce(fetchImpl, satelliteBaseUrl(sat.tailnet_host) + path, { method: "DELETE", headers, body: "", timeoutMs: 15000 });
  const raw = await readCapped(res, 64 * 1024);
  let json = null;
  try { json = JSON.parse(raw.toString("utf8")); } catch { json = { error: "bad_response" }; }
  return { status: res.status, json };
}

// ── the two jobs ────────────────────────────────────────────────────────────

const NOTIFICATIONS = {
  no_key_export: {
    type: "system", priority: "high",
    title: "Make a keychain export so your off-site backup can be restored",
    body: "Crow has not uploaded an encrypted backup to your server, because the off-site backup key is in no keychain export. Any backup uploaded now could never be decrypted after a disk loss. Export the keychain in Settings → Security & passwords, and the nightly upload starts by itself.",
    action_url: "/dashboard/settings?section=passwords",
  },
  upload_failed: {
    type: "system", priority: "high",
    title: "Tonight's off-site backup did not upload",
    body: "Crow could not place the encrypted copy of its database on your server. Your local backups are unaffected. Check that the server is online and paired, then run the upload again.",
    action_url: "/dashboard/extensions#servers",
  },
  verify_failed: {
    type: "system", priority: "high",
    title: "The off-site backup failed its check",
    body: "Crow could not read the newest encrypted copy back from your server, or what came back is not a sound database. Your local backups are unaffected. The copy on the server should be replaced.",
    action_url: "/dashboard/extensions#servers",
  },
  verify_stale: {
    type: "system", priority: "high",
    title: "The off-site backup has not been updated in over 36 hours",
    body: "The newest encrypted copy on your server is more than a day and a half old, so the nightly upload has stopped working. Your local backups are unaffected.",
    action_url: "/dashboard/extensions#servers",
  },
  stale_backup: {
    type: "system", priority: "high",
    title: "Tonight's off-site backup was not sent",
    body: "The nightly backup has not run for over a day, so nothing new was sent off-site. Your existing backups are unaffected. Check that the nightly backup job is still running, then run the upload again.",
    action_url: "/dashboard/extensions#servers",
  },
};

/**
 * Encrypt tonight's database backup and put it in the satellite's vault, then apply retention.
 * `backupDir` is the nightly backup directory (default: CROW_BACKUP_DIR or ~/backups/crow).
 * Returns {ok:true, name, size, sha256, removed} or {ok:false, code}.
 */
export async function runOffsiteUpload({
  db, env = process.env, now = Date.now, notify = createNotification, fetchImpl = globalThis.fetch,
  backupDir = null, identityFn = () => loadIdentityIfPresent(), keychainKeyFn = () => loadKeychainKey(),
  instanceIdFn = () => getOrCreateLocalInstanceId(),
} = {}) {
  if (!db) throw new Error("runOffsiteUpload: a db client is required");
  const at = new Date(now()).toISOString();
  const skip = async (code) => ({ ok: false, code });
  const failed = async (code) => {
    const key = code === "no_key_export" || code === "stale_backup" ? code : "upload_failed";
    await recordStatus(db, { last_error: code, last_error_at: at });
    await notifyOnceADay(db, key, NOTIFICATIONS[key], { now, notify });
    return { ok: false, code };
  };

  // 0. Debris from a run that was killed before its own cleanup (a decrypted crow.db, an encrypted
  //    copy) is removed before this run adds more. Wall-clock age: the job's `now` is injectable.
  sweepScratchDirs();

  // 1. The satellite that hosts the vault. Checked BEFORE the export gate: a host with no server
  //    paired has nothing to export a key for, so it must not be told to make one.
  const sat = await pickOffsiteSatellite(db);
  if (!sat) return skip("no_satellite");

  // 2. A backup nobody can decrypt is worse than no backup: nothing uploads until an Export holds
  //    the key (spec §12.1).
  if (!(await offsiteKeyInExport(db))) return failed("no_key_export");

  // 3. The newest local crow.db backup, and it must be a fresh one: re-sending the same old file
  //    every night would look like a working off-site copy while the local backup job is dead.
  const backup = findNewestBackup({ dir: backupDir, env });
  if (!backup) return skip("no_backup");
  // Stale if EITHER clock says so: a copied or touched old backup gets a fresh mtime, but its name
  // date (the clock verify and retention use) still gives it away.
  const nameMs = Date.parse(`${backup.date}T00:00:00Z`);
  const backupAgeMs = now() - Math.min(nameMs, Number.isFinite(backup.mtimeMs) ? backup.mtimeMs : nameMs);
  if (!(backupAgeMs <= VERIFY_MAX_AGE_MS)) return failed("stale_backup");

  const identity = identityFn();
  if (!identity?.crowId) return failed("upload_failed");
  let key;
  try {
    key = (await ensureOffsiteKey(db, keychainKeyFn())).key;
  } catch {
    return failed("upload_failed");
  }

  const name = vaultNameForDate(backup.date);
  let scratch = null;
  try {
    // 4. Encrypt to a 0600 temp file, dated by the backup it came from.
    scratch = makeScratch();
    const vaultFile = join(scratch, name);
    await encryptVault({
      input: backup.path, output: vaultFile, key, backupDate: backup.date,
      createdAt: new Date(backup.mtimeMs || now()), sourceInstanceId: String(instanceIdFn()), crowId: identity.crowId,
    });
    const { size, sha256 } = await fingerprint(vaultFile);

    // 5. Upload, then confirm the satellite's signed manifest reports what was sent.
    const put = await putVaultFile({ sat, file: vaultFile, size, sha256, fetchImpl, env });
    if (put.status !== 200) return failed("upload_failed");
    let list;
    try {
      list = await listVault({ sat, fetchImpl, env });
    } catch {
      return failed("upload_failed");
    }
    const entry = list.find((e) => e?.name === name);
    if (!entry || entry.size !== size || entry.sha256 !== sha256) return failed("upload_failed");

    // 6. Retention: 7 daily + 4 weekly, applied to what the satellite actually holds. The file
    //    just confirmed is kept unconditionally: future-dated names must never push it out.
    const plan = planRetention(list.map((e) => e?.name).filter(Boolean), new Date(now()), { keepName: name });
    const removed = [];
    for (const old of plan.remove) {
      try {
        const r = await deleteVaultFile({ sat, name: old, fetchImpl, env });
        if (r.status === 200) removed.push(old);
      } catch { /* keep going: one stuck file must not fail the night's upload */ }
    }

    await recordStatus(db, {
      last_uploaded_at: at, last_uploaded_name: name, last_uploaded_size: size, last_uploaded_satellite: sat.id,
      last_error: null, last_error_at: null,
    });
    return { ok: true, name, size, sha256, removed };
  } catch {
    return failed("upload_failed");
  } finally {
    // 7. The encrypted temp copy is never left behind (the vault has the only copy that matters).
    dropScratch(scratch);
  }
}

/** `integrity_check` rows, all of which must read "ok". */
function integrityOk(handle) {
  let rows;
  try { rows = handle.pragma("integrity_check"); } catch { return false; }
  const list = Array.isArray(rows) ? rows : [rows];
  return list.length > 0 && list.every((r) => String(r?.integrity_check ?? r) === "ok");
}

function memoryCount(handle) {
  try { return Number(handle.prepare("SELECT COUNT(*) AS n FROM memories").get()?.n ?? 0); } catch { return 0; }
}

async function liveMemoryCount(db) {
  try {
    const { rows } = await db.execute("SELECT COUNT(*) AS n FROM memories");
    return Number(rows?.[0]?.n ?? 0);
  } catch {
    return 0;
  }
}

/**
 * Fetch the newest vault file back, decrypt it, and check it is a sound database with roughly the
 * memories crow has now (spec §12.3). Returns {ok:true, name, memories, live_memories} or
 * {ok:false, code}.
 */
export async function runOffsiteVerify({
  db, env = process.env, now = Date.now, notify = createNotification, fetchImpl = globalThis.fetch,
  keychainKeyFn = () => loadKeychainKey(), maxAgeMs = VERIFY_MAX_AGE_MS,
} = {}) {
  if (!db) throw new Error("runOffsiteVerify: a db client is required");
  const at = new Date(now()).toISOString();
  const failed = async (code) => {
    await recordStatus(db, { last_error: code, last_error_at: at });
    const key = code === "stale" ? "verify_stale" : "verify_failed";
    await notifyOnceADay(db, key, NOTIFICATIONS[key], { now, notify });
    return { ok: false, code };
  };

  sweepScratchDirs();

  const sat = await pickOffsiteSatellite(db);
  if (!sat) return { ok: false, code: "no_satellite" };

  let key;
  try {
    key = (await ensureOffsiteKey(db, keychainKeyFn())).key;
  } catch {
    return failed("no_key");
  }

  let list;
  try {
    list = await listVault({ sat, fetchImpl, env });
  } catch {
    return failed("unreachable");
  }
  const entries = list.map((e) => ({ ...e, parsed: parseVaultName(e?.name) })).filter((e) => e.parsed);
  if (!entries.length) return failed("no_backups");
  entries.sort((a, b) => b.parsed.ms - a.parsed.ms);
  // The newest file dated TODAY OR EARLIER. A name dated in the future is a satellite clock that
  // ran ahead, and choosing it would mean checking a file that cannot be this week's backup.
  const todayMs = utcMidnight(now());
  const newest = entries.find((e) => e.parsed.ms <= todayMs);
  // Age is measured from the NAME's date, not the file's mtime: the decrypt's rollback check
  // authenticates that date (header date ± 1 day), while mtime is whatever the satellite says.
  if (!newest || now() - newest.parsed.ms > maxAgeMs) return failed("stale");

  let scratch = null;
  try {
    scratch = makeScratch("crow-offsite-verify-");
    const vaultFile = join(scratch, newest.name);
    const got = await downloadVaultFile({ sat, name: newest.name, dest: vaultFile, size: newest.size, sha256: newest.sha256, fetchImpl, env });
    if (!got.ok) return failed("download_failed");
    const plain = join(scratch, "crow.db");
    try {
      await decryptVault({ file: vaultFile, out: plain, key, date: newest.parsed.date });
    } catch {
      return failed("decrypt_failed");
    }
    let handle;
    try {
      handle = new Database(plain, { readonly: true, fileMustExist: true });
    } catch {
      return failed("integrity_failed");
    }
    try {
      if (!integrityOk(handle)) return failed("integrity_failed");
      const memories = memoryCount(handle);
      const live = await liveMemoryCount(db);
      // A sanity check, not equality: a backup taken before the last writes is normal, an empty
      // or truncated database is not (spec §12.3).
      if (memories * 10 < live * 9) {
        await recordStatus(db, { memories, live_memories: live });
        return failed("memories_low");
      }
      await recordStatus(db, {
        last_verified_at: at, last_verified_name: newest.name, last_verified_size: newest.size,
        memories, live_memories: live, last_error: null, last_error_at: null,
      });
      return { ok: true, name: newest.name, size: newest.size, sha256: newest.sha256, memories, live_memories: live };
    } finally {
      try { handle.close(); } catch { /* closed */ }
    }
  } finally {
    dropScratch(scratch);
  }
}