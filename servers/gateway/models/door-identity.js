// servers/gateway/models/door-identity.js
/**
 * Who is calling the model door? One classifier for POST /llm/v1/*,
 * POST /llm/p/<provider>/v1/* and POST /llm/acquire (the satellite-exposure
 * work, phase A1), plus the SHADOW census that says whose calls would stop
 * working once the door requires a Crow credential.
 *
 * The door's source rule (models/door-resolve.js isTrustedDoorRequest) admits
 * any loopback or tailnet source with no credential at all, and any source
 * holding the local MCP token or the models token. This module names WHY such a
 * caller is at the door:
 *
 *   loopback      a direct loopback socket with no forwarding and no
 *                 tailscale-* header (a voice device, r4, the bots) — always
 *                 admitted, and no credential is ever read for it;
 *   local-token   the bearer is this instance's local MCP token or its models
 *                 token (exactly what the door's own bearer check accepts);
 *   peer-token    the bearer validates via validateInstanceToken against a
 *                 trusted, non-revoked crow_instances row (a paired instance
 *                 using its per-peer token, never synced); `instanceId` names
 *                 which;
 *   owner-login   a Tailscale Serve-forwarded request whose
 *                 Tailscale-User-Login is the owner's login
 *                 (CROW_OWNER_TAILNET_LOGIN) — the dashboard/kiosk path. Serve
 *                 forwards from loopback, so the login counts ONLY when
 *                 servers/shared/peer-class.js verified the Serve socket owner
 *                 (`via: "serve"`); a bare header buys nothing. With the env
 *                 var unset this class never matches (fail closed);
 *   unidentified  everything else the current rule lets in on its address
 *                 alone: a tailnet source with no valid credential, a
 *                 Serve-forwarded request with a non-owner login, a loopback
 *                 socket relaying an unproven client.
 *
 * NOTHING here decides access by itself. The route computes the class, keeps
 * exactly the allow/deny answer it had before, and records a "would refuse"
 * event when the answer was YES and the class is `unidentified`. Only with
 * CROW_LLM_DOOR_ENFORCE=1 does an unidentified caller actually get a 401.
 *
 * Rails, all load-bearing:
 *  - credentials are looked up LAZILY: a loopback caller and a caller with no
 *    bearer never touch the DB, and a `loopback` classification never reads the
 *    Authorization header at all;
 *  - in shadow mode a credential verdict is memoised per sha256(token) for
 *    CREDENTIAL_MEMO_MS (bounded map), so one caller's stream of requests is
 *    one lookup. The memo is OFF while CROW_LLM_DOOR_ENFORCE=1, so a revoked
 *    peer token stops working on the next request;
 *  - the census/ring logs never carry a token, a body, `req.ip` or a raw header
 *    value: only an address that parses (64 chars max), the tailnet login
 *    tailscaled asserted, one of the fixed route labels (DOOR_ROUTES) and a
 *    model id this instance's providers know (else "other");
 *  - the ring and the per-key dedupe map are bounded, so a spray of spoofed
 *    sources cannot grow memory. At most one event per (class, source, route)
 *    per DOOR_SHADOW_WINDOW_MS, where `route` is one of the FIXED labels in
 *    DOOR_ROUTES (never the caller's path: /llm/v1/<random> must not mint a
 *    key or push a real entry out of the ring);
 *  - no DB write, no setting, no counter file.
 *
 * Pure Node + servers/shared/peer-class.js: importable from the health signals
 * without dragging in the router, the DB or the instance registry.
 */
import { createHash } from "node:crypto";
import { isIP } from "node:net";
import { classifyPeer, forwardedAddrs, isLocalPeer, normalizeAddr } from "../../shared/peer-class.js";

/** The five classes. Strings on purpose: they are logged and summarised. */
export const DOOR_CLASS = Object.freeze({
  LOOPBACK: "loopback",
  LOCAL_TOKEN: "local-token",
  PEER_TOKEN: "peer-token",
  OWNER_LOGIN: "owner-login",
  UNIDENTIFIED: "unidentified",
});

/** The owner's tailnet login (Serve's Tailscale-User-Login for the owner).
 *  Unset is "not set": `owner-login` then never matches, so nobody is admitted
 *  on a header alone. */
export const OWNER_LOGIN_ENV = "CROW_OWNER_TAILNET_LOGIN";
/** The enforcement switch. Anything but "1" leaves today's behaviour alone. */
export const ENFORCE_ENV = "CROW_LLM_DOOR_ENFORCE";

