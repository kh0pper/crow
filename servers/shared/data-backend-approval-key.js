/**
 * The secrets kept OUTSIDE crow.db that make a data-backend approval
 * unforgeable, and impossible to replay:
 *
 * - `<CROW_HOME>/secrets/data-backend-approval.key` — 32 random bytes, the HMAC
 *   key (dir 0700, file 0600). The owner's approval is stored in the same
 *   `data_backends` row it approves, so a value that could be recomputed from
 *   the row alone (a plain SHA-256 of the command) proves nothing: anything
 *   that can write crow.db could plant an "approved" row. A keyed value cannot
 *   be computed without this file.
 * - `<CROW_HOME>/secrets/data-backend-approvals.json` — one nonce per approved
 *   row id, `{ "v": 1, "rows": { "<row id>": "<32 hex>" } }` (0600). The nonce
 *   is part of what the approval HMAC covers, so a stored value belongs to one
 *   row and stops verifying when the owner revokes (the nonce is removed) or
 *   when it is copied onto another row (different id, no nonce). A delete path
 *   removes the row's nonce too, and the gateway prunes any entry whose row is
 *   no longer in the table, so a deleted row put back with its old id and value
 *   still verifies for nothing.
 *
 * Both files live in the dir bots cannot see and backups never carry (the
 * peer-token store's rule, peer-credentials.js), and both are reached through
 * the anchored secrets dir (anchoredPath, secret-values.js): a dir renamed and
 * replaced at the path is never used. A file this uid does not own, or one with
 * group/other bits set, is REFUSED — a key another principal can read or
 * rewrite proves nothing.
 *
 * Creating the key is once and crash-safe: the bytes go to a unique temp file
 * in the same dir, are fsynced, and are then `link`ed into place (atomic). First
 * use is serialised across processes by an exclusive lock directory
 * (`<key>.lock`, removed after; a lock older than 30 s is a dead holder's), and
 * the check is repeated inside it, so racing first-use callers all return the
 * one key on disk. A 0-byte key file — what a crash between create and the write
 * used to leave behind — is replaced under that lock; any other wrong length is
 * refused and never overwritten.
 *
 * The check path (readApprovalKey / readApprovalRecord) only ever READS: a
 * missing, unreadable or refused key or record means no approval is valid, and
 * is never a reason to mint one.
 */
