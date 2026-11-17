/**
 * The tap seal: the one thing a `holding` or `scheduled` row carries that a writer who is not the owner
 * route cannot forge, and the thing `deliver` checks before it claims anything.
 *
 * A seal is an HMAC-SHA256 over the fields a tap is about — the draft, the head hash the person was
 * looking at, the action word, the time the hold or the schedule falls due, the attachment digest, the
 * account, the From address and a per-tap random id — under a subkey derived from the keychain's own
 * key file: `HMAC(keychain seed, "crow-mail-tap-seal-v1")`. The keychain key is the one secret this
 * Crow holds that no bot can read through the database, so the seal is the run-time half of the rule
 * that nothing goes out without a person's tap (the owner routes and the absence of any send tool are
 * the other half).
 *
 * Every field is encoded length-prefixed (a 4-byte big-endian length, then the UTF-8 bytes, with a type
 * tag so a number and its decimal text cannot collide), in a fixed order. Two spellings of the same
 * characters therefore cannot produce the same payload, and a field cannot slide into its neighbour.
 *
 * The honest limit: this is a tamper check, not a capability. A process that can read
 * `<CROW_HOME>/secrets/keychain.key` could mint a seal, and a writer that copied a live row — seal and
 * `tap_id` together — could replay it until it is consumed or cleared. What the per-tap id buys is that
 * a seal copied from an earlier tap does not verify for a later one of the same content at the same
 * time; what the store buys is that every exit from `holding`/`scheduled` nulls the seal, so a
 * cancelled, discarded or sent row has nothing left to revive.
 *
 * `verifySeal` answers false for anything that is not exactly a seal this key made over these fields —
 * a missing seal, a truncated or padded one, one changed character, an upper-case copy of one, a field
 * the seal was not made over. Only `sealFor` throws, and only for a caller that has no seed or no field
 * to seal.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { MailError } from "../errors.js";

/** The MAC domain the subkey is derived under; bumping it invalidates every seal ever made. */
export const TAP_SEAL_DOMAIN = "crow-mail-tap-seal-v1";

/** The fields a seal covers, in the one order they are encoded. */
export const TAP_SEAL_FIELDS = Object.freeze([
  "draftId", "headHash", "action", "when", "attachDigest", "accountId", "fromAddress", "tapId",
]);

/** The payload's own version, so a future shape is a different MAC input. */
const PAYLOAD_VERSION = "v1";

/** A tap id is 16 random bytes, written as 32 hex characters. */
const TAP_ID_BYTES = 16;

/** A seal is 32 bytes, written as 64 lower-case hex characters: one spelling, one seal. */
const SEAL_HEX = /^[0-9a-f]{64}$/;

function bad(field) {
  return new MailError("BAD_INPUT", field);
}

/** A fresh tap id: one tap, one id, so a seal binds a tap and not a content/time pair. */
export function newTapId() {
  return randomBytes(TAP_ID_BYTES).toString("hex");
}

/** The per-seal subkey: HMAC-SHA256 of the domain under the keychain seed. */
export function tapSealKey(seed) {
  if (seed == null) throw bad("seed");
  let bytes;
  if (Buffer.isBuffer(seed)) bytes = seed;
  else if (seed instanceof Uint8Array) bytes = Buffer.from(seed.buffer, seed.byteOffset, seed.byteLength);
  else throw bad("seed");
  if (!bytes.length) throw bad("seed");
  return createHmac("sha256", bytes).update(TAP_SEAL_DOMAIN, "utf8").digest();
}

/**
 * One field as its tagged text: `s` for a string, `n` for a finite number. Anything else — including a
 * missing field, an empty string and a `null` — is refused rather than sealed as something it is not.
 */
function fieldText(fields, name) {
  const value = fields[name];
  if (typeof value === "string" && value) return `s${value}`;
  if (typeof value === "number" && Number.isFinite(value)) return `n${value}`;
  throw bad(name);
}

/** Every field, length-prefixed and in the fixed order, plus the payload version in front. */
function sealPayload(fields) {
  if (fields == null || typeof fields !== "object" || Array.isArray(fields)) throw bad("fields");
  const chunks = [];
  const push = (text) => {
    const body = Buffer.from(text, "utf8");
    const head = Buffer.alloc(4);
    head.writeUInt32BE(body.length, 0);
    chunks.push(head, body);
  };
  push(`v${PAYLOAD_VERSION}`);
  for (const name of TAP_SEAL_FIELDS) push(fieldText(fields, name));
  return Buffer.concat(chunks);
}

/**
 * Seal one tap: the hex HMAC over `{draftId, headHash, action, when, attachDigest, accountId,
 * fromAddress, tapId}` under the keychain seed. Written by `requestSend` and `scheduleDraft` into the
 * same UPDATE that moves the draft into `holding` or `scheduled`.
 *
 * @param {{draftId: string, headHash: string, action: string, when: number, attachDigest: string,
 *   accountId: string, fromAddress: string, tapId: string}} fields
 * @param {Buffer|Uint8Array} seed the keychain key's seed
 * @returns {string} 64 hex characters
 */
export function sealFor(fields, seed) {
  return createHmac("sha256", tapSealKey(seed)).update(sealPayload(fields)).digest("hex");
}

/**
 * Does `seal` seal exactly these fields under this seed? The stored seal must be one lower-case hex
 * string of 64 characters before anything is compared; then the two MACs are compared in constant
 * time. Never throws: an unverifiable seal is a refusal, not an error.
 *
 * @param {object} fields the same shape `sealFor` takes
 * @param {string} seal the hex seal stored on the row
 * @param {Buffer|Uint8Array} seed the keychain key's seed
 * @returns {boolean}
 */
export function verifySeal(fields, seal, seed) {
  if (typeof seal !== "string" || !SEAL_HEX.test(seal)) return false;
  const given = Buffer.from(seal, "hex");
  let expected;
  try {
    expected = Buffer.from(sealFor(fields, seed), "hex");
  } catch {
    return false;
  }
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}