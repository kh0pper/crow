/**
 * Session displays: the dashboard's Talk to Crow overlay. A logged-in dashboard
 * user talks through the kiosk page without pairing; these are the pure pieces
 * (which assistant answers, what the display is called, is the WebSocket
 * handshake from this origin). The auth itself is the gateway's own dashboard
 * session + CSRF cookie, injected into runtime.js — no token is minted here.
 */
import { createHash } from "node:crypto";

/** Local-scope setting: the assistant chosen in the Kiosk panel ("" = automatic). */
export const SESSION_BOT_SETTING = "kiosk_dashboard_bot_id";

/**
 * In-memory id of a session display: a domain-separated hash of the dashboard
 * session token. Stable for one login (a reconnect keeps its windows and
 * conversation; a second overlay on the same login supersedes the first),
 * different per login, and never a paired display's id ("kiosk-…").
 */
export function sessionDisplayId(sessionToken) {
  return "dash-" + createHash("sha256").update("crow-kiosk-session-display-v1:" + String(sessionToken)).digest("hex").slice(0, 16);
}

/** The reserved Crow voice bot's id (core's CROW_VOICE_BOT_ID; this pure module cannot import core). */
export const RESERVED_VOICE_BOT_ID = "crow.voice";

/**
 * True for an in-memory session display (the dashboard's Talk to Crow on a phone or a laptop),
 * false for a paired display: the turn's surface is "phone" for the first and "kiosk" for the second.
 */
export const isSessionDisplayId = (id) => typeof id === "string" && id.startsWith("dash-");

/**
 * No longer who answers: every session display answers as the Crow voice bot (runtime.js
 * sessionBot). Kept for the evaluation harness (and the Kiosk listing's auto_bot_id while that
 * listing still has its dashboard_voice block); it never returns a voice bot.
 *
 * The bot the old rule picks: the one chosen in the Kiosk panel when it is still enabled, else
 * ("Automatic") the first enabled assistant by id, the same default the bot board opens on. null
 * when there is none. A voice bot is never picked, neither as the explicit choice nor by Automatic:
 * `isVoiceBotId` is core's test when the caller injects it, else a match on the literal reserved id.
 *
 * fitOf(botId) → "full" | "no_skills" | "too_large" | null (the bundle's fit check, fit.js) makes
 * Automatic fit-aware: the first assistant whose prompt fits the quick voice model in full (or whose
 * fit is unknown), else the first that works without its skills; never one that is too large.
 * Without fitOf the choice is the plain first enabled assistant. An explicit choice is kept even
 * when it no longer fits.
 */
export async function resolveSessionBot(db, { readSetting }, fitOf = null, { isVoiceBotId = (id) => id === RESERVED_VOICE_BOT_ID } = {}) {
  const isVoice = (id) => { try { return isVoiceBotId(id) === true; } catch { return true; } };
  let chosen = "";
  try { chosen = String((await readSetting(db, SESSION_BOT_SETTING)) || ""); } catch { chosen = ""; }
  if (chosen && !isVoice(chosen)) {
    const row = (await db.execute({ sql: "SELECT bot_id FROM pi_bot_defs WHERE bot_id = ? AND enabled = 1", args: [chosen] })).rows[0];
    if (row) return String(row.bot_id);
  }
  const ids = (await db.execute({ sql: "SELECT bot_id FROM pi_bot_defs WHERE enabled = 1 ORDER BY bot_id", args: [] })).rows.map((r) => String(r.bot_id)).filter((id) => !isVoice(id));
  if (!fitOf) return ids[0] ?? null;
  let lean = null;
  for (const id of ids) {
    const level = await fitOf(id);
    if (level === "too_large") continue;
    if (level !== "no_skills") return id;
    lean ??= id;
  }
  return lean;
}

const hostOf = (v) => String(v || "").split(",")[0].trim().toLowerCase();

/**
 * Cross-site WebSocket hijacking guard for the session socket (browsers attach
 * cookies to a WebSocket handshake whatever page opened it, subject only to
 * SameSite). A browser cannot forge either header from page script:
 *   - Sec-Fetch-Site, when the browser sends it, must be "same-origin";
 *   - otherwise Origin must be present and name this host — the Host header,
 *     or X-Forwarded-Host when a reverse proxy rewrote Host.
 */
export function sameOriginUpgrade(req) {
  const h = req?.headers || {};
  const site = h["sec-fetch-site"];
  if (site !== undefined && String(site).toLowerCase() !== "same-origin") return false;
  let originHost = "";
  try { originHost = new URL(String(h.origin || "")).host.toLowerCase(); } catch { originHost = ""; }
  if (!originHost) return false;
  return originHost === hostOf(h.host) || (!!h["x-forwarded-host"] && originHost === hostOf(h["x-forwarded-host"]));
}
