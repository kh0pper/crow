/**
 * Passphrase-encrypted keychain Export / Import (Kevin, 2026-10-03): the ONLY way keychain
 * entries leave the machine, and only on the user's explicit, re-authenticated request.
 * KDF: Argon2id (Node 24 crypto.argon2, ASYNC — off the event loop) over the passphrase
 * with a random 16-byte salt → 32-byte key. Cipher: AES-256-GCM, 12-byte nonce, 16-byte tag.
 *
 * Import trusts NOTHING in the file (re-review B2): only the exact v1 KDF constants are
 * accepted (a crafted file cannot ask for gigabytes of memory or hours of passes), and the
 * salt / nonce / tag lengths are checked before any work is done.
 */
import { argon2, randomBytes, createCipheriv, createDecipheriv } from "node:crypto";
import { promisify } from "node:util";

const argon2Async = promisify(argon2);

export const EXPORT_FORMAT = "crow-keychain-export";
export const KDF_V1 = Object.freeze({ alg: "argon2id", memory: 65536, passes: 3, parallelism: 4 });
export const MIN_PASSPHRASE = 12;
const SALT_LEN = 16;
const NONCE_LEN = 12;
const TAG_LEN = 16;
const MAX_CIPHERTEXT_B64 = 4 * 1024 * 1024;

function deriveKey(passphrase, salt) {
  return argon2Async("argon2id", {
    message: Buffer.from(String(passphrase), "utf8"),
    nonce: salt,
    memory: KDF_V1.memory,
    passes: KDF_V1.passes,
    parallelism: KDF_V1.parallelism,
    tagLength: 32,
  });
}

export async function sealExport(entries, passphrase, { now = new Date() } = {}) {
  if (typeof passphrase !== "string" || passphrase.length < MIN_PASSPHRASE) throw new Error(`passphrase must be at least ${MIN_PASSPHRASE} characters`);
  const salt = randomBytes(SALT_LEN);
  const nonce = randomBytes(NONCE_LEN);
  const key = await deriveKey(passphrase, salt);
  const cipher = createCipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_LEN });
  const ct = Buffer.concat([cipher.update(JSON.stringify({ entries }), "utf8"), cipher.final()]);
  return {
    format: EXPORT_FORMAT, version: 1, created_at: now.toISOString(), count: entries.length,
    kdf: { ...KDF_V1, salt: salt.toString("base64") },
    cipher: "aes-256-gcm", nonce: nonce.toString("base64"),
    ciphertext: ct.toString("base64"), tag: cipher.getAuthTag().toString("base64"),
  };
}

const b64 = (v, len) => {
  if (typeof v !== "string" || !/^[A-Za-z0-9+/]+={0,2}$/.test(v)) return null;
  const buf = Buffer.from(v, "base64");
  return len === undefined || buf.length === len ? buf : null;
};

/** The entries array, or null when the passphrase is wrong or the file is not a v1 export. */
export async function openExport(file, passphrase) {
  try {
    if (!file || typeof file !== "object" || file.format !== EXPORT_FORMAT || file.version !== 1 || file.cipher !== "aes-256-gcm") return null;
    const k = file.kdf || {};
    if (k.alg !== KDF_V1.alg || k.memory !== KDF_V1.memory || k.passes !== KDF_V1.passes || k.parallelism !== KDF_V1.parallelism) return null;
    const salt = b64(k.salt, SALT_LEN);
    const nonce = b64(file.nonce, NONCE_LEN);
    const tag = b64(file.tag, TAG_LEN);
    if (!salt || !nonce || !tag || typeof file.ciphertext !== "string" || file.ciphertext.length > MAX_CIPHERTEXT_B64) return null;
    const ct = b64(file.ciphertext);
    if (!ct) return null;
    if (typeof passphrase !== "string" || passphrase === "") return null;
    const key = await deriveKey(passphrase, salt);
    const d = createDecipheriv("aes-256-gcm", key, nonce, { authTagLength: TAG_LEN });
    d.setAuthTag(tag);
    const pt = Buffer.concat([d.update(ct), d.final()]).toString("utf8");
    const parsed = JSON.parse(pt);
    return Array.isArray(parsed.entries) ? parsed.entries : null;
  } catch {
    return null;
  }
}
