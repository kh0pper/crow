/**
 * Argon2id PHC strings with Node 24's built-in crypto.argon2Sync (no dependency).
 *
 * Format Vaultwarden 1.32.7 parses (src/api/admin.rs _validate_token →
 * argon2::password_hash::PasswordHash::new; params are read from the string):
 *   $argon2id$v=19$m=65540,t=3,p=4$<salt>$<hash>
 * salt/hash: standard base64 WITHOUT padding (PHC). Params = Vaultwarden wiki's
 * "Bitwarden defaults" preset. ~60 ms on crow; called once per install.
 */
import { argon2Sync, randomBytes, timingSafeEqual } from "node:crypto";

export const ARGON2_PARAMS = Object.freeze({ memory: 65540, passes: 3, parallelism: 4, tagLength: 32 });

const b64 = (buf) => Buffer.from(buf).toString("base64").replace(/=+$/, "");

function derive(plaintext, salt, p) {
  return argon2Sync("argon2id", {
    message: Buffer.from(String(plaintext), "utf8"),
    nonce: salt,
    memory: p.memory,
    passes: p.passes,
    parallelism: p.parallelism,
    tagLength: p.tagLength,
  });
}

export function argon2idPhc(plaintext, { salt = randomBytes(16) } = {}) {
  const p = ARGON2_PARAMS;
  const hash = derive(plaintext, salt, p);
  return `$argon2id$v=19$m=${p.memory},t=${p.passes},p=${p.parallelism}$${b64(salt)}$${b64(hash)}`;
}

const PHC = /^\$argon2id\$v=19\$m=(\d+),t=(\d+),p=(\d+)\$([A-Za-z0-9+/]+)\$([A-Za-z0-9+/]+)$/;

export function verifyArgon2idPhc(plaintext, phc) {
  const m = PHC.exec(String(phc || ""));
  if (!m) return false;
  try {
    const salt = Buffer.from(m[4], "base64");
    const want = Buffer.from(m[5], "base64");
    const got = derive(plaintext, salt, { memory: Number(m[1]), passes: Number(m[2]), parallelism: Number(m[3]), tagLength: want.length });
    return got.length === want.length && timingSafeEqual(got, want);
  } catch {
    return false;
  }
}
