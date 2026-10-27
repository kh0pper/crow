/**
 * Per-device mode: each device remembers "new" or "classic" in a cookie.
 * A device whose dashboard session predates the shell's first boot opens
 * classic (with an offer to try new); everything else opens new.
 */
import { createHash } from "node:crypto";
import { readLocalInstanceIdOrNull, resolveInstanceDataDir } from "../../../shared/crow-home.js";
import { hashToken, cookieSecureSuffix } from "../auth.js";
import { readSetting, writeSetting } from "../settings/registry.js";

export const MODE_COOKIE = "crow_mode";
export const TRY_COOKIE = "crow_try_new";
export const SCOPE_COOKIE = "crow_scope";

const MODE_MAX_AGE = 400 * 24 * 60 * 60; // seconds

// Memo of the suffix per data dir: the instance id is a file, and every
// dashboard request needs these names, so it is read once, not per request.
// The memo is per process and lasts until restart (an instance id that
// changes underneath a running gateway is picked up only after a restart).
// Only a found id is remembered: before the gateway first writes it, the
// next call looks again.
const suffixByDataDir = new Map();

/** Per-instance cookie name, so co-hosted gateways never read each other's. */
export function cookieName(base, env = process.env) {
  const key = resolveInstanceDataDir(env);
  let suffix = suffixByDataDir.get(key);
  if (!suffix) {
    const id = readLocalInstanceIdOrNull(env);
    if (id) {
      suffix = createHash("sha256").update(id).digest("hex").slice(0, 8);
      suffixByDataDir.set(key, suffix);
    } else {
      suffix = "local";
    }
  }
  return `${base}_${suffix}`;
}

/** SQLite datetime('now') is UTC "YYYY-MM-DD HH:MM:SS"; parse it as UTC. */
function toDate(v) {
  if (!v) return null;
  const s = String(v).trim();
  const d = new Date(/^\d{4}-\d{2}-\d{2} \d/.test(s) ? `${s.replace(" ", "T")}Z` : s);
  return Number.isNaN(d.getTime()) ? null : d;
}

export function resolveDeviceMode({ cookieMode, sessionCreatedAt, shellSince } = {}) {
  if (cookieMode === "new" || cookieMode === "classic") {
    return { mode: cookieMode, offerTry: false, persist: false };
  }
  const created = toDate(sessionCreatedAt);
  const since = toDate(shellSince);
  if (created && since && created < since) {
    return { mode: "classic", offerTry: true, persist: true };
  }
  return { mode: "new", offerTry: false, persist: true };
}

/** crow_try_new: pending (card shows), dismissed ("Not now") or used (switched to new). Same lifetime as the mode cookie. */
export function tryCookie(value) {
  return `${cookieName(TRY_COOKIE)}=${value}; Path=/; Max-Age=${MODE_MAX_AGE}; SameSite=Lax; HttpOnly${cookieSecureSuffix()}`;
}

export function modeCookie(mode) {
  return `${cookieName(MODE_COOKIE)}=${mode}; Path=/; Max-Age=${MODE_MAX_AGE}; SameSite=Lax${cookieSecureSuffix()}`;
}

/**
 * Write shell_since (UTC) once, when empty; return the stored value. The key is
 * on neither settings list, so writeSetting lands it as a local override.
 */
export async function stampShellSince(db) {
  const existing = await readSetting(db, "shell_since");
  if (existing) return existing;
  const now = (await db.execute("SELECT datetime('now') AS t")).rows[0].t;
  await writeSetting(db, "shell_since", now);
  return (await readSetting(db, "shell_since")) || now;
}

/** For the dispatch (Task 2.3): stamp lazily if boot has not, then return it. */
export async function ensureShellSince(db) {
  return (await readSetting(db, "shell_since")) || stampShellSince(db);
}

export async function sessionCreatedAt(db, token) {
  if (!token) return null;
  const r = await db.execute({
    sql: "SELECT created_at FROM oauth_tokens WHERE token = ? AND client_id = 'dashboard'",
    args: [hashToken(token)],
  });
  return r.rows[0]?.created_at ?? null;
}
