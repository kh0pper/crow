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

import { existsSync, readFileSync, writeFileSync, mkdirSync, statSync, chmodSync, renameSync } from "fs";
import { resolve, dirname } from "path";
import { homedir } from "os";
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
    || resolve(process.env.CROW_HOME || resolve(homedir(), ".crow"), "peer-tokens.json");
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

/**
 * Atomically save peer-tokens.json with mode 0600.
 */
export function savePeerCreds(creds) {
  ensureDir();
  const dest = peerTokensFile();
  const tmp = dest + ".tmp";
  writeFileSync(tmp, JSON.stringify(creds, null, 2), { mode: 0o600 });
  // renameSync is atomic on POSIX for same-filesystem rename
  renameSync(tmp, dest);
  // Belt & suspenders — re-apply mode in case renameSync preserved different perms
  chmodSync(dest, 0o600);
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
  const all = loadPeerCreds();
  const existing = all[instanceId] || {};
  const now = new Date().toISOString();
  const next = {
    ...existing,
    ...patch,
    created_at: existing.created_at || now,
    rotated_at: existing.created_at ? now : null,
  };
  all[instanceId] = next;
  savePeerCreds(all);
  return next;
}

/**
 * Remove credentials for a peer.
 */
export function deletePeerCreds(instanceId) {
  const all = loadPeerCreds();
  if (!(instanceId in all)) return false;
  delete all[instanceId];
  savePeerCreds(all);
  return true;
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
