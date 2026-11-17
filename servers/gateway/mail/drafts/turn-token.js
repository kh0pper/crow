/**
 * The drafting turn's token (Crow Mail plan 3, Task 8a): a per-turn credential a bot presents on
 * `/mail-draft/mcp`, and nothing else.
 *
 * The guarantee is scope, not secrecy. A copy of the token can read exactly one draft's thread and
 * write exactly one draft's next revision, only until the turn ends; it is never written to disk and
 * never survives a gateway restart, so nothing outlives the work it was minted for. That is why the
 * store is this module's own memory and why the map is keyed by the token's SHA-256: the raw value is
 * handed to the turn once and is not kept here to leak from a heap dump or a log.
 *
 * A token is bound to four things, all supplied by the turn that mints it:
 *   - `draftId` and `turnId`, so the mount can tell one draft's thread from another's (and one turn of
 *     the same draft from the next);
 *   - `botId`, the bot the turn runs as, so the mount can refuse a signature presented for any other
 *     bot of the same tuple;
 *   - `startHash`, the draft's head hash at the moment the turn started, so `mail_draft_propose` can
 *     refuse a revision written against a draft the person has edited since (the store's compare-and-set
 *     takes that hash as `expectHash`).
 *
 * Expiry is the turn's own timeout plus a margin, never a fixed number of minutes: a token must not
 * die while its turn can still legitimately run, and must not outlive it by more than the margin. The
 * turn's `finally` revokes it, which is the answer that actually arrives first in normal operation.
 *
 * Not a `pathScopedToken` family: those are hashes in `dashboard_settings`, rotated at boot. This one
 * is per turn, in memory only, and meaningless after a restart.
 */
import { createHash, randomBytes } from "node:crypto";

/** The prefix that marks this credential. `mdt_` authenticates on `/mail-draft/*` and nowhere else. */
const TURN_TOKEN_PREFIX = "mdt_";
/** 32 random bytes, hex. */
const TOKEN_BYTES = 32;
/**
 * `bridge.mjs`'s own fallback for a turn's timeout, copied so a token minted here never expires before
 * the turn it belongs to can: `scripts/pi-bots/bridge.mjs` has
 * `const TURN_TIMEOUT_MS = Number(process.env.PIBOT_TURN_TIMEOUT_MS || 600000);`
 */
const DEFAULT_TURN_TIMEOUT_MS = 600_000;
/** The margin on top of the turn's timeout (plan 3, review 2 should-fix S2). */
export const TURN_TOKEN_MARGIN_MS = 60_000;

/**
 * Live tokens: `sha256(token)` hex → the claims it was minted for. Module memory, never a file.
 * @type {Map<string, {draftId: string, turnId: string, botId: string, startHash: string, expiresAt: number}>}
 */
const turnTokens = new Map();

function sha256Hex(text) {
  return createHash("sha256").update(text).digest("hex");
}

function requireText(value, field) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`mintTurnToken needs a ${field}`);
  }
  return value.trim();
}

/** Drop every entry whose expiry has passed, so a long-lived process does not accumulate them. */
function sweep(now) {
  for (const [key, entry] of turnTokens) {
    if (now >= entry.expiresAt) turnTokens.delete(key);
  }
}

/**
 * How long a minted token lives: the drafting turn's `PIBOT_TURN_TIMEOUT_MS` (the same default
 * bridge.mjs uses) plus a 60 s margin. An unreadable value falls back to the default rather than
 * minting a token that expires at once.
 *
 * @param {NodeJS.ProcessEnv} [env]
 * @returns {number} milliseconds
 */
export function turnTokenTtlMs(env = process.env) {
  const raw = Number(env?.PIBOT_TURN_TIMEOUT_MS || DEFAULT_TURN_TIMEOUT_MS);
  const turnTimeout = Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_TURN_TIMEOUT_MS;
  return turnTimeout + TURN_TOKEN_MARGIN_MS;
}

/**
 * Mint one turn's token. Returns the raw value (the only copy of it that exists) and stores nothing but
 * its hash.
 *
 * @param {{draftId: string, turnId: string, botId: string, startHash: string,
 *   ttlMs?: number}} fields `startHash` is the draft's head hash when the turn started, `botId` the
 *   bot the turn runs as, `ttlMs` the turn's own timeout plus the margin (defaulted here when a caller
 *   has none)
 * @returns {string} the bearer token, `mdt_` + 32 random bytes as hex
 */
export function mintTurnToken({ draftId, turnId, botId, startHash, ttlMs } = {}) {
  const draft = requireText(draftId, "draftId");
  const turn = requireText(turnId, "turnId");
  const bot = requireText(botId, "botId");
  const head = requireText(startHash, "startHash");
  const ttl = Number.isFinite(ttlMs) && ttlMs >= 0 ? Number(ttlMs) : turnTokenTtlMs();
  const now = Date.now();
  sweep(now);
  const token = TURN_TOKEN_PREFIX + randomBytes(TOKEN_BYTES).toString("hex");
  turnTokens.set(sha256Hex(token), { draftId: draft, turnId: turn, botId: bot, startHash: head, expiresAt: now + ttl });
  return token;
}

/**
 * Revoke one token — the turn's `finally`. Answers whether a live token was there to revoke; an
 * already-expired, already-revoked or never-minted token changes nothing.
 *
 * @param {string} token
 * @returns {boolean}
 */
export function revokeTurnToken(token) {
  if (typeof token !== "string" || !token.startsWith(TURN_TOKEN_PREFIX)) return false;
  return turnTokens.delete(sha256Hex(token));
}

/**
 * The claims a presented token stands for, or null when it is unknown, expired or revoked. The lookup
 * is by the hash of the exact string, so a token with one character changed is simply not in the map.
 *
 * @param {string} token
 * @returns {{draftId: string, turnId: string, botId: string, startHash: string, expiresAt: number}|null}
 */
export function verifyTurnToken(token) {
  if (typeof token !== "string" || !token.startsWith(TURN_TOKEN_PREFIX)) return null;
  const key = sha256Hex(token);
  const entry = turnTokens.get(key);
  if (!entry) return null;
  if (Date.now() >= entry.expiresAt) {
    turnTokens.delete(key);
    return null;
  }
  return {
    draftId: entry.draftId,
    turnId: entry.turnId,
    botId: entry.botId,
    startHash: entry.startHash,
    expiresAt: entry.expiresAt,
  };
}

/** Test seam only: forget every minted token (module state is per process, like a restart). */
export function _resetTurnTokensForTests() {
  turnTokens.clear();
}