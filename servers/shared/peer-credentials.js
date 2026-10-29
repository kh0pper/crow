/**
 * Peer credentials store for cross-host gateway-to-gateway RPC.
 *
 * Each entry in <instance home>/secrets/peer-tokens.json (CROW_HOME, default
 * ~/.crow — see peerTokensFile below) binds an instance ID to the
 * plaintext credentials this node needs to make outbound calls to that
 * peer AND to verify inbound calls from it. Because both sides use the
 * same file shape, pairing is symmetric: a single ceremony provisions
 * both directions.
 *
 * File format (mode 0600):
 *   {
 *     "<instance-id>": {
 *       "auth_token":    "<64 hex chars>",   // Bearer token (this node -> peer)
 *       "signing_key":   "<64 hex chars>",   // HMAC key (shared, both directions)
 *       "inbound_token": "<64 hex chars>",   // Bearer token peer uses TO us (optional
 *                                            //   — inbound validation goes through the
 *                                            //   existing instanceAuthMiddleware which
 *                                            //   hashes against crow_instances.auth_token_hash)
 *       "created_at":    "ISO-8601",
 *       "rotated_at":    "ISO-8601 | null"
 *     }
 *   }
 *
 * Security notes:
 *   - File is verified 0600 at load time; loudly warns and refuses to use
 *     credentials if permissions are looser.
 *   - auth_token and signing_key are independent. Reusing one for the other
 *     is an explicit non-goal.
 *   - Rotation: callers can rewrite the entry; `rotated_at` is metadata only.
 */

import {
  existsSync, readFileSync, writeFileSync, mkdirSync, statSync, chmodSync, renameSync,
  openSync, writeSync, closeSync, unlinkSync, fsyncSync, readdirSync, lstatSync, realpathSync,
} from "fs";
import { resolve, dirname, basename, join } from "path";
import { resolveCrowHome } from "./crow-home.js";
import { randomBytes } from "crypto";

// peer-tokens.json is an INSTANCE-scoped resource: it must honor CROW_HOME
// like every other instance-home path (see servers/gateway/bundles-config.js).
// A process running with CROW_HOME=<instance> (e.g. the MPA gateway under
// ~/.crow-mpa) must never silently read — or sign with — another instance's
// credentials; that hardcoded-homedir fallback is exactly what produced the
// missing_peer_credentials / hmac_mismatch misdiagnosis of 2026-07-12.
// Resolution order: CROW_PEER_TOKENS_PATH > CROW_HOME > homedir()/.crow.
// Resolved at CALL time, not module load: ESM hoists static imports, so this
// module is evaluated BEFORE the gateway's in-body .env loader runs — a
// module-load constant would silently ignore a CROW_HOME set only in .env,
// recreating the very wrong-instance failure this resolution exists to stop.
//
// The default lives in <CROW_HOME>/secrets (700), the dir the pi sandbox
// hides from bots behind a tmpfs: a same-uid bot with a shell must not be able
// to open every pair's bearer and signing key by path. Older versions kept it
// at <CROW_HOME>/peer-tokens.json; that file is moved here once (at gateway
// boot, or by the first reader or writer that finds it), and one re-created
// there later is set aside, never merged (see reconcileLegacyLocked).
function peerTokensFile() {
  return activeOverride() || resolve(resolveCrowHome(), "secrets", "peer-tokens.json");
}

/** The pre-secrets/ location, or null when an override names the store. */
function legacyPeerTokensFile() {
  if (activeOverride()) return null;
  return resolve(resolveCrowHome(), "peer-tokens.json");
}

/** A path with its existing ancestors' symlinks resolved (the file itself may not exist). */
function realish(p) {
  const abs = resolve(p);
  try { return realpathSync(abs); } catch { /* not there yet */ }
  try { return join(realpathSync(dirname(abs)), basename(abs)); } catch { return abs; }
}

/**
 * CROW_PEER_TOKENS_PATH, when it names a store of its own. An override that
 * resolves to the OLD default (<CROW_HOME>/peer-tokens.json, as units written
 * before the move carry) is outdated: it is treated as the old location and
 * moved into secrets/ like any other, so such a unit does not stay exposed.
 * An override anywhere else outside <CROW_HOME>/secrets is honoured, with a
 * warning (once per process, so at every boot) that bot shells can read it.
 */
