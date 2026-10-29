/**
 * Session displays: the dashboard's Talk to Crow overlay. A logged-in dashboard
 * user talks through the kiosk page without pairing; these are the pure pieces
 * (what the display is called, is the WebSocket
 * handshake from this origin). The auth itself is the gateway's own dashboard
 * session + CSRF cookie, injected into runtime.js — no token is minted here.
 */
import { createHash } from "node:crypto";

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
 * True for an in-memory session display (the dashboard's Talk to Crow on a phone or a laptop),
 * false for a paired display: the turn's surface is "phone" for the first and "kiosk" for the second.
 */
export const isSessionDisplayId = (id) => typeof id === "string" && id.startsWith("dash-");

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
