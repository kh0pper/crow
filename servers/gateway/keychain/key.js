/**
 * The Crow keychain's OWN key (Kevin, 2026-10-03, review C7): 32 random bytes in
 * <CROW_HOME>/secrets/keychain.key (dir 700, file 600). It is NOT the identity seed, so
 * nothing that copies identity.json or crow.db (product /api/admin/backup + Nest "Run
 * backup now", onboarding identity export, r4-backup.sh, crow-db-backup.sh, instance sync)
 * can make keychain ciphertext readable elsewhere. The only way entries leave the machine is
 * the user's own passphrase-encrypted Export (keychain/export.js). Container deployments
 * must keep CROW_HOME on a volume, or every recreate loses the key (spec §6).
 *
 * States (keychainKeyState): "ok" | "missing" | "invalid" (present but empty/short/corrupt).
 * Creation is crash-atomic (re-review m1): a 600 temp file is written and fsync'd, then
 * hard-linked to the final name (link never overwrites; EEXIST = another writer won, use
 * theirs), then the temp is removed — a crash can leave only a stray temp, never an empty
 * keychain.key. An INVALID file is replaced only when the keychain table is empty (the
 * caller decides, store.ensureWriteKey) and is then moved aside, never deleted.
 */
import { existsSync, readFileSync, mkdirSync, chmodSync, openSync, writeSync, fsyncSync, closeSync, linkSync, unlinkSync, renameSync } from "node:fs";
import { join, dirname } from "node:path";
import { homedir } from "node:os";
import { randomBytes, createHash } from "node:crypto";

export class KeychainKeyInvalidError extends Error {
  constructor(path) {
    super(`The keychain key file ${path} is unreadable (empty or damaged) and saved passwords depend on it. Restore it from where you keep it, or delete the saved passwords first, then try again.`);
    this.code = "KEYCHAIN_KEY_INVALID";
    this.path = path;
  }
}

export function keychainKeyPath(crowHome = process.env.CROW_HOME || join(homedir(), ".crow")) {
  return join(crowHome, "secrets", "keychain.key");
}

export function keychainKeyState({ crowHome } = {}) {
  const path = keychainKeyPath(crowHome);
  if (!existsSync(path)) return { state: "missing", path, key: null };
  try {
    const j = JSON.parse(readFileSync(path, "utf8"));
    const seed = Buffer.from(String(j.key || ""), "base64");
    if (j.v !== 1 || typeof j.id !== "string" || !/^[0-9a-f]{16}$/.test(j.id) || seed.length !== 32) return { state: "invalid", path, key: null };
    return { state: "ok", path, key: { id: j.id, seed } };
  } catch {
    return { state: "invalid", path, key: null };
  }
}

/** Read-only: `{ id, seed }`, or null when the key file is missing or invalid. Never creates. */
export function loadKeychainKey({ crowHome } = {}) {
  return keychainKeyState({ crowHome }).key;
}

/**
 * Create the key if it is missing (or, with replaceInvalid, if it is invalid). Returns the
 * key that is on disk afterwards. Throws KeychainKeyInvalidError for an invalid file unless
 * replaceInvalid is set.
 */
export function createKeychainKey({ crowHome, replaceInvalid = false } = {}) {
  const st = keychainKeyState({ crowHome });
  if (st.state === "ok") return st.key;
  if (st.state === "invalid") {
    if (!replaceInvalid) throw new KeychainKeyInvalidError(st.path);
    renameSync(st.path, `${st.path}.invalid-${Date.now()}`);
  }
  const dir = dirname(st.path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  chmodSync(dir, 0o700);
  const seed = randomBytes(32);
  const id = createHash("sha256").update(seed).digest("hex").slice(0, 16);
  const tmp = `${st.path}.tmp-${process.pid}-${randomBytes(4).toString("hex")}`;
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, JSON.stringify({ v: 1, id, key: seed.toString("base64") }) + "\n");
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  try {
    linkSync(tmp, st.path);
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
  } finally {
    try { unlinkSync(tmp); } catch {}
  }
  try { const dfd = openSync(dir, "r"); fsyncSync(dfd); closeSync(dfd); } catch { /* best effort */ }
  const after = keychainKeyState({ crowHome });
  if (after.state !== "ok") throw new KeychainKeyInvalidError(after.path);
  return after.key;
}
