/**
 * The server secret the dashboard's CSRF tokens are derived from.
 *
 * A CSRF token is `HMAC-SHA256(secret, session id)` (csrf.js). It is never
 * stored, never compared to a cookie, and never readable by page script: the
 * token that reaches the page is computed from THIS secret and the HttpOnly
 * session cookie, so a script that can read neither cannot produce one. That is
 * what closes the cookie-tossing hole: `<instance>.<tailnet>.ts.net` and
 * `<instance>-apps.<tailnet>.ts.net` are the same SITE (`ts.net` is on the PSL),
 * so another host on the tailnet can toss a `Domain=<tailnet>.ts.net` cookie
 * into the dashboard's jar and SameSite=Lax still sends the session — but it
 * cannot compute this HMAC.
 *
 * Storage: `<CROW_HOME>/secrets/csrf.key`, directory 0700, file 0600 — the same
 * place and permissions as the keychain's own key (keychain/key.js), and for the
 * same reason: nothing that copies `crow.db` or `identity.json` (backups,
 * instance sync) can mint tokens for another machine's sessions.
 *
 * Creation is crash-atomic: a 0600 temp file is written and fsync'd, hard-linked
 * to the final name (link never overwrites; EEXIST means another writer won and
 * theirs is used), then the temp is removed. A crash can leave a stray temp but
 * never an empty key.
 *
 * The secret is read once per process and cached: a rotated file takes effect on
 * the next boot (every live session would need a fresh token anyway).
 *
 * Node built-ins only, and no import of auth/db, so csrf.js can import it
 * without a cycle.
 */
import {
  existsSync, readFileSync, mkdirSync, chmodSync, openSync, writeSync, fsyncSync, closeSync,
  linkSync, unlinkSync, renameSync,
} from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { randomBytes } from "node:crypto";

const cache = new Map();

/** `<CROW_HOME>/secrets/csrf.key` (CROW_HOME defaults to ~/.crow). */
export function csrfSecretPath(crowHome = process.env.CROW_HOME || join(homedir(), ".crow")) {
  return join(crowHome, "secrets", "csrf.key");
}

function readSecret(path) {
  try {
    const raw = readFileSync(path, "utf8");
    const j = JSON.parse(raw);
    const key = Buffer.from(String(j?.key || ""), "base64");
    return key.length >= 32 ? key : null;
  } catch {
    return null;
  }
}

function createSecret(path) {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* an operator-owned dir may refuse; the file mode still holds */ }
  const key = randomBytes(32);
  const tmp = `${path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, JSON.stringify({ v: 1, key: key.toString("base64") }) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(tmp, path);
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
  } finally {
    try { unlinkSync(tmp); } catch { /* already gone */ }
  }
  try { const dfd = openSync(dir, "r"); fsyncSync(dfd); closeSync(dfd); } catch { /* best effort */ }
  return readSecret(path) || key;
}

/**
 * Move a key file this process cannot read out of the way, so a fresh one can be
 * created in its place. Returns the name it was moved to, or null when even the
 * rename failed (then the caller mints an in-process key and says so loudly).
 *
 * The file may hold a real key that a permission or encoding accident made
 * unreadable, so it is KEPT (as `csrf.key.bad-<ts>`), never deleted: the operator
 * can still recover it. Mode 0600 like the original — it is as secret as one.
 */
function quarantineSecret(path) {
  const aside = `${path}.bad-${new Date().toISOString().replace(/[:.]/g, "-")}`;
  try {
    renameSync(path, aside);
    return aside;
  } catch {
    return null;
  }
}

/**
 * The CSRF HMAC secret for this instance's CROW_HOME. Created on first use
 * (0600 in a 0700 dir) and cached for the life of the process.
 *
 * A key file that EXISTS but cannot be read (corrupt JSON, a truncated or short
 * key, a permissions accident) used to be a silent hole: createSecret's
 * hard-link lost to the file already there, so the process kept a fresh RANDOM
 * key that was never persisted — different on every boot, and every token minted
 * from it died with the process. Now that case is loud: the bad file is renamed
 * aside and a real one is written, so the secret is stable again.
 *
 * @param {{ crowHome?: string, path?: string }} [opts] test seam
 * @returns {Buffer} at least 32 bytes
 */
export function csrfSecret({ crowHome, path: at } = {}) {
  const path = at || csrfSecretPath(crowHome);
  const hit = cache.get(path);
  if (hit) return hit;
  let existing = null;
  if (existsSync(path)) {
    existing = readSecret(path);
    if (!existing) {
      const aside = quarantineSecret(path);
      console.error(
        `[csrf] ${path} exists but is unreadable or corrupt (not JSON, or a key under 32 bytes)`
        + (aside ? ` — moved aside to ${aside}` : " — could not be moved aside")
        + "; minting a fresh key. Sessions keep working: every CSRF token is recomputed from it.",
      );
    }
  }
  const key = existing || createSecret(path);
  cache.set(path, key);
  return key;
}

/** Test seam: forget the cached secret (a fresh CROW_HOME in the same process). */
export function forgetCsrfSecret() {
  cache.clear();
}