function activeOverride() {
  const o = process.env.CROW_PEER_TOKENS_PATH;
  if (!o) return null;
  const home = resolveCrowHome();
  const ro = realish(o);
  if (ro === realish(resolve(home, "peer-tokens.json"))) {
    warnOnce(`override-legacy:${o}`, `[peer-credentials] CROW_PEER_TOKENS_PATH=${o} names the old default location; it is outdated and ignored: ` +
      `the store is moved to and used at ${resolve(home, "secrets", "peer-tokens.json")}. Remove the override from the unit.`);
    return null;
  }
  const secretsReal = realish(resolve(home, "secrets"));
  if (!ro.startsWith(secretsReal + "/")) {
    warnOnce(`override-exposed:${o}`, `[peer-credentials] WARNING: CROW_PEER_TOKENS_PATH=${o} is outside ${secretsReal}; ` +
      `the pi sandbox does not hide it, so a bot shell running as this user can read every peer key in it. Move it under ${secretsReal} or drop the override.`);
  }
  return o;
}

function ensureDir() {
  // Anchor on the resolved tokens path: with CROW_PEER_TOKENS_PATH set to an
  // arbitrary location, we must create THAT file's parent, not ~/.crow.
  const dir = dirname(peerTokensFile());
  if (activeOverride()) {
    try { mkdirSync(dir, { recursive: true }); } catch {}
    return;
  }
  ensureSecretsDir(dir);
}

