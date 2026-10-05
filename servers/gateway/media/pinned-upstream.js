/**
 * Fetching audio from the instance's own music server WITH its credential, under one rule.
 * Used wherever the gateway itself fetches a library stream on a device's behalf.
 *
 *  1. First hop: only the configured server origin (scheme, host AND port) and only the
 *     listen path shape. The credential is attached here and nowhere else.
 *  2. Redirects are followed by hand, at most ONE. Its target must be the configured storage
 *     origin; with none configured, a host that resolves only to addresses the music server's
 *     own host resolves to (object storage beside the server). Anything else is refused.
 *  3. The credential never crosses a redirect: the second request carries no Authorization
 *     header, whatever the target (so an https→http redirect cannot leak it either).
 *  4. Ten seconds to response headers on each hop.
 *
 * Nothing here trusts its caller's URL: a URL that fails rule 1 is never requested at all.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { lookup as dnsLookup } from "node:dns/promises";
import { resolveCrowHome } from "../../shared/crow-home.js";

export const LISTEN_PATH = /^\/api\/v1\/listen\/[0-9a-fA-F-]{8,64}\/$/;
export const STREAM_CODECS = Object.freeze(["mp3", "ogg", "opus", "aac", "flac"]);
export const HEADERS_TIMEOUT_MS = 10_000;

export class UpstreamRefused extends Error {
  constructor(code, message) { super(message || code); this.name = "UpstreamRefused"; this.code = code; }
}

/** "scheme://host:port" for an http(s) URL (default ports dropped, as URL.origin gives it), else null. */
export function originOf(u) {
  try {
    const x = new URL(String(u));
    return x.protocol === "http:" || x.protocol === "https:" ? x.origin : null;
  } catch { return null; }
}

/**
 * The music server's address and credential: the Funkwhale add-on's own entry in
 * <crow-home>/mcp-addons.json, else the gateway's environment. → { origin, token, storageOrigin } | null
 */
export function musicUpstreamConfig({ crowHome = resolveCrowHome(), env = process.env } = {}) {
  let e = {};
  try {
    const cfg = JSON.parse(readFileSync(join(crowHome, "mcp-addons.json"), "utf8"));
    e = cfg?.funkwhale?.env || {};
  } catch { /* not installed or unreadable */ }
  const url = e.FUNKWHALE_URL || env.FUNKWHALE_URL;
  const token = e.FUNKWHALE_ACCESS_TOKEN || env.FUNKWHALE_ACCESS_TOKEN;
  const origin = originOf(url);
  if (!origin || !token) return null;
  const storage = e.FUNKWHALE_STORAGE_ORIGIN || env.FUNKWHALE_STORAGE_ORIGIN;
  return { origin, token: String(token), storageOrigin: storage ? originOf(storage) : null };
}

/** Rule 1 as a pure check. → null when the URL may be requested with the credential, else a refusal code. */
export function firstHopRefusal(url, cfg) {
  if (!cfg || !cfg.origin || !cfg.token) return "not_configured";
  let u;
  try { u = new URL(String(url)); } catch { return "bad_url"; }
  if (u.origin !== cfg.origin) return "wrong_origin";
  if (u.username || u.password) return "bad_url";
  if (!LISTEN_PATH.test(u.pathname)) return "wrong_path";
  for (const [k, v] of u.searchParams) {
    if (k !== "to" || !STREAM_CODECS.includes(v)) return "wrong_query";
  }
  return null;
}

async function addressesOf(host, lookup) {
  const h = host.replace(/^\[|\]$/g, "");
  const list = await lookup(h, { all: true });
  return new Set(list.map((a) => a.address));
}

/** Rule 2 as a check. → null when the redirect may be followed (without the credential), else a refusal code. */
export async function redirectRefusal(target, cfg, { lookup = dnsLookup } = {}) {
  let t;
  try { t = new URL(String(target)); } catch { return "bad_redirect"; }
  if (t.protocol !== "http:" && t.protocol !== "https:") return "bad_redirect";
  if (cfg.storageOrigin) return t.origin === cfg.storageOrigin ? null : "redirect_not_storage";
  try {
    const own = await addressesOf(new URL(cfg.origin).hostname, lookup);
    const theirs = await addressesOf(t.hostname, lookup);
    if (theirs.size === 0) return "redirect_unresolved";
    for (const a of theirs) if (!own.has(a)) return "redirect_not_storage";
    return null;
  } catch { return "redirect_unresolved"; }
}

function withTimeout(signal, ms) {
  const t = AbortSignal.timeout(ms);
  return signal ? AbortSignal.any([signal, t]) : t;
}

/**
 * Open a library stream. → the upstream Response (2xx, body unread).
 * Throws UpstreamRefused(code) for anything the rules refuse, and for a non-2xx answer
 * (code "http_<status>"). `range` is passed through on both hops.
 */
export async function openPinnedUpstream(url, cfg, { fetchImpl = fetch, lookup = dnsLookup, signal, range } = {}) {
  const refused = firstHopRefusal(url, cfg);
  if (refused) throw new UpstreamRefused(refused);
  const extra = range ? { Range: String(range) } : {};
  let resp = await fetchImpl(String(url), {
    redirect: "manual", signal: withTimeout(signal, HEADERS_TIMEOUT_MS),
    headers: { ...extra, Authorization: `Bearer ${cfg.token}` },
  });
  if (resp.status >= 300 && resp.status < 400) {
    const loc = resp.headers.get("location");
    try { await resp.body?.cancel(); } catch { /* nothing to release */ }
    if (!loc) throw new UpstreamRefused("redirect_no_location");
    const target = new URL(loc, String(url));
    const why = await redirectRefusal(target, cfg, { lookup });
    if (why) throw new UpstreamRefused(why);
    // No Authorization header on this hop, by construction.
    resp = await fetchImpl(target.toString(), { redirect: "manual", signal: withTimeout(signal, HEADERS_TIMEOUT_MS), headers: { ...extra } });
    if (resp.status >= 300 && resp.status < 400) {
      try { await resp.body?.cancel(); } catch { /* nothing to release */ }
      throw new UpstreamRefused("too_many_redirects");
    }
  }
  if (!resp.ok || !resp.body) {
    try { await resp.body?.cancel(); } catch { /* nothing to release */ }
    throw new UpstreamRefused(`http_${resp.status}`);
  }
  return resp;
}
