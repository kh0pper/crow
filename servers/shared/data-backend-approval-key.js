/**
 * The key that makes a data-backend approval unforgeable by a crow.db writer.
 *
 * An `mcp_server` data backend is a command the gateway runs. The owner's
 * approval is stored in the same `data_backends` row it approves, so a value
 * that could be recomputed from the row alone (a plain SHA-256 of the command)
 * proves nothing: anything that can write crow.db can plant an "approved"
 * row. The stored value is therefore an HMAC keyed by 32 random bytes kept in
 * `<CROW_HOME>/secrets/data-backend-approval.key` (dir 0700, file 0600) — the
 * directory bots cannot see and backups never carry (the peer-token store's
 * rule, peer-credentials.js).
 *
 * Creation is once: `wx` makes the create exclusive, so two gateways racing
 * produce one file and the loser reads the winner's key. The check path
 * (isApproved) only ever READS: a missing key means no approval is valid, and
 * is never a reason to mint one.
 */
import { randomBytes } from "node:crypto";
import { chmodSync, closeSync, fsyncSync, openSync, readFileSync, unlinkSync, writeSync } from "node:fs";
import { dirname, join } from "node:path";
import { resolveCrowHome } from "./crow-home.js";
import { ensureSecretsDir } from "./peer-credentials.js";

/** Bytes in the approval key (an HMAC-SHA256 key). */
export const APPROVAL_KEY_BYTES = 32;

/** `crowHome` (a string, a getter, or nothing for this instance's home). */
function homeOf(crowHome) {
  const h = typeof crowHome === "function" ? crowHome() : crowHome;
  return h || resolveCrowHome();
}

/** `<CROW_HOME>/secrets/data-backend-approval.key`. */
export function approvalKeyPath(crowHome) {
  return join(homeOf(crowHome), "secrets", "data-backend-approval.key");
}

/**
 * The stored key, or null when it is missing, unreadable or not exactly
 * APPROVAL_KEY_BYTES long. Never throws, never creates.
 */
export function readApprovalKey({ crowHome } = {}) {
  let bytes;
  try {
    bytes = readFileSync(approvalKeyPath(crowHome));
  } catch {
    return null;
  }
  return bytes.length === APPROVAL_KEY_BYTES ? bytes : null;
}

/**
 * The stored key, made on first use. Returns the key that is on disk
 * afterwards. Throws only when it can neither create nor read one (a
 * read-only or vanished secrets dir, or an existing file that is not a key).
 */
export function ensureApprovalKey({ crowHome } = {}) {
  const path = approvalKeyPath(crowHome);
  const have = readApprovalKey({ crowHome });
  if (have) return have;

  ensureSecretsDir(dirname(path));
  const key = randomBytes(APPROVAL_KEY_BYTES);
  let fd;
  try {
    fd = openSync(path, "wx", 0o600);
  } catch (err) {
    if (err?.code === "EEXIST") {
      // Another gateway won the race: use its key.
      const raced = readApprovalKey({ crowHome });
      if (raced) return raced;
      throw new Error(`the approval key file ${path} exists but does not hold a key`);
    }
    throw new Error(`the approval key file ${path} could not be created (${err?.code || "error"})`);
  }
  try {
    writeSync(fd, key, 0, key.length, 0);
    fsyncSync(fd);
  } catch {
    try { closeSync(fd); } catch { /* already closed or never opened */ }
    try { unlinkSync(path); } catch { /* best effort: an empty key reads as no key */ }
    throw new Error(`the approval key file ${path} could not be written`);
  }
  try { closeSync(fd); } catch { /* best effort */ }
  try { chmodSync(path, 0o600); } catch { /* 0600 was requested at create; the umask can only tighten it */ }
  return key;
}