/** The owner's tailnet login, trimmed and bounded, or null when not set. */
export function ownerTailnetLogin(env = process.env) {
  const raw = env ? env[OWNER_LOGIN_ENV] : undefined;
  const v = typeof raw === "string" ? raw.trim() : "";
  return v ? v.slice(0, 200) : null;
}

/** Is the door's identity rule enforcing? Default OFF: only "1" turns it on. */
export function doorEnforceOn(env = process.env) {
  const raw = env ? env[ENFORCE_ENV] : undefined;
  return String(raw ?? "").trim() === "1";
}

const LOGIN_MAX = 200;
const ADDR_MAX = 64;
const ROUTE_MAX = 24;
const MODEL_MAX = 80;

/** The ONLY route labels the census keeps — one per door (v1, p, acquire). Any
 *  other value collapses to "other" in the dedupe key, the ring and the line:
 *  the path is caller-chosen, so left as-is a request to /llm/v1/<random> or
 *  /llm/p/<random>/… would mint a fresh key + log line per request and push a
 *  real source out of the ring. */
export const DOOR_ROUTES = Object.freeze(["v1", "p", "acquire"]);
export const DOOR_ROUTE_OTHER = "other";

/** One route label, from the fixed set (anything else is "other"). */
export function doorRouteLabel(route) {
  const v = String(route ?? "").trim();
  return DOOR_ROUTES.includes(v) ? v : DOOR_ROUTE_OTHER;
}

/** The bearer token on a request, or null. Never logged, never returned to a
 *  caller outside this module's own verdict. */
function bearerToken(headers) {
  const h = headers && headers.authorization;
  const v = Array.isArray(h) ? h[0] : h;
  if (typeof v !== "string" || !v.startsWith("Bearer ")) return null;
  const token = v.slice(7);
  return token ? token : null;
}

/** The peer classifier's answer for this request: the gateway's own
 *  req.crowPeer when resolveClientMiddleware already ran, else classifyPeer
 *  itself (same module, same answer). Never throws. */
function peerOf(req, deps) {
  const attached = req && req.crowPeer;
  if (attached && typeof attached === "object") return attached;
  const fn = deps.classifyPeerFn || classifyPeer;
  try {
    const p = fn(req);
    return p && typeof p === "object" ? p : null;
  } catch {
    return null;
  }
}

/** The address to name for this caller: the one the peer classifier vouched
 *  for (Serve's client, Caddy's client, a direct socket), else — for a loopback
 *  socket relaying something the classifier could not verify — the first
 *  forwarded address, so a relayed LAN client is named as the LAN client and
 *  never as 127.0.0.1. Used for the census line and the summary, never for a
 *  decision. */
function sourceOf(req, socketAddr, peer) {
  const client = peer && typeof peer.client === "string" && peer.client ? peer.client : "";
  const via = peer && typeof peer.via === "string" ? peer.via : "";
  if (via === "serve" || via === "proxy" || via === "funnel" || via === "direct") return client || socketAddr || "";
  let first = null;
  try {
    first = forwardedAddrs((req && req.headers) || {}).find((a) => a !== null) || null;
  } catch {
    first = null;
  }
  return first || client || socketAddr || "";
}

/**
 * Classify one door request.
 *
 * @param {object} req  an Express request (or a plain { socket, headers, crowPeer })
 * @param {object} [deps]
 * @param {(req: object) => string} [deps.remoteAddressFn]  the TCP peer address
 * @param {(req: object) => object|null} [deps.classifyPeerFn]  peer classifier override
 * @param {(token: string) => Promise<boolean>} [deps.localTokenFn]  local MCP token OR models token
 * @param {(token: string) => Promise<object|null>} [deps.peerTokenFn]  a trusted, non-revoked crow_instances row
 * @param {string|null} [deps.ownerLogin]  override for CROW_OWNER_TAILNET_LOGIN
 * @param {() => number} [deps.nowFn]  injectable clock (the memo)
 * @param {boolean} [deps.memoize]  false while the door enforces (see below)
 * @returns {Promise<{cls: string, source: string, login: string|null, instanceId: string|null, via: string|null}>}
 */
