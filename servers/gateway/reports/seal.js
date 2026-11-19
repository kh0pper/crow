/**
 * The reports approval seal.
 *
 * Every owner approval in Crow Recurring Reports (go-live, a recipient, a custom-step bundle, a host, a
 * credential binding, a proposal) is stored with an HMAC over the content the owner approved plus a
 * fresh approval nonce, under a subkey derived from the keychain's own seed:
 * `HMAC(keychain seed, "crow-reports-approval-v1")`. The keychain key is the one secret this Crow holds
 * that no bot can read through the database, so a seal is the run-time half of the rule that a bot
 * cannot approve anything. The approvals module and the owner-only routes are the other half.
 *
 * This is the mail tap seal's pattern, copied on purpose (servers/gateway/mail/drafts/seal.js), under
 * its own domain and with its own per-kind field lists. The mail module is inside Crow Mail's
 * anti-goal invariant and `tapSealKey` is hard-wired to the tap domain, so nothing here imports it: a
 * mail seal and a reports seal are different keys even when the field text is the same.
 *
 * Encoding: length-prefixed (a 4-byte big-endian length, then the UTF-8 bytes), type-tagged (`s` for a
 * string, `n` for a finite number), in a fixed per-kind order, with the payload version and the KIND
 * itself part of the MAC input. A seal made for one kind therefore never verifies as another, and two
 * spellings of the same characters cannot produce the same payload.
 *
 * One difference from mail: an EMPTY string is allowed here, because callers pass "" for "none"
 * (no sender account yet, no model, no proposal base). null, undefined, a non-finite number and any
 * other type are refused in the signing path with `code: "bad_seal_field"`.
 *
 * The honest limit: this is a tamper check, not a capability. A process that can read the keychain key
 * file could mint a seal, and a writer that copied a row could replay it until the row changes. What
 * the nonce buys is that every approval is a distinct seal; what the stores buy is that refusing or
 * revoking an approval nulls the seal, so an old seal cannot re-approve anything.
 */
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/** The MAC domain the subkey is derived under; bumping it invalidates every seal ever made. */
export const APPROVAL_SEAL_DOMAIN = "crow-reports-approval-v1";

/** The approvals that carry a seal. */
export const APPROVAL_KINDS = Object.freeze([
  "live", "recipient", "step", "host", "credential", "proposal",
]);

/**
 * Each kind's fields, in the one order they are encoded. Every list ends with `nonce`, so every seal
 * binds one approval rather than a content pair.
 */
export const SEAL_FIELDS = Object.freeze({
  // The live set: what the owner approved the report to read, send and say, and whose report it is.
  // `botId`, `projectId`, `artifactId` and `scheduleId` are here so a report repointed at another bot,
  // moved to another project, or attached to another artifact or schedule row is a different report to
  // approve. `title` is deliberately NOT sealed: it is a label, the owner renames it without a new
  // approval, and PR 2b must treat it as untrusted text when it is used as a subject line (escaped and
  // bounded like any other stored string, never interpolated into a header or a log).
  live: Object.freeze([
    "reportId", "rev", "recipeHash", "sourcesHash", "cron", "tz", "senderAccountId",
    "botId", "projectId", "artifactId", "scheduleId",
    "deliveryMode", "commentTierDefault", "commentVisibility", "aiCommentary", "modelRef", "nonce",
  ]),
  recipient: Object.freeze(["reportId", "recipientId", "address", "commentTier", "nonce"]),
  step: Object.freeze(["reportId", "stepId", "bundleHash", "nonce"]),
  host: Object.freeze(["reportId", "host", "nonce"]),
  credential: Object.freeze(["reportId", "credentialRef", "host", "nonce"]),
  proposal: Object.freeze(["reportId", "proposalId", "baseRev", "diffHash", "nonce"]),
});

/** The payload's own version, so a future shape is a different MAC input. */
const PAYLOAD_VERSION = "v1";

/** An approval nonce is 16 random bytes, written as 32 lower-case hex characters. */
const NONCE_BYTES = 16;
const NONCE_HEX = /^[0-9a-f]{32}$/;

/** A seal is 32 bytes, written as 64 lower-case hex characters: one spelling, one seal. */
const SEAL_HEX = /^[0-9a-f]{64}$/;

