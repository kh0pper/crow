/**
 * Peer credentials store for cross-host gateway-to-gateway RPC.
 *
 * Each entry in <instance home>/peer-tokens.json (CROW_HOME, default
 * ~/.crow — see PEER_TOKENS_PATH below) binds an instance ID to the
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
  openSync, writeSync, closeSync, unlinkSync,
} from "fs";
import { resolve, dirname } from "path";
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
function peerTokensFile() {
  return process.env.CROW_PEER_TOKENS_PATH
    || resolve(resolveCrowHome(), "peer-tokens.json");
}

function ensureDir() {
  // Anchor on the resolved tokens path: with CROW_PEER_TOKENS_PATH set to an
  // arbitrary location, we must create THAT file's parent, not ~/.crow.
  const dir = dirname(peerTokensFile());
  try {
    mkdirSync(dir, { recursive: true });
  } catch {}
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
 * if permissions check fails.
 */
export function loadPeerCreds() {
  const p = peerTokensFile();
  if (!checkPermissions(p)) return {};
  try {
    if (!existsSync(p)) return {};
    return JSON.parse(readFileSync(p, "utf-8"));
  } catch (err) {
    console.warn(`[peer-credentials] Failed to parse ${p}: ${err.message}`);
    return {};
  }
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

function readLock(lockPath) {
  try { return JSON.parse(readFileSync(lockPath, "utf-8")); } catch { return null; }
}

function acquireStoreLock(lockPath) {
  const started = Date.now();
  const me = { pid: process.pid, ts: Date.now(), nonce: randomBytes(6).toString("hex") };
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
    if (holder && Date.now() - Number(holder.ts) > LOCK_STALE_MS && !pidAlive(Number(holder.pid))) {
      console.warn(`[peer-credentials] breaking a stale store lock (pid ${holder.pid} is gone, held ${Date.now() - Number(holder.ts)} ms)`);
      // Only unlink the lock we judged stale (a racing breaker may have replaced it).
      const again = readLock(lockPath);
      if (again && again.nonce === holder.nonce && again.pid === holder.pid) {
        try { unlinkSync(lockPath); } catch { /* someone else broke it */ }
      }
      continue;
    }
    if (Date.now() - started > LOCK_WAIT_MS) {
      throw new Error(`[peer-credentials] could not lock ${lockPath} within ${LOCK_WAIT_MS} ms (holder pid ${holder?.pid ?? "?"})`);
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

function writeStore(dest, creds) {
  const tmp = `${dest}.${process.pid}.${randomBytes(6).toString("hex")}.tmp`;
  try {
    writeFileSync(tmp, JSON.stringify(creds, null, 2), { mode: 0o600 });
    // renameSync is atomic on POSIX for same-filesystem rename
    renameSync(tmp, dest);
  } catch (err) {
    try { unlinkSync(tmp); } catch { /* never created */ }
    throw err;
  }
  // Belt & suspenders — re-apply mode in case renameSync preserved different perms
  chmodSync(dest, 0o600);
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