export async function classifyDoorCaller(req, deps = {}) {
  const headers = (req && req.headers) || {};
  const remoteAddressFn = deps.remoteAddressFn || ((r) => (r && r.socket ? r.socket.remoteAddress : "") || "");
  let socketAddr = "";
  try { socketAddr = String(remoteAddressFn(req) || ""); } catch { socketAddr = ""; }
  const peer = peerOf(req, deps);
  const source = sourceOf(req, socketAddr, peer);
  // Only a Serve-verified request has an asserted login (peer-class.js withholds
  // it for every other class, and a client-supplied header is never one).
  const login = peer && peer.via === "serve" && typeof peer.tailnetLogin === "string" && peer.tailnetLogin
    ? peer.tailnetLogin
    : null;
  const out = {
    cls: DOOR_CLASS.UNIDENTIFIED,
    source,
    login,
    instanceId: null,
    via: peer && typeof peer.via === "string" ? peer.via : null,
  };

  // 1. A direct loopback socket with no forwarding and no tailscale-* header:
  //    unchanged, always admitted, and the bearer is never even read.
  if (isLocalPeer(socketAddr, headers)) {
    out.cls = DOOR_CLASS.LOOPBACK;
    out.login = null;
    return out;
  }

  // 2. The owner, through Serve: tailscaled asserted this login on a verified
  //    Serve socket. With no owner login configured the class never matches.
  const owner = deps.ownerLogin !== undefined ? deps.ownerLogin : ownerTailnetLogin();
  if (login && owner && login.toLowerCase() === String(owner).trim().toLowerCase()) {
    out.cls = DOOR_CLASS.OWNER_LOGIN;
    return out;
  }

  // 3. A credential: exactly what the door's own bearer check accepts first
  //    (local/models token), then a paired instance's per-peer token.
  const token = bearerToken(headers);
  if (!token) return out;
  const verdict = await credentialClass(token, deps);
  if (verdict) {
    out.cls = verdict.cls;
    out.instanceId = verdict.instanceId || null;
  }
  return out;
}

// ---- credential classification (lazy, and memoised in shadow mode only) -----

/** How long one token's SHADOW verdict is reused. Only the class is cached, never
 *  the token, and never while the door enforces: a revocation must land on the
 *  next request there. */
export const CREDENTIAL_MEMO_MS = 60 * 1000;
export const CREDENTIAL_MEMO_MAX = 256;
const credentialMemo = new Map(); // sha256(token) -> { at, verdict }

/** Test seam: forget every memoised credential verdict. */
export function resetDoorCredentialMemo() { credentialMemo.clear(); }

function nowOf(deps) {
  try {
    const n = deps.nowFn ? deps.nowFn() : Date.now();
    return Number.isFinite(n) ? n : Date.now();
  } catch {
    return Date.now();
  }
}

/** The class one bearer earns: `local-token`, `peer-token`, or null. A resolver
 *  that throws proves nothing (and never a credential). */
async function resolveCredential(token, deps) {
  if (deps.localTokenFn) {
    try {
      if (await deps.localTokenFn(token)) return { cls: DOOR_CLASS.LOCAL_TOKEN, instanceId: null };
    } catch { /* a failed check is not a credential */ }
  }
  if (deps.peerTokenFn) {
    try {
      const row = await deps.peerTokenFn(token);
      if (row) return { cls: DOOR_CLASS.PEER_TOKEN, instanceId: row.id ? String(row.id) : null };
    } catch { /* a failed lookup is not a credential */ }
  }
  return null;
}

async function credentialClass(token, deps) {
  const memoize = deps.memoize !== false;
  if (!memoize) return resolveCredential(token, deps);
  const hash = createHash("sha256").update(String(token)).digest("hex");
  const now = nowOf(deps);
  const hit = credentialMemo.get(hash);
  if (hit && now - hit.at < CREDENTIAL_MEMO_MS) return hit.verdict;
  const verdict = await resolveCredential(token, deps);
  credentialMemo.delete(hash);
  credentialMemo.set(hash, { at: now, verdict });
  while (credentialMemo.size > CREDENTIAL_MEMO_MAX) credentialMemo.delete(credentialMemo.keys().next().value);
  return verdict;
}

// ---- the shadow census (bounded, deduped, token-free) ----------------------

/** One event per (class, source, route) per window. */
export const DOOR_SHADOW_WINDOW_MS = 10 * 60 * 1000;
/** Cap on the dedupe map and on the ring the summary reads. */
export const DOOR_SHADOW_MAX_KEYS = 256;
export const DOOR_SHADOW_RING = 512;
/** The summary's window (the health strip says "in the last 24 h"). */
export const DOOR_SHADOW_SUMMARY_MS = 24 * 60 * 60 * 1000;

const shadowSeen = new Map(); // "<cls> <source> <route label>" -> last recorded at, ms
const shadowRing = [];        // { at, cls, source, login, route, model, enforced }

/** Test seams. */
export function doorShadowKeyCount() { return shadowSeen.size; }
export function doorShadowRingSize() { return shadowRing.length; }
export function resetDoorShadow() { shadowSeen.clear(); shadowRing.length = 0; }

