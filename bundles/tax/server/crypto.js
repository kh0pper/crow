/**
 * Crow Tax — AES-256-GCM Encryption for PII
 *
 * Encrypts sensitive data (SSN, names) before storing in SQLite.
 * Key is derived from CROW_TAX_ENCRYPTION_KEY via PBKDF2.
 */

import { createCipheriv, createDecipheriv, randomBytes, pbkdf2Sync, createHash } from "node:crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 12;
const TAG_LENGTH = 16;
const SALT_LENGTH = 16;
const KEY_LENGTH = 32;
const ITERATIONS = 100000;

/**
 * Derive a 256-bit key from a passphrase using PBKDF2.
 */
// SHA-256 of the example key once published in this bundle's .env.example.
const PUBLISHED_EXAMPLE_KEYS = new Set(["113e3beef46e2a2ab77b0c3ea62ef37d823b82eab4f713a44af32bcdd2655365"]);

/** An example passphrase: placeholder-shaped, or the one published in the repo. Only
 * encryption refuses it; decrypt() still opens data an install saved with it. */
export function isExampleKey(passphrase) {
  const s = String(passphrase).trim();
  if (PUBLISHED_EXAMPLE_KEYS.has(createHash("sha256").update(s).digest("hex"))) return true;
  return /\bchange[-_ ]?me\b|\breplace[-_ ]?me\b|(?:^|[^a-z])your[-_]|\bplaceholder\b|^<[^>]*>$|\bxxx+\b|\bexample\b/i.test(s);
}

function deriveKey(passphrase, salt) {
  return pbkdf2Sync(passphrase, salt, ITERATIONS, KEY_LENGTH, "sha256");
}

/**
 * Encrypt a string. Returns base64-encoded: salt + iv + tag + ciphertext
 */
export function encrypt(plaintext, passphrase) {
  if (!passphrase) throw new Error("Encryption passphrase required (CROW_TAX_ENCRYPTION_KEY)");
  if (isExampleKey(passphrase)) {
    throw new Error("CROW_TAX_ENCRYPTION_KEY is an example value (it looks like a placeholder, or it was published in Crow's repository). Set a passphrase of your own in Extensions before saving personal data; data saved earlier with it can still be read.");
  }

  const salt = randomBytes(SALT_LENGTH);
  const key = deriveKey(passphrase, salt);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGORITHM, key, iv);

  let encrypted = cipher.update(plaintext, "utf8");
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  const tag = cipher.getAuthTag();

  // Pack: salt(16) + iv(12) + tag(16) + ciphertext
  const packed = Buffer.concat([salt, iv, tag, encrypted]);
  return packed.toString("base64");
}

/**
 * Decrypt a base64-encoded encrypted string.
 */
export function decrypt(encoded, passphrase) {
  if (!passphrase) throw new Error("Encryption passphrase required (CROW_TAX_ENCRYPTION_KEY)");

  const packed = Buffer.from(encoded, "base64");
  const salt = packed.subarray(0, SALT_LENGTH);
  const iv = packed.subarray(SALT_LENGTH, SALT_LENGTH + IV_LENGTH);
  const tag = packed.subarray(SALT_LENGTH + IV_LENGTH, SALT_LENGTH + IV_LENGTH + TAG_LENGTH);
  const ciphertext = packed.subarray(SALT_LENGTH + IV_LENGTH + TAG_LENGTH);

  const key = deriveKey(passphrase, salt);
  const decipher = createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);

  let decrypted = decipher.update(ciphertext);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString("utf8");
}