function fail(code, detail) {
  const err = new Error(detail ? `${code}: ${detail}` : code);
  err.code = code;
  if (detail) err.detail = detail;
  return err;
}

/** A fresh approval nonce: one approval, one nonce. */
export function newApprovalNonce() {
  return randomBytes(NONCE_BYTES).toString("hex");
}

/** The per-seal subkey: HMAC-SHA256 of the domain under the keychain seed. */
export function approvalSealKey(seed) {
  if (seed == null) throw fail("bad_seal_seed", "seed");
  let bytes;
  if (Buffer.isBuffer(seed)) bytes = seed;
  else if (seed instanceof Uint8Array) bytes = Buffer.from(seed.buffer, seed.byteOffset, seed.byteLength);
  else throw fail("bad_seal_seed", "seed");
  if (!bytes.length) throw fail("bad_seal_seed", "seed");
  return createHmac("sha256", bytes).update(APPROVAL_SEAL_DOMAIN, "utf8").digest();
}

/** The field list for a kind, refusing anything that is not one of APPROVAL_KINDS. */
function fieldsOf(kind) {
  if (typeof kind !== "string" || !APPROVAL_KINDS.includes(kind)) throw fail("bad_seal_kind", "kind");
  return SEAL_FIELDS[kind];
}

/**
 * One field as its tagged text: `s` for a string (the empty string included), `n` for a finite number.
 * Anything else is refused rather than sealed as something it is not.
 */
function fieldText(fields, name) {
  const value = fields[name];
  if (typeof value === "string") return `s${value}`;
  if (typeof value === "number" && Number.isFinite(value)) return `n${value}`;
  throw fail("bad_seal_field", name);
}

/** Every field, length-prefixed and in the kind's fixed order, after the version and the kind. */
function sealPayload(kind, fields) {
  const names = fieldsOf(kind);
  if (fields == null || typeof fields !== "object" || Array.isArray(fields)) {
    throw fail("bad_seal_field", "fields");
  }
  const nonce = fields.nonce;
  if (typeof nonce !== "string" || !NONCE_HEX.test(nonce)) throw fail("bad_seal_field", "nonce");
  const chunks = [];
  const push = (text) => {
    const body = Buffer.from(text, "utf8");
    const head = Buffer.alloc(4);
    head.writeUInt32BE(body.length, 0);
    chunks.push(head, body);
  };
  push(`v${PAYLOAD_VERSION}`);
  push(`k${kind}`);
  for (const name of names) push(fieldText(fields, name));
  return Buffer.concat(chunks);
}

/**
 * Seal one approval: the hex HMAC over the kind's fields under the keychain seed.
 *
 * @param {"live"|"recipient"|"step"|"host"|"credential"|"proposal"} kind
 * @param {object} fields the kind's field list, `nonce` included
 * @param {Buffer|Uint8Array} seed the keychain key's seed
 * @returns {string} 64 lower-case hex characters
 * @throws {Error} `code: "bad_seal_kind"` / `"bad_seal_field"` / `"bad_seal_seed"`
 */
export function approvalSeal(kind, fields, seed) {
  const key = approvalSealKey(seed);
  return createHmac("sha256", key).update(sealPayload(kind, fields)).digest("hex");
}

/**
 * Does `seal` seal exactly these fields of this kind under this seed? The stored seal must be one
 * lower-case hex string of 64 characters before anything is compared; then the two MACs are compared
 * in constant time. Never throws: an unverifiable seal (a wrong length, an upper-case copy, a padded
 * one, a missing nonce, a string where a number was sealed, another kind) is a refusal, not an error.
 *
 * @param {"live"|"recipient"|"step"|"host"|"credential"|"proposal"} kind
 * @param {object} fields the kind's field list
 * @param {string} seal the hex seal stored on the row
 * @param {Buffer|Uint8Array} seed the keychain key's seed
 * @returns {boolean}
 */
export function verifyApprovalSeal(kind, fields, seal, seed) {
  if (typeof seal !== "string" || !SEAL_HEX.test(seal)) return false;
  let expected;
  try {
    expected = Buffer.from(approvalSeal(kind, fields, seed), "hex");
  } catch {
    return false;
  }
  const given = Buffer.from(seal, "hex");
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}