/** A printable, bounded address: the value only when it really is an address
 *  (an IPv6 zone id — caller-chosen text — is cut off first). Anything else is
 *  "unknown": a forwarded value can be an obfuscated token. */
function printableSource(source) {
  const bare = String(normalizeAddr(source ?? "") ?? "").replace(/%.*$/, "");
  if (!bare || isIP(bare) === 0) return "unknown";
  return bare.slice(0, ADDR_MAX);
}

/** Printable, bounded copy of an untrusted string (control characters -> "?"). */
function printable(s, max) {
  return String(s ?? "").replace(/[^\x20-\x7e]/g, "?").slice(0, max);
}

/**
 * Record one "this caller has no Crow credential" event — a would-refuse in
 * shadow mode, a real refusal once CROW_LLM_DOOR_ENFORCE=1. Bounded and
 * deduped; never throws (a logger that throws must not change the door's
 * answer). Returns true when it recorded and logged.
 *
 * @param {{cls?: string, source?: string, login?: string|null, route?: string,
 *          model?: string|null, enforced?: boolean}} event  `route` must be one of
 *          DOOR_ROUTES; anything else is recorded as "other".
 * @param {number} [nowMs]
 * @param {(line: string) => void} [logFn]
 */
export function recordDoorShadow(event, nowMs = Date.now(), logFn = console.log) {
  try {
    const cls = event && typeof event.cls === "string" && event.cls ? event.cls : DOOR_CLASS.UNIDENTIFIED;
    const source = printableSource(event && event.source);
    const route = doorRouteLabel(printable(event && event.route, ROUTE_MAX));
    const key = `${cls} ${source} ${route}`;
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    const last = shadowSeen.get(key);
    if (last !== undefined && now - last < DOOR_SHADOW_WINDOW_MS) return false;
    shadowSeen.delete(key);
    shadowSeen.set(key, now);
    while (shadowSeen.size > DOOR_SHADOW_MAX_KEYS) shadowSeen.delete(shadowSeen.keys().next().value);
    const loginRaw = event && typeof event.login === "string" ? event.login.trim() : "";
    const entry = {
      at: now,
      cls,
      source,
      login: loginRaw ? printable(loginRaw, LOGIN_MAX) : null,
      route,
      model: printable(event && event.model, MODEL_MAX).trim() || null,
      enforced: !!(event && event.enforced),
    };
    shadowRing.push(entry);
    while (shadowRing.length > DOOR_SHADOW_RING) shadowRing.shift();
    const what = entry.enforced
      ? `[llm-door] refused an unidentified caller (${ENFORCE_ENV}=1)`
      : `[llm-door] would refuse an unidentified caller (shadow: ${ENFORCE_ENV} is off)`;
    try {
      logFn(`${what}: ${cls} source=${source} login=${entry.login || "-"} route=${route} model=${entry.model || "-"}`);
    } catch { /* the census never changes the door's answer */ }
    return true;
  } catch {
    return false;
  }
}

/**
 * The read-only summary behind the Nest health item: which sources were seen
 * calling the door without a Crow credential, grouped by source and class, in
 * the last 24 h (and within the ring's bounds — a source that logs every ten
 * minutes stays, a spray of one-off sources can drop the oldest).
 *
 * @param {number} [nowMs]
 * @returns {{windowMs: number, total: number, classes: Record<string, number>,
 *            sources: Array<{cls: string, source: string, count: number, lastAt: number, login: string|null, routes: string[]}>}}
 */
export function doorShadowSummary(nowMs = Date.now()) {
  const now = Number.isFinite(nowMs) ? nowMs : Date.now();
  const from = now - DOOR_SHADOW_SUMMARY_MS;
  const groups = new Map();
  const classes = {};
  let total = 0;
  for (const e of shadowRing) {
    if (!(e.at >= from && e.at <= now)) continue;
    total++;
    classes[e.cls] = (classes[e.cls] || 0) + 1;
    const key = `${e.cls} ${e.source}`;
    const g = groups.get(key) || { cls: e.cls, source: e.source, count: 0, lastAt: 0, login: null, routes: [] };
    g.count++;
    if (e.at >= g.lastAt) { g.lastAt = e.at; g.login = e.login || g.login; }
    if (e.route && !g.routes.includes(e.route)) g.routes.push(e.route);
    groups.set(key, g);
  }
  const sources = [...groups.values()]
    .map((g) => ({ ...g, routes: g.routes.slice(0, 5) }))
    .sort((a, b) => (b.count - a.count) || a.source.localeCompare(b.source));
  return { windowMs: DOOR_SHADOW_SUMMARY_MS, total, classes, sources };
}