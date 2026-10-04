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

/**
 * The assistant a session display talks to: the one chosen in the Kiosk panel
 * when it is still enabled, else the first enabled assistant by id — the same
 * default the bot board opens on. null when no assistant is enabled.
 */
export async function resolveSessionBot(db, { readSetting }) {
  let chosen = "";
  try { chosen = String((await readSetting(db, SESSION_BOT_SETTING)) || ""); } catch { chosen = ""; }
  if (chosen) {
    const row = (await db.execute({ sql: "SELECT bot_id FROM pi_bot_defs WHERE bot_id = ? AND enabled = 1", args: [chosen] })).rows[0];
    if (row) return String(row.bot_id);
  }
  const first = (await db.execute({ sql: "SELECT bot_id FROM pi_bot_defs WHERE enabled = 1 ORDER BY bot_id LIMIT 1", args: [] })).rows[0];
  return first ? String(first.bot_id) : null;
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