import { randomBytes } from "node:crypto";
import {
  closeSync, fsyncSync, linkSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync,
  renameSync, rmdirSync, unlinkSync, writeSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import { resolveCrowHome } from "./crow-home.js";
import { ensureSecretsDir } from "./peer-credentials.js";
import { anchoredPath } from "./secret-values.js";

/** Bytes in the approval key (an HMAC-SHA256 key). */
export const APPROVAL_KEY_BYTES = 32;

/** First-key creation lock: how long a caller waits, when a lock counts as a dead holder's, and the poll step. */
const KEY_LOCK_WAIT_MS = 10_000;
const KEY_LOCK_STALE_MS = 30_000;
const KEY_LOCK_POLL_MS = 10;
export const APPROVAL_KEY_FILENAME = "data-backend-approval.key";
export const APPROVAL_RECORD_FILENAME = "data-backend-approvals.json";
/** Shape version of the record file; any other value reads as "no record". */
export const APPROVAL_RECORD_VERSION = 1;

const NONCE_RE = /^[0-9a-f]{32}$/;
const ROW_ID_RE = /^[1-9][0-9]{0,17}$/;

/** `crowHome` (a string, a getter, or nothing for this instance's home). */
function homeOf(crowHome) {
  const h = typeof crowHome === "function" ? crowHome() : crowHome;
  return h || resolveCrowHome();
}

/** `<CROW_HOME>/secrets/data-backend-approval.key`. */
export function approvalKeyPath(crowHome) {
  return join(homeOf(crowHome), "secrets", APPROVAL_KEY_FILENAME);
}

/** `<CROW_HOME>/secrets/data-backend-approvals.json`. */
export function approvalRecordPath(crowHome) {
  return join(homeOf(crowHome), "secrets", APPROVAL_RECORD_FILENAME);
}

const _warned = new Set();
function warnOnce(key, line) {
  if (_warned.has(key)) return;
  _warned.add(key);
  console.warn(line);
}

/**
 * A name inside this instance's anchored secrets dir, or null when the dir
 * cannot be anchored (a read-only view such as a bot sandbox, or a dir another
 * principal could swap in): the caller then reads nothing and writes nothing.
 */
function secretPath(crowHome, name) {
  try {
    return anchoredPath({ ...process.env, CROW_HOME: homeOf(crowHome) }, name);
  } catch {
    return null;
  }
}

/** A regular file of this user with no group or other bits (peer-credentials' rule). */
function trustedFile(st) {
  return st.isFile() && st.uid === process.getuid?.() && (st.mode & 0o077) === 0;
}

/** Say so once (never the contents) when a key or record file is not ours alone. */
function refuseLooseFile(p, label) {
  warnOnce(`loose:${p}`, `[data-backend-approval] refusing the ${label} ${p}: not a regular file of this user with mode 600`);
}

/** `<dest>.<pid>.<12 hex>.tmp` — the shape removeCrashedTmps recognises. */
function tmpPathFor(dest) {
  return `${dest}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
}

/** Delete temp files a writer that died mid-write left beside `dest`. */
function removeCrashedTmps(dest) {
  const dir = dirname(dest);
  const prefix = basename(dest) + ".";
  let names = [];
  try { names = readdirSync(dir); } catch { return; }
  for (const n of names) {
    if (n.startsWith(prefix) && /^\d+\.[0-9a-f]{12}\.tmp$/.test(n.slice(prefix.length))) {
      try { unlinkSync(join(dir, n)); } catch { /* gone */ }
    }
  }
}

function fsyncDir(dir) {
  let fd;
  try { fd = openSync(dir, "r"); fsyncSync(fd); } catch { /* not supported here */ } finally {
    if (fd !== undefined) try { closeSync(fd); } catch { /* best effort */ }
  }
}

/** Write `data` (0600) through a temp file: fsync, rename, fsync the dir. */
function writeDurable(dest, data) {
  const tmp = tmpPathFor(dest);
  try {
    const fd = openSync(tmp, "wx", 0o600);
    try { writeSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
    renameSync(tmp, dest);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* never created */ }
    throw err;
  }
  fsyncDir(dirname(dest));
}

/* ------------------------------------------------------------------- the key */

/**
 * The stored key, or null when it is missing, unreadable, refused (not a
 * regular file of this user with mode 600) or not exactly APPROVAL_KEY_BYTES
 * long. Never throws, never creates.
 */
export function readApprovalKey({ crowHome } = {}) {
  const p = secretPath(crowHome, APPROVAL_KEY_FILENAME);
  if (!p) return null;
  let st;
  try { st = lstatSync(p); } catch { return null; }
  if (!trustedFile(st)) {
    refuseLooseFile(approvalKeyPath(crowHome), "approval key");
    return null;
  }
  let bytes;
  try { bytes = readFileSync(p); } catch { return null; }
  return bytes.length === APPROVAL_KEY_BYTES ? bytes : null;
}

/**
 * The stored key, made on first use. Returns the key that is on disk
 * afterwards. Throws only when it can neither create nor read one (an
 * unusable secrets dir, or an existing file that is not an empty key).
 */
export function ensureApprovalKey({ crowHome } = {}) {
  const path = approvalKeyPath(crowHome);
  const have = readApprovalKey({ crowHome });
  if (have) return have;

  ensureSecretsDir(dirname(path));
  const target = secretPath(crowHome, APPROVAL_KEY_FILENAME);
  if (!target) throw new Error(`the secrets directory for ${path} cannot be used`);

  // First use is serialised across processes with an exclusive lock directory:
  // the check, the removal of an empty crash leftover and the publish all happen
  // with the lock held, so two first-use callers can never each publish (or
  // unlink) a key the other already returned.
  const release = acquireKeyLock(`${target}.lock`, path);
  try {
    const raced = readApprovalKey({ crowHome });
    if (raced) return raced;
    return createKeyLocked(target, path);
  } finally {
    release();
  }
}

/** Sleep without an event loop (ensureApprovalKey is synchronous). */
function sleepSync(ms) {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/** mkdir is atomic: whoever creates the directory holds the lock. */
function acquireKeyLock(lockDir, shownPath) {
  const deadline = Date.now() + KEY_LOCK_WAIT_MS;
  for (;;) {
    try {
      mkdirSync(lockDir, { mode: 0o700 });
      return () => { try { rmdirSync(lockDir); } catch { /* already gone */ } };
    } catch (err) {
      if (err?.code !== "EEXIST") throw new Error(`the approval key file ${shownPath} could not be locked (${err?.code || "error"})`);
    }
    // A holder that died leaves its lock behind: one older than the stale age is
    // removed (no live holder keeps it that long), then the next try takes it.
    try {
      const st = lstatSync(lockDir);
      if (Date.now() - st.mtimeMs > KEY_LOCK_STALE_MS) { try { rmdirSync(lockDir); } catch { /* raced */ } continue; }
    } catch { continue; /* released between the tries */ }
    if (Date.now() > deadline) throw new Error(`the approval key file ${shownPath} is locked by another process`);
    sleepSync(KEY_LOCK_POLL_MS);
  }
}

/** With the key lock held: replace an empty leftover, then publish a new key. */
function createKeyLocked(target, path) {
  removeCrashedTmps(target);

  // An existing file is replaced ONLY when it is EMPTY: 0 bytes is what a crash
  // between create and write used to leave behind, and it reads as no key. Any
  // other wrong length is refused — a non-empty key is never overwritten.
  let st = null;
  try { st = lstatSync(target); } catch { /* missing: create it */ }
  if (st) {
    if (!trustedFile(st)) {
      throw new Error(`the approval key file ${path} is not a regular file of this user with mode 600; refusing to use or replace it`);
    }
    if (st.size !== 0) throw new Error(`the approval key file ${path} exists but does not hold a key`);
    try { unlinkSync(target); } catch { /* gone */ }
  }

  const key = randomBytes(APPROVAL_KEY_BYTES);
  const tmp = tmpPathFor(target);
  try {
    const fd = openSync(tmp, "wx", 0o600);
    try { writeSync(fd, key, 0, key.length, 0); fsyncSync(fd); } finally { closeSync(fd); }
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* never created */ }
    throw new Error(`the approval key file ${path} could not be written (${err?.code || "error"})`);
  }
  try {
    // Atomic and exclusive: the whole key is on disk before the name exists. With
    // the lock held nothing else publishes here; EEXIST would mean a writer that
    // does not take the lock, and then its key is the one used.
    linkSync(tmp, target);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* gone */ }
    if (err?.code !== "EEXIST") throw new Error(`the approval key file ${path} could not be created (${err?.code || "error"})`);
    const bytes = (() => { try { return readFileSync(target); } catch { return null; } })();
    if (bytes && bytes.length === APPROVAL_KEY_BYTES) return bytes;
    throw new Error(`the approval key file ${path} exists but does not hold a key`);
  }
  try { unlinkSync(tmp); } catch { /* gone */ }
  fsyncDir(dirname(target));
  return key;
}

/* ------------------------------------------------------- the per-row record */

/** A record with no nonces: the only thing a missing or untrusted file can mean. */
function emptyRecord() {
  return { v: APPROVAL_RECORD_VERSION, rows: {} };
}

/**
 * The per-row approval nonces. Missing, unreadable, refused, unparseable or
 * wrongly shaped reads as an empty record (no nonce, so no approval verifies):
 * a check never throws and never creates the file.
 */
export function readApprovalRecord({ crowHome } = {}) {
  const path = approvalRecordPath(crowHome);
  const p = secretPath(crowHome, APPROVAL_RECORD_FILENAME);
  if (!p) return emptyRecord();
  let st;
  try { st = lstatSync(p); } catch { return emptyRecord(); }   // no record yet: no nonce
  if (!trustedFile(st)) {
    refuseLooseFile(path, "approval record");
    return emptyRecord();
  }
  let obj;
  try {
    obj = JSON.parse(readFileSync(p, "utf8"));
  } catch {
    warnOnce(`record-bad:${path}`, `[data-backend-approval] ${path} cannot be read as JSON; approve the backends again`);
    return emptyRecord();
  }
  if (!obj || typeof obj !== "object" || Array.isArray(obj) || Number(obj.v) !== APPROVAL_RECORD_VERSION
      || !obj.rows || typeof obj.rows !== "object" || Array.isArray(obj.rows)) {
    warnOnce(`record-shape:${path}`, `[data-backend-approval] ${path} is not an approval record (version ${APPROVAL_RECORD_VERSION}); approve the backends again`);
    return emptyRecord();
  }
  const rows = {};
  for (const [id, nonce] of Object.entries(obj.rows)) {
    if (ROW_ID_RE.test(id) && typeof nonce === "string" && NONCE_RE.test(nonce)) rows[id] = nonce;
  }
  return { v: APPROVAL_RECORD_VERSION, rows };
}

/** The nonce recorded for one row id, or null when there is none. */
export function approvalNonce(rowId, { crowHome } = {}) {
  const id = rowId === undefined || rowId === null ? "" : String(rowId);
  if (!ROW_ID_RE.test(id)) return null;
  return readApprovalRecord({ crowHome }).rows[id] ?? null;
}

/** A fresh nonce for one approval (16 random bytes, 32 hex characters). */
export function newApprovalNonce() {
  return randomBytes(16).toString("hex");
}

// The record is read-modify-written under a module-level promise chain:
// approvals are rare and owner-driven (one dashboard POST at a time), so an
// in-process chain is enough to keep two of them from losing each other's
// nonce. A second gateway process on the same home is not serialized; the last
// write wins, and the row whose nonce was lost needs approving again (the safe
// direction: a missing nonce approves nothing).
let _chain = Promise.resolve();
function serialized(fn) {
  const run = _chain.then(fn);
  _chain = run.then(() => {}, () => {});
  return run;
}

function writeApprovalRecord(rec, { crowHome }) {
  const path = approvalRecordPath(crowHome);
  ensureSecretsDir(dirname(path));
  const p = secretPath(crowHome, APPROVAL_RECORD_FILENAME);
  if (!p) throw new Error(`the secrets directory for ${path} cannot be used`);
  removeCrashedTmps(p);
  // A record that existed but was refused (another principal could rewrite it)
  // is replaced by this write: its nonces were not trusted, so every other
  // backend then needs approving again — the direction that cannot approve
  // anything it should not.
  writeDurable(p, JSON.stringify({ v: APPROVAL_RECORD_VERSION, rows: rec.rows }));
}

/**
 * Record a nonce for a row id (replacing any earlier one: the value that
 * carried it stops verifying). Throws when the record cannot be written.
 */
export function setApprovalNonce(rowId, nonce, { crowHome } = {}) {
  const id = String(rowId);
  if (!ROW_ID_RE.test(id)) return Promise.reject(new Error("not a backend row id"));
  if (typeof nonce !== "string" || !NONCE_RE.test(nonce)) return Promise.reject(new Error("not an approval nonce"));
  return serialized(() => {
    const rec = readApprovalRecord({ crowHome });
    rec.rows[id] = nonce;
    writeApprovalRecord(rec, { crowHome });
  });
}

/** Drop a row id's nonce (a revoke: whatever value the row still holds stops verifying). */
export function clearApprovalNonce(rowId, { crowHome } = {}) {
  const id = rowId === undefined || rowId === null ? "" : String(rowId);
  if (!ROW_ID_RE.test(id)) return Promise.resolve();
  return serialized(() => {
    const rec = readApprovalRecord({ crowHome });
    if (!Object.hasOwn(rec.rows, id)) return;
    delete rec.rows[id];
    writeApprovalRecord(rec, { crowHome });
  });
}

/**
 * Drop every nonce whose row id is NOT in `keepIds` — the record entries of
 * rows that are no longer in the table (a deleted backend). An entry left
 * behind is what lets a deleted row be put back with its old id, its old
 * connection_ref and its old `hmac1:` value and verify again, so this is the
 * backstop for a delete path that could not clear its own entry.
 *
 * One read and at most one write (nothing is written when nothing is stale).
 * Throws when the record cannot be written; the caller treats that as
 * "nothing pruned" rather than failing its own work.
 * @returns {Promise<number>} how many entries were dropped
 */
export function pruneApprovalNonces(keepIds, { crowHome } = {}) {
  const keep = new Set([...(keepIds || [])].map((v) => String(v)));
  return serialized(() => {
    const rec = readApprovalRecord({ crowHome });
    const stale = Object.keys(rec.rows).filter((id) => !keep.has(id));
    if (!stale.length) return 0;
    for (const id of stale) delete rec.rows[id];
    writeApprovalRecord(rec, { crowHome });
    return stale.length;
  });
}