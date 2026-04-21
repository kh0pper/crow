/**
 * Confirmation token system for destructive actions.
 *
 * Tools return a preview + token on first call; the caller must
 * pass the token back to execute. Tokens are single-use and expire
 * after 60 seconds.
 *
 * Set CROW_SKIP_CONFIRM_GATES=1 to bypass.
 */

import { randomBytes } from "node:crypto";

const tokens = new Map();
const TTL_MS = 60_000;

export function generateToken(action, itemId) {
  const token = randomBytes(12).toString("base64url");
  tokens.set(token, { action, itemId: String(itemId), expires: Date.now() + TTL_MS });
  return token;
}

export function validateToken(token, action, itemId) {
  const entry = tokens.get(token);
  if (!entry) return false;
  tokens.delete(token);
  if (Date.now() > entry.expires) return false;
  return entry.action === action && entry.itemId === String(itemId);
}

export function shouldSkipGates() {
  return process.env.CROW_SKIP_CONFIRM_GATES === "1";
}
