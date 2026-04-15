/**
 * secret-box — symmetric encryption for config secrets stored in dashboard_settings.
 *
 * Purpose: sync feeds are signed but not encrypted on disk (feed files live at
 * ~/.crow/data/instance-sync/<peer>/ as plaintext JSON). Replicating credentials
 * (MinIO root password, etc.) via sync-allowlist would leave plaintext on every
 * paired host. secret-box seals sensitive values before they're written so the
 * ciphertext is safe to replicate; only hosts with the same Crow identity seed
 * can decrypt.
 *
 * KDF matches servers/sharing/identity.js:49-51 (hkdf-sha256 over the master seed).
 * Cipher: AES-256-GCM via node:crypto.
 *
 * Wire format: "enc:v1:" + base64(nonce(12) || ciphertext || tag(16))
 */
import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { hkdf } from "@noble/hashes/hkdf";
import { sha256 } from "@noble/hashes/sha256";

const PREFIX = "enc:v1:";
const INFO = "crow-secret-box-v1";
const NONCE_LEN = 12;
const TAG_LEN = 16;

function deriveKey(identity) {
  if (!identity?.seed) {
    throw new Error("secret-box: identity.seed missing — cannot derive key");
  }
  const seed = Buffer.isBuffer(identity.seed) ? identity.seed : Buffer.from(identity.seed);
  return Buffer.from(hkdf(sha256, seed, undefined, INFO, 32));
}

export function isSealed(value) {
  return typeof value === "string" && value.startsWith(PREFIX);
}

export function sealSecret(plaintext, identity) {
  if (plaintext == null) return plaintext;
  const pt = typeof plaintext === "string" ? Buffer.from(plaintext, "utf8") : Buffer.from(plaintext);
  const key = deriveKey(identity);
  const nonce = randomBytes(NONCE_LEN);
  const cipher = createCipheriv("aes-256-gcm", key, nonce);
  const ct = Buffer.concat([cipher.update(pt), cipher.final()]);
  const tag = cipher.getAuthTag();
  return PREFIX + Buffer.concat([nonce, ct, tag]).toString("base64");
}

/**
 * Opens a sealed value. Returns plaintext string, or null if value is not sealed
 * (callers can distinguish "no-op, already plain" from an error). Throws on tag
 * mismatch — a tampered or wrong-identity blob should fail loudly.
 */
export function openSecret(value, identity) {
  if (!isSealed(value)) return null;
  const blob = Buffer.from(value.slice(PREFIX.length), "base64");
  if (blob.length < NONCE_LEN + TAG_LEN) {
    throw new Error("secret-box: ciphertext too short");
  }
  const nonce = blob.subarray(0, NONCE_LEN);
  const tag = blob.subarray(blob.length - TAG_LEN);
  const ct = blob.subarray(NONCE_LEN, blob.length - TAG_LEN);
  const key = deriveKey(identity);
  const decipher = createDecipheriv("aes-256-gcm", key, nonce);
  decipher.setAuthTag(tag);
  const pt = Buffer.concat([decipher.update(ct), decipher.final()]);
  return pt.toString("utf8");
}
