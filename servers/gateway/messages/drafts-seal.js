/**
 * The draft's seal: the one thing on a `message_drafts` row that a writer who is not this Crow's own
 * store cannot forge, and the thing the send path checks before anything leaves the box.
 *
 * A seal is an HMAC-SHA256 over the draft's identity and the audience it was written for — the draft
 * id, its origin, the bot that wrote it (id AND the name the person will read), when the draft was
 * created, the conversation kind and id, and every recipient in the canonical order the store wrote
 * them, each recipient being `{contact_id, crow_id, secp256k1_pubkey}` with the key SNAPSHOT taken at
 * that moment — under a subkey derived from the keychain's own key file:
 * `HMAC(keychain seed, "crow-message-draft-recipients-v1")`. That key is the one secret this Crow
 * holds that no bot can read through the database, so a bot (which writes drafts, and whose words are
 * its own) cannot mint a seal for a recipient set the owner never saw, cannot turn its own draft into
 * the owner's (origin and the bot's id and name are sealed), and cannot backdate one (created_at is
 * sealed). The send path recomputes the recipient set from the LIVE conversation and refuses when the
 * seal or that set has moved (servers/gateway/messages/drafts-send.js,
 * servers/gateway/routes/messages-drafts-api.js).
 *
 * WHY THE PUBKEY IS IN IT: a recipient's key changing is the one event that makes "send it to the
 * person this draft was written for" mean somebody else. The snapshot lives in `recipients_json`, the
 * seal covers it, and the send re-checks each recipient's CURRENT key against it, so a contact whose
 * key was replaced between the draft and the tap refuses instead of delivering.
 *
 * Every field is encoded length-prefixed (a 4-byte big-endian length, then the UTF-8 bytes, with a
 * type tag so a number and its decimal text cannot collide) in one fixed order. A recipient list is
 * encoded as its length followed by each entry, so `["a", "b"]` and `["a b"]` cannot seal to the
 * same payload — an entry cannot slide into its neighbour, and the list cannot be re-split. An absent
 * optional field (an owner's draft has no bot) is its own tagged chunk, distinct from the empty
 * string, so "no bot" can never seal to "a bot with an empty name".
 *
 * The honest limit: this is a tamper check, not a capability. A process that can read
 * `<CROW_HOME>/secrets/keychain.key` could mint a seal (no bot has that file; a bot's own world is
 * its workspace, not this Crow's home). What the seal buys is that the recipients a message reaches
 * are the ones this instance wrote down for that draft — a body a bot wrote can never be re-pointed
 * at a different conversation by editing one column.
 *
 * `verifyRecipients` answers false for anything that is not exactly a seal this key made over these
 * fields — a missing seal, a truncated or padded one, one changed character, an upper-case copy of
 * one, a field the seal was not made over. Only `sealRecipients` throws, and only for a caller with
 * no seed or no field to seal.
 */
import { createHmac, timingSafeEqual } from "node:crypto";
import { createKeychainKey, loadKeychainKey } from "../keychain/key.js";

/** The MAC domain the subkey is derived under; bumping it invalidates every seal ever made. */
export const DRAFT_SEAL_DOMAIN = "crow-message-draft-recipients-v1";

/** The fields a seal covers, in the one order they are encoded. */
export const DRAFT_SEAL_FIELDS = Object.freeze([
  "draftId", "origin", "botId", "botName", "conversationKind", "conversationId", "createdAt",
  "recipients",
]);

/** The payload's own version, so a future shape is a different MAC input. */
const PAYLOAD_VERSION = "v1";

/** A seal is 32 bytes, written as 64 lower-case hex characters: one spelling, one seal. */
const SEAL_HEX = /^[0-9a-f]{64}$/;

/** The per-seal subkey: HMAC-SHA256 of the domain under the keychain seed. */
export function draftSealKey(seed) {
  const bytes = seedBytes(seed);
  return createHmac("sha256", bytes).update(DRAFT_SEAL_DOMAIN, "utf8").digest();
}

function seedBytes(seed) {
  if (seed == null) throw new Error("draft seal: seed");
  let bytes;
  if (Buffer.isBuffer(seed)) bytes = seed;
  else if (seed instanceof Uint8Array) bytes = Buffer.from(seed.buffer, seed.byteOffset, seed.byteLength);
  else throw new Error("draft seal: seed");
  if (!bytes.length) throw new Error("draft seal: seed");
  return bytes;
}

