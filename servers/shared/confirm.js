/**
 * Confirmation token system for destructive actions.
 *
 * Tools return a preview + token on first call; the caller must
 * pass the token back to execute. Tokens are single-use and expire
 * after 60 seconds.
 *
 * A token may also commit to a caller-supplied fingerprint (see
 * generateToken): the blog server binds its publish/delete confirms to the
 * state the preview showed, so a row edited in between refuses the confirm
 * instead of acting on something the operator never saw.
 *
 * Set CROW_SKIP_CONFIRM_GATES=1 to bypass (for Claude Code users
 * where behavioral safety-guardrails.md already works).
 */

import { randomBytes } from "node:crypto";

const tokens = new Map(); // token → { action, itemId, fingerprint, expires }
const TTL_MS = 60_000;

/** A fingerprint as stored: absent means "no state bound", and must match an absent one. */
const fingerprintOf = (fingerprint) =>
  (fingerprint === undefined || fingerprint === null ? null : String(fingerprint));

/**
 * Mint a single-use token for an action on an item.
 *
 * `fingerprint` is optional and opaque: a caller that passes one (the blog server passes a hash of
 * the row's state) gets a token that only validates against that same value, so a row that changed
 * between the preview and the confirm no longer matches it. Callers that pass nothing keep the old
 * token-versus-item-id behaviour exactly.
 */
export function generateToken(action, itemId, fingerprint = null) {
  const token = randomBytes(12).toString("base64url");
  tokens.set(token, {
    action,
    itemId: String(itemId),
    fingerprint: fingerprintOf(fingerprint),
    expires: Date.now() + TTL_MS,
  });
  return token;
}

/**
 * Consume a token and say whether it is the one minted for this action, item and fingerprint.
 *
 * The fingerprint must be passed exactly as it was minted: a token minted with one does not validate
 * without one (`null` is the "none bound" value), and vice versa.
 */
export function validateToken(token, action, itemId, fingerprint = null) {
  const entry = tokens.get(token);
  if (!entry) return false;
  tokens.delete(token);
  if (Date.now() > entry.expires) return false;
  return entry.action === action
    && entry.itemId === String(itemId)
    && entry.fingerprint === fingerprintOf(fingerprint);
}

/**
 * What a token was minted for, without consuming it — `null` for an unknown or expired token.
 *
 * This exists so a caller can tell WHICH way a confirm failed: `validateToken` answers only "no",
 * and "the row changed since the preview" deserves a different (fixed) answer than "bad or expired
 * token". Use it before `validateToken`, which still consumes the token, so single-use holds.
 */
export function peekToken(token) {
  const entry = tokens.get(token);
  if (!entry || Date.now() > entry.expires) return null;
  return Object.freeze({
    action: entry.action,
    itemId: entry.itemId,
    fingerprint: entry.fingerprint,
  });
}

export function shouldSkipGates() {
  return process.env.CROW_SKIP_CONFIRM_GATES === "1";
}