/** Create <CROW_HOME>/secrets 700 (or tighten an existing one we own). */
export function ensureSecretsDir(dir) {
  try { mkdirSync(dir, { recursive: true, mode: 0o700 }); } catch {}
  try {
    const st = statSync(dir);
    if (st.uid === process.getuid?.() && (st.mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
  } catch { /* best effort; a read-only view (inside the pi sandbox) is fine */ }
}

/**
 * Verify the file is mode 0600 (owner rw only). Returns true if OK or the
 * file does not exist; false (+ warning) if loose permissions detected.
 */
function checkPermissions(path) {
  try {
    if (!existsSync(path)) return true;
    const s = statSync(path);
    // Allow 0600 only. Mask for world/group bits.
    const mode = s.mode & 0o777;
    if (mode !== 0o600) {
      console.warn(
        `[peer-credentials] WARNING: ${path} has mode ${mode.toString(8)}; expected 600. ` +
        `Refusing to load. Fix with: chmod 600 ${path}`
      );
      return false;
    }
    return true;
  } catch (err) {
    console.warn(`[peer-credentials] Cannot stat ${path}: ${err.message}`);
    return false;
  }
}

/**
 * Load the peer-tokens.json file. Returns an empty object if missing or
 * if permissions check fails. A store still (or again) at the pre-secrets/
 * path is first moved (or set aside) under the lock; if that cannot run (a
 * read-only view) and only the old file exists, it is read where it is.
 */
export function loadPeerCreds() {
  let p = peerTokensFile();
  const legacy = legacyPeerTokensFile();
  if (legacy && existsSync(legacy)) {
    try { reconcileLegacyIfDue(); } catch (err) { warnOnce(`reconcile:${legacy}`, `[peer-credentials] could not move ${legacy} into ${p}: ${err.message}`); }
    // Only before this host's first move (the old layout still in force).
    if (!existsSync(p) && !existsSync(p + MIGRATED_SUFFIX) && existsSync(legacy)) p = legacy;
  }
  if (!checkPermissions(p)) return {};
  try {
    if (!existsSync(p)) return {};
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch (err) {
    console.warn(`[peer-credentials] Failed to parse ${p}: ${err.message}`);
    return {};
  }
}

const _warned = new Set();
function warnOnce(key, msg) {
  if (_warned.has(key)) return;
  _warned.add(key);
  console.warn(msg);
}

// ---------------------------------------------------------------------------
// Writes: one lock for every writer (PT-1).
//
// Every writer (the gateway's trust sweeper and boot reconcile, the enroll
// route and its rollback, the pair CLI, stdio revokes) used to do an
// unlocked read-modify-write through one shared "<file>.tmp", so two
// processes could lose each other's updates and drop a live peer's key.
// Now each write takes an exclusive lockfile, re-reads the file INSIDE the
// lock, applies its change, and renames a per-writer tmp file into place.
// ---------------------------------------------------------------------------

const LOCK_WAIT_MS = 5_000;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_LOG_MS = 100;
const _sleepCell = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms) { Atomics.wait(_sleepCell, 0, 0, ms); }

function pidAlive(pid) {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try { process.kill(pid, 0); return true; } catch (err) { return err.code === "EPERM"; }
}

// This boot's id: a lock written by a pid from an EARLIER boot is stale even
// if that pid number is alive again now (pid reuse after a reboot/OOM).
let _bootId;
function bootId() {
  if (_bootId === undefined) {
    try { _bootId = readFileSync("/proc/sys/kernel/random/boot_id", "utf-8").trim() || null; } catch { _bootId = null; }
  }
  return _bootId;
}

function readLock(lockPath) {
  try { return JSON.parse(readFileSync(lockPath, "utf-8")); } catch { return null; }
}

function lockAgeMs(lockPath, holder) {
  const ts = Number(holder?.ts);
  if (Number.isFinite(ts)) return Date.now() - ts;
  try { return Date.now() - statSync(lockPath).mtimeMs; } catch { return 0; }
}

/** A lock older than LOCK_STALE_MS whose holder is gone: dead pid, another boot, or unreadable content. */
function isStale(lockPath, holder) {
  if (lockAgeMs(lockPath, holder) <= LOCK_STALE_MS) return false;
  if (!holder || typeof holder !== "object") return true; // empty or torn write
  if (holder.boot && bootId() && holder.boot !== bootId()) return true;
  return !pidAlive(Number(holder.pid));
}

function acquireStoreLock(lockPath, waitMs = LOCK_WAIT_MS) {
  const started = Date.now();
  const me = { pid: process.pid, ts: Date.now(), boot: bootId(), nonce: randomBytes(6).toString("hex") };
  let holder = null;
  for (;;) {
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      try { writeSync(fd, JSON.stringify(me)); } finally { closeSync(fd); }
      const waited = Date.now() - started;
      if (waited > LOCK_WAIT_LOG_MS) {
        console.warn(`[peer-credentials] store lock waited ${waited} ms (holder pid ${holder?.pid ?? "?"})`);
      }
      return me;
    } catch (err) {
      if (err.code !== "EEXIST") throw err;
    }
    holder = readLock(lockPath);
    if (isStale(lockPath, holder)) {
      console.warn(`[peer-credentials] breaking a stale store lock (holder pid ${holder?.pid ?? "?"}, ${lockAgeMs(lockPath, holder)} ms old)`);
      // Break by renaming to a unique name, then check it was the lock we
      // judged: a racing breaker may already have replaced it with a live one.
      const aside = `${lockPath}.${process.pid}.${randomBytes(4).toString("hex")}.stale`;
      try {
        renameSync(lockPath, aside);
        const moved = readLock(aside);
        const same = (moved === null && holder === null) || (moved && holder && moved.nonce === holder.nonce && moved.pid === holder.pid);
        if (!same && !isStale(aside, moved)) {
          // We moved a live holder's lock: put it back if the slot is still free.
          try { const fd = openSync(lockPath, "wx", 0o600); try { writeSync(fd, JSON.stringify(moved)); } finally { closeSync(fd); } } catch { /* taken */ }
        }
        try { unlinkSync(aside); } catch { /* gone */ }
      } catch { /* someone else broke it */ }
      continue;
    }
    if (Date.now() - started > waitMs) {
      throw new Error(`[peer-credentials] could not lock ${lockPath} within ${waitMs} ms (holder pid ${holder?.pid ?? "?"})`);
    }
    sleepSync(2 + Math.floor(Math.random() * 5));
  }
}

function releaseStoreLock(lockPath, me) {
  const cur = readLock(lockPath);
  if (cur && cur.nonce === me.nonce && cur.pid === me.pid) {
    try { unlinkSync(lockPath); } catch { /* already gone */ }
  }
}

/** Strict read for writers: a store we cannot read safely is never overwritten. */
function readForWrite(p) {
  if (!existsSync(p)) return {};
  const mode = statSync(p).mode & 0o777;
  if (mode !== 0o600) {
    throw new Error(`[peer-credentials] ${p} has mode ${mode.toString(8)}; expected 600. Refusing to write. Fix with: chmod 600 ${p}`);
  }
  const raw = readFileSync(p, "utf-8");
  return raw.trim() ? JSON.parse(raw) : {};
}

// Test seam: called at named points of a durable write (crash tests).
let _fault = null;
export function _setPeerCredsFaultForTest(fn) { _fault = typeof fn === "function" ? fn : null; }

function fsyncDir(dir) {
  let fd;
  try { fd = openSync(dir, "r"); fsyncSync(fd); } catch { /* not supported here */ } finally { if (fd !== undefined) try { closeSync(fd); } catch {} }
}

/** Write `data` to `dest` (600) through a per-writer tmp file: fsync, rename, fsync the dir. */
function writeDurable(dest, data) {
  const tmp = `${dest}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    const fd = openSync(tmp, "wx", 0o600);
    try { writeSync(fd, data); fsyncSync(fd); } finally { closeSync(fd); }
    _fault?.("tmp-written");
    // renameSync is atomic on POSIX for same-filesystem rename
    renameSync(tmp, dest);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* never created */ }
    throw err;
  }
  // Belt & suspenders — re-apply mode in case renameSync preserved different perms
  chmodSync(dest, 0o600);
  fsyncDir(dirname(dest));
  _fault?.("renamed");
}

function writeStore(dest, creds) {
  writeDurable(dest, JSON.stringify(creds, null, 2));
}

/** Under the store lock, any `<store>.<pid>.<hex>.tmp` belongs to a writer that died mid-write. */
function removeCrashedTmps(dest) {
  const prefix = basename(dest) + ".";
  let names = [];
  try { names = readdirSync(dirname(dest)); } catch { return; }
  for (const n of names) {
    if (n.startsWith(prefix) && /^\d+\.[0-9a-f]{12}\.tmp$/.test(n.slice(prefix.length))) {
      try { unlinkSync(join(dirname(dest), n)); } catch { /* gone */ }
    }
  }
}

/** Copy `from` to `to` durably, verify the bytes, then remove `from`. */
function moveVerified(from, to, bytes = readFileSync(from)) {
  writeDurable(to, bytes);
  if (!readFileSync(to).equals(bytes)) throw new Error(`[peer-credentials] copy of ${from} to ${to} did not verify; old file kept`);
  unlinkSync(from);
  fsyncDir(dirname(from));
}

/** The PT-1 one-time snapshot and its marker move along with the store. */
function movePt1Files(legacy, dest) {
  const prefix = basename(legacy) + ".pre-pt1.";
  let names = [];
  try { names = readdirSync(dirname(legacy)); } catch { return; }
  for (const n of names) {
    if (!n.startsWith(prefix)) continue;
    const from = join(dirname(legacy), n);
    const to = `${dest}.pre-pt1.${n.slice(prefix.length)}`;
    try {
      const bytes = readFileSync(from);
      if (existsSync(to)) {
        if (readFileSync(to).equals(bytes) || n === basename(legacy) + ".pre-pt1.done") { unlinkSync(from); continue; }
        console.warn(`[peer-credentials] ${from} and ${to} both exist and differ; both kept (shred the old one once verified)`);
        continue;
      }
      moveVerified(from, to, bytes);
    } catch (err) {
      console.warn(`[peer-credentials] could not move ${from}: ${err.message}`);
    }
  }
}

/**
 * Move a single-writer secret file (the peer-relay token) from its old path
 * into the secrets dir: copy (600, fsync), verify, remove the old one. When
 * both exist the new one wins; the old one is removed only when identical.
 */
export function migrateLegacySecretFile(from, to) {
  if (!existsSync(from)) return { action: "none" };
  ensureSecretsDir(dirname(to));
  removeCrashedTmps(to);
  const bytes = readFileSync(from);
  if (!existsSync(to)) {
    moveVerified(from, to, bytes);
    console.log(`[secrets] moved ${from} -> ${to} (mode 600, hidden from bot sandboxes)`);
    return { action: "moved" };
  }
  if (readFileSync(to).equals(bytes)) {
    unlinkSync(from);
    return { action: "removed-identical" };
  }
  console.error(`[secrets] WARNING: both ${from} and ${to} exist and differ; using ${to} and keeping both. Shred ${from} once checked.`);
  return { action: "kept-both" };
}

const MIGRATED_SUFFIX = ".migrated";

/**
 * Once this host is on the secrets/ layout (the marker beside the store), a
 * file at the old path is never adopted: a bot shell inside the sandbox can
 * still WRITE there, so merging it would let a bot plant a peer key in the
 * store it cannot read. It is an older process's write (or a plant): saved
 * aside in the hidden dir for the operator, removed from the old path, and
 * logged with the peer ids it names (never a key).
 */
function setAsideLegacy(legacy, dest, bytes) {
  const aside = `${dest}.legacy-${Date.now()}`;
  writeDurable(aside, bytes);
  unlinkSync(legacy);
  let ids = "?";
  try { const o = JSON.parse(bytes.toString("utf-8") || "{}"); ids = Object.keys(o || {}).join(", ") || "none"; } catch { ids = "unparseable"; }
  console.error(`[peer-credentials] WARNING: ${legacy} was re-created after the store moved to ${dest} (an older Crow process, or a bot). ` +
    `It was NOT merged; saved at ${aside} (mode 600, peers: ${ids}). Restart any older Crow process; re-pair a peer it paired, or merge by hand, then shred ${aside}.`);
  return { action: "set-aside", aside };
}

function writeMarker(dest) {
  const marker = dest + MIGRATED_SUFFIX;
  if (!existsSync(marker)) writeFileSync(marker, `${new Date().toISOString()}\n`, { mode: 0o600 });
}

/**
 * With the store lock held: move a store at the pre-secrets/ path, or set
 * aside one re-created there later. Takes that path's own lock too, so an
 * older writer's read-modify-write there finishes first (older code only
 * knows that lock; new code always takes the store lock first, so the two
 * never deadlock).
 */
function reconcileLegacyLocked(dest, waitMs = LOCK_WAIT_MS) {
  const legacy = legacyPeerTokensFile();
  if (!legacy) return { action: "none" };
  if (!existsSync(legacy)) {
    // First contact on the new layout: from now on the old path is untrusted.
    if (existsSync(dirname(dest))) { try { writeMarker(dest); } catch { /* read-only view */ } }
    return { action: "none" };
  }
  const legacyLock = `${legacy}.lock`;
  const lme = acquireStoreLock(legacyLock, waitMs);
  try {
    if (!existsSync(legacy)) return { action: "none" };
    removeCrashedTmps(dest);
    const st = lstatSync(legacy);
    if (!st.isFile() || st.uid !== process.getuid?.()) {
      warnOnce(`nonfile:${legacy}`, `[peer-credentials] WARNING: ${legacy} is not a regular file of this user; not moved or read. Remove it by hand.`);
      return { action: "kept-both" };
    }
    const migrated = existsSync(dest + MIGRATED_SUFFIX);
    const oldBytes = readFileSync(legacy);
    if (!existsSync(dest)) {
      if (migrated) return setAsideLegacy(legacy, dest, oldBytes);
      writeDurable(dest, oldBytes);
      if (!readFileSync(dest).equals(oldBytes)) throw new Error(`[peer-credentials] copy of ${legacy} to ${dest} did not verify; old file kept`);
      writeMarker(dest);
      unlinkSync(legacy);
      fsyncDir(dirname(legacy));
      movePt1Files(legacy, dest);
      console.log(`[peer-credentials] moved the peer credential store ${legacy} -> ${dest} (mode 600, hidden from bot sandboxes)`);
      return { action: "moved" };
    }
    if (readFileSync(dest).equals(oldBytes)) {
      writeMarker(dest);
      unlinkSync(legacy);
      movePt1Files(legacy, dest);
      console.log(`[peer-credentials] removed ${legacy}: identical to ${dest}`);
      return { action: "removed-identical" };
    }
    if (migrated) return setAsideLegacy(legacy, dest, oldBytes);
    console.error(`[peer-credentials] WARNING: both ${legacy} and ${dest} exist and differ; using ${dest} and keeping both. ` +
      `Compare them, merge any peer you still need into ${dest}, then shred ${legacy}.`);
    return { action: "kept-both" };
  } finally {
    releaseStoreLock(legacyLock, lme);
  }
}

/** Take the store lock and reconcile the old path. */
function reconcileLegacy(waitMs = LOCK_WAIT_MS) {
  ensureDir();
  const dest = peerTokensFile();
  const lockPath = `${dest}.lock`;
  const me = acquireStoreLock(lockPath, waitMs);
  try { return reconcileLegacyLocked(dest, waitMs); } finally { releaseStoreLock(lockPath, me); }
}

// Readers (a hot path) wait briefly for the locks, and a state they could not
// settle (kept both, a busy or planted lock) is retried at most once a minute.
const READER_LOCK_WAIT_MS = 250;
const READER_RETRY_MS = 60_000;
const _unsettledAt = new Map();
function reconcileLegacyIfDue() {
  const legacy = legacyPeerTokensFile();
  const at = _unsettledAt.get(legacy);
  if (at !== undefined && Date.now() - at < READER_RETRY_MS) return { action: "kept-both" };
  let r;
  try { r = reconcileLegacy(READER_LOCK_WAIT_MS); } catch (err) { _unsettledAt.set(legacy, Date.now()); throw err; }
  if (r.action === "kept-both") _unsettledAt.set(legacy, Date.now()); else _unsettledAt.delete(legacy);
  return r;
}

/**
 * The one-time boot migration (the gateway runs it before the PT-1 sweeper).
 * Idempotent; also run lazily by every reader and writer that finds a store
 * at the old path. Returns { action: "none" | "moved" | "removed-identical"
 * | "kept-both" | "set-aside" }.
 */
export function migratePeerCredsStore() {
  if (!legacyPeerTokensFile()) return { action: "none" };
  return reconcileLegacy();
}

/**
 * Run `mutator(all)` on the store under the store lock. `all` is the file as
 * read INSIDE the lock; the mutator changes it in place and returns
 * `{ write: false }` to skip the write, or any other value (returned to the
 * caller). Synchronous: callers stay synchronous.
 */
export function updatePeerCreds(mutator) {
  ensureDir();
  const dest = peerTokensFile();
  const lockPath = `${dest}.lock`;
  const me = acquireStoreLock(lockPath);
  try {
    // A store still at the old path is moved first (or one re-created there
    // set aside), so this write can never strand it. After the move a failure
    // there (e.g. a lock a bot planted beside the old path) never blocks a
    // write: the old path holds nothing the store needs.
    try { reconcileLegacyLocked(dest); } catch (err) {
      if (!existsSync(dest + MIGRATED_SUFFIX)) throw err;
      warnOnce(`reconcile-w:${dest}`, `[peer-credentials] could not clear the old store path: ${err.message}`);
    }
    const all = readForWrite(dest);
    const out = mutator(all);
    if (!(out && out.write === false)) writeStore(dest, all);
    return out;
  } finally {
    releaseStoreLock(lockPath, me);
  }
}

/**
 * Get credentials for a specific peer. Returns null if not paired.
 */
export function getPeerCreds(instanceId) {
  const all = loadPeerCreds();
  return all[instanceId] || null;
}

/**
 * Upsert credentials for a peer. Preserves any existing fields not in
 * `patch`. Sets created_at on first write, rotated_at on subsequent writes.
 */
export function setPeerCreds(instanceId, patch) {
  return updatePeerCreds((all) => {
    const existing = all[instanceId] || {};
    const now = new Date().toISOString();
    const next = {
      ...existing,
      ...patch,
      created_at: existing.created_at || now,
      rotated_at: existing.created_at ? now : null,
    };
    all[instanceId] = next;
    return next;
  });
}

/**
 * Remove credentials for a peer. Returns true when an entry was removed.
 */
export function deletePeerCreds(instanceId) {
  return updatePeerCreds((all) => {
    if (!Object.prototype.hasOwnProperty.call(all, instanceId)) return { write: false, deleted: false };
    delete all[instanceId];
    return { deleted: true };
  }).deleted;
}

/**
 * The mint time of a store entry, epoch ms: rotated_at || created_at. An
 * entry with neither (hand-written legacy) counts as minted before any revoke.
 */
export function entryMintMs(entry) {
  const t = Date.parse(entry?.rotated_at || entry?.created_at || "");
  return Number.isFinite(t) ? t : -Infinity;
}

/**
 * Generate a new 32-byte hex token or signing key.
 */
export function generateSecret() {
  return randomBytes(32).toString("hex");
}

/**
 * Resolve the path for operators to reference (e.g. "chmod 600" hints).
 */
export function peerTokensPath() {
  return peerTokensFile();
}