/** One length-prefixed chunk (4-byte big-endian length, then the UTF-8 bytes). */
function pushChunk(chunks, text) {
  const body = Buffer.from(text, "utf8");
  const head = Buffer.alloc(4);
  head.writeUInt32BE(body.length, 0);
  chunks.push(head, body);
}

/** One field as its tagged text: `s` for a string (the empty one included), `n` for a finite number,
 *  `z` for an absent value (an owner's draft has no bot id and no bot name). */
function fieldText(fields, name) {
  const value = fields[name];
  if (value === null || value === undefined) return "z";
  if (typeof value === "string") return `s${value}`;
  if (typeof value === "number" && Number.isFinite(value)) return `n${value}`;
  throw new Error(`draft seal: ${name}`);
}

/** The recipient list as one encoded field: its length, then each entry, each length-prefixed. */
function recipientsText(value) {
  if (!Array.isArray(value) || value.length === 0) throw new Error("draft seal: recipients");
  const entries = value.map((entry) => {
    if (typeof entry !== "string" || entry === "") throw new Error("draft seal: recipients");
    return entry;
  });
  return `l${entries.length}` + entries.map((entry) => `s${entry}`).join("");
}

/** Every field, length-prefixed and in the fixed order, plus the payload version in front. */
function sealPayload(fields) {
  if (fields == null || typeof fields !== "object" || Array.isArray(fields)) {
    throw new Error("draft seal: fields");
  }
  const chunks = [];
  pushChunk(chunks, `v${PAYLOAD_VERSION}`);
  for (const name of DRAFT_SEAL_FIELDS) {
    const text = name === "recipients" ? recipientsText(fields[name]) : fieldText(fields, name);
    pushChunk(chunks, text);
  }
  return Buffer.concat(chunks);
}

/**
 * Seal one draft: the hex HMAC over `{draftId, origin, botId, botName, conversationKind,
 * conversationId, createdAt, recipients}` under the keychain seed. Written by the store into the same
 * INSERT (or the same recipient-changing UPDATE) that writes `recipients_json`, so the two can never
 * disagree.
 *
 * @param {{draftId: string, origin: string, botId: string|null, botName: string|null,
 *   conversationKind: string, conversationId: number, createdAt: number, recipients: string[]}} fields
 *   `recipients` is the canonical recipient-key list (`recipientKey` in conversations.js: one string
 *   per person, carrying the contact id, the crow id and the key snapshot)
 * @param {Buffer|Uint8Array} seed the keychain key's seed
 * @returns {string} 64 hex characters
 */
export function sealRecipients(fields, seed) {
  return createHmac("sha256", draftSealKey(seed)).update(sealPayload(fields)).digest("hex");
}

/**
 * Does `seal` seal exactly these fields under this seed? The stored seal must be one lower-case hex
 * string of 64 characters before anything is compared; then the two MACs are compared in constant
 * time. Never throws: an unverifiable seal is a refusal, not an error.
 *
 * @param {object} fields the same shape `sealRecipients` takes
 * @param {string} seal the hex seal stored on the row
 * @param {Buffer|Uint8Array} seed the keychain key's seed
 * @returns {boolean}
 */
export function verifyRecipients(fields, seal, seed) {
  if (typeof seal !== "string" || !SEAL_HEX.test(seal)) return false;
  const given = Buffer.from(seal, "hex");
  let expected;
  try {
    expected = Buffer.from(sealRecipients(fields, seed), "hex");
  } catch {
    return false;
  }
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}

/**
 * The seed this instance seals with: the keychain key's own seed, read-only. A Crow that has never
 * saved a password has no key file yet, and one is created here — the keychain's own creator, so the
 * file it makes is the same 600-mode, crash-atomic one a first saved password would make (nothing
 * else about it is touched, and no password is stored). A key file that is present but unreadable is
 * NOT replaced: `createKeychainKey` throws for it and this answers null, so a damaged key refuses
 * sends instead of silently forgetting every seal this instance ever made.
 *
 * @param {{crowHome?: string}} [opts]
 * @returns {Buffer|null} 32 bytes, or null when this host has no usable key
 */
export function loadDraftSealSeed(opts = {}) {
  const key = loadKeychainKey(opts);
  if (key && Buffer.isBuffer(key.seed) && key.seed.length) return key.seed;
  try {
    const made = createKeychainKey(opts);
    return made && Buffer.isBuffer(made.seed) && made.seed.length ? made.seed : null;
  } catch {
    return null;
  }
}