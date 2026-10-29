/**
 * Gateway-signed remote actor (item 46 PR-B).
 *
 * A paired peer A's GATEWAY, having itself verified which bot is calling,
 * signs a header that tells instance B which bot made a tool call. The MAC key
 * is the pair subkey K_ra derived from the pair's `signing_key`; the key never
 * leaves the gateway process (the bot's proxy talks to a loopback relay that
 * signs). B verifies against the key of the BEARER-AUTHENTICATED peer, so a
 * third peer can never speak as A. Every failure here yields a weaker label on
 * the receiving side; none refuses the call. See the private engineering notes
 * for the design.
 *
 * Wire format: `x-crow-remote-actor` = base64url(JSON payload), at most 2048
 * characters; `x-crow-remote-actor-sig` = hex HMAC-SHA256(K_ra,
 * "crow-remote-actor/v1\n" + the exact header value). The payload binds the
 * sender, audience, mount, a timestamp, a nonce and a digest of the tool call.
 */
import { createHmac, createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { pairSubkeyFor, PAIR_SUBKEY_LABELS } from "./pair-subkey.js";
import { BOT_ID_RE } from "../../scripts/pi-bots/bot-workspace-env.mjs";
import { sanitizeActorName } from "../../scripts/pi-bots/actor-env.mjs";

export const REMOTE_ACTOR_HEADER = "x-crow-remote-actor";
export const REMOTE_ACTOR_SIG_HEADER = "x-crow-remote-actor-sig";

const MAC_PREFIX = "crow-remote-actor/v1\n";
const MAX_HEADER = 2048;
const SKEW_MS = 60_000;
const NONCE_TTL_MS = 120_000;
const NONCE_CAP = 2000;
const LOG_WINDOW_MS = 3_600_000;
const LOG_CAP = 1024;
const MAX_DEPTH = 64;
const PROCESS_START_MS = Math.floor(performance.timeOrigin);
const SIG_RE = /^[0-9a-fA-F]{64}$/;
const NONCE_RE = /^[0-9a-f]{32}$/;
const DIG_RE = /^[0-9a-f]{64}$/;

/**
 * Canonical JSON: sorted keys, no rebuilt objects (an own `__proto__` key from
 * JSON.parse is counted), strings and numbers through JSON.stringify.
 * Non-finite numbers become null; nesting deeper than 64 throws.
 */
export function canonicalJson(value, depth = 0) {
  if (value === null) return "null";
  switch (typeof value) {
    case "string": return JSON.stringify(value);
    case "number": return Number.isFinite(value) ? JSON.stringify(value) : "null";
    case "boolean": return value ? "true" : "false";
    case "object": {
      if (depth >= MAX_DEPTH) throw new Error("canonicalJson: nesting too deep");
      if (Array.isArray(value)) {
        const parts = [];
        for (const item of value) {
          parts.push(item === undefined || typeof item === "function" || typeof item === "symbol"
            ? "null" : canonicalJson(item, depth + 1));
        }
        return "[" + parts.join(",") + "]";
      }
      const parts = [];
      for (const k of Object.keys(value).sort()) {
        const v = value[k];
        if (v === undefined || typeof v === "function" || typeof v === "symbol") continue;
        parts.push(JSON.stringify(k) + ":" + canonicalJson(v, depth + 1));
      }
      return "{" + parts.join(",") + "}";
    }
    default: throw new TypeError("canonicalJson: unsupported value");
  }
}

function isPlainObject(v) {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return false;
  const p = Object.getPrototypeOf(v);
  return p === Object.prototype || p === null;
}

function isToolCall(body) {
  return isPlainObject(body) && body.method === "tools/call";
}

/** sha256 hex over the parts of a tools/call that decide what runs. */
export function toolCallDigest(body) {
  return createHash("sha256").update(canonicalJson({
    method: body?.method,
    name: body?.params?.name,
    arguments: body?.params?.arguments ?? {},
  })).digest("hex");
}

function macFor(signingKeyHex, headerValue) {
  const k = pairSubkeyFor(signingKeyHex, PAIR_SUBKEY_LABELS.REMOTE_ACTOR);
  return createHmac("sha256", k).update(MAC_PREFIX + headerValue).digest("hex");
}

function nonEmptyString(v) {
  return typeof v === "string" && v.length > 0;
}

/** Returns the two headers, or null when this call cannot or must not be signed. */
export function signRemoteActor({ signingKeyHex, bot, name, src, aud, mount, body, now = Date.now(), nonce } = {}) {
  try {
    if (!isToolCall(body)) return null;
    if (typeof mount !== "string" || !mount.startsWith("/")) return null;
    if (typeof bot !== "string" || !BOT_ID_RE.test(bot)) return null;
    if (!nonEmptyString(src) || !nonEmptyString(aud)) return null;
    if (!Number.isSafeInteger(now)) return null;
    const payload = {
      v: 1, kind: "bot", bot, name: sanitizeActorName(name, bot), src, aud, mount,
      ts: now, nonce: nonce ?? randomBytes(16).toString("hex"), dig: toolCallDigest(body),
    };
    const value = Buffer.from(JSON.stringify(payload)).toString("base64url");
    if (value.length > MAX_HEADER) return null;
    return { [REMOTE_ACTOR_HEADER]: value, [REMOTE_ACTOR_SIG_HEADER]: macFor(signingKeyHex, value) };
  } catch {
    return null;
  }
}

function withHeaders(existing, add) {
  const names = new Set(Object.keys(add));
  if (existing instanceof Headers) {
    const h = new Headers(existing);
    for (const [k, v] of Object.entries(add)) h.set(k, v);
    return h;
  }
  if (Array.isArray(existing)) {
    return [...existing.filter((p) => !names.has(String(p[0]).toLowerCase())), ...Object.entries(add)];
  }
  const out = {};
  for (const [k, v] of Object.entries(existing || {})) if (!names.has(k.toLowerCase())) out[k] = v;
  return { ...out, ...add };
}

const ACTOR_HEADER_NAMES = [REMOTE_ACTOR_HEADER, REMOTE_ACTOR_SIG_HEADER];
const isActorName = (k) => ACTOR_HEADER_NAMES.includes(String(k).toLowerCase());

/** init without any caller-supplied actor headers; the same object when it has none. */
function stripActorHeaders(init) {
  const h = init?.headers;
  if (!h) return init;
  if (h instanceof Headers) {
    if (!ACTOR_HEADER_NAMES.some((n) => h.has(n))) return init;
    const out = new Headers(h);
    for (const n of ACTOR_HEADER_NAMES) out.delete(n);
    return { ...init, headers: out };
  }
  if (Array.isArray(h)) {
    return h.some((p) => isActorName(p[0])) ? { ...init, headers: h.filter((p) => !isActorName(p[0])) } : init;
  }
  if (!Object.keys(h).some(isActorName)) return init;
  return { ...init, headers: Object.fromEntries(Object.entries(h).filter(([k]) => !isActorName(k))) };
}

/**
 * A fetch that signs tools/call POSTs. The key is looked up on every call and
 * never held in the closure; without one the request goes out unsigned.
 */
export function signingFetch({ keyLookup, src, aud, mount, bot, name, fetchImpl = globalThis.fetch, onUnsigned } = {}) {
  return async (url, init) => {
    let body = null;
    if (init && String(init.method || "").toUpperCase() === "POST" && typeof init.body === "string") {
      try { body = JSON.parse(init.body); } catch { body = null; }
    }
    if (!isToolCall(body)) return fetchImpl(url, stripActorHeaders(init));
    let key = null;
    try { key = keyLookup(aud); } catch { key = null; }
    const signed = key ? signRemoteActor({ signingKeyHex: key, bot, name, src, aud, mount, body }) : null;
    if (!signed) {
      try { onUnsigned?.(); } catch { /* never affects the call */ }
      return fetchImpl(url, stripActorHeaders(init));
    }
    return fetchImpl(url, { ...init, headers: withHeaders(init.headers, signed) });
  };
}

// source id -> Map(nonce -> expiry ms)
const nonceBuckets = new Map();

export function _resetRemoteActorNonces() {
  nonceBuckets.clear();
}

const fail = (reason) => ({ ok: false, reason });

/** Verify a request's remote-actor headers. Never throws. */
export function verifyRemoteActor({
  headers, body, peerId, localId, mount, keyLookup, now = Date.now(), processStartMs = PROCESS_START_MS,
} = {}) {
  try {
    const value = headers?.[REMOTE_ACTOR_HEADER];
    const sig = headers?.[REMOTE_ACTOR_SIG_HEADER];
    if (value === undefined && sig === undefined) return fail("absent");
    if (value !== undefined && (typeof value !== "string" || value.length > MAX_HEADER)) {
      return fail(typeof value === "string" ? "too_long" : "malformed");
    }
    if (typeof sig !== "string" || !SIG_RE.test(sig) || value === undefined) return fail("malformed");

    let key = null;
    try { key = keyLookup(peerId); } catch { key = null; }
    if (!key) return fail("no_key");
    let expected;
    try { expected = macFor(key, value); } catch { return fail("no_key"); }
    if (!timingSafeEqual(Buffer.from(expected, "utf8"), Buffer.from(sig.toLowerCase(), "utf8"))) return fail("bad_sig");

    let p;
    try { p = JSON.parse(Buffer.from(value, "base64url").toString("utf8")); } catch { return fail("malformed"); }
    if (!isPlainObject(p)) return fail("malformed");
    if (p.v !== 1) return fail("unsupported");
    if (p.kind !== "bot") return fail("bad_kind");
    if (![p.bot, p.name, p.src, p.aud, p.mount].every((s) => typeof s === "string")
      || !Number.isSafeInteger(p.ts) || typeof p.nonce !== "string" || !NONCE_RE.test(p.nonce)
      || typeof p.dig !== "string" || !DIG_RE.test(p.dig)) return fail("malformed");
    if (!BOT_ID_RE.test(p.bot)) return fail("bad_bot");
    if (p.src !== peerId) return fail("src_mismatch");
    if (p.aud !== localId) return fail("aud_mismatch");
    if (p.mount !== mount) return fail("mount_mismatch");
    if (Math.abs(now - p.ts) > SKEW_MS) return fail("stale");
    if (p.ts < processStartMs) return fail("pre_boot");
    let dig = null;
    if (isToolCall(body)) { try { dig = toolCallDigest(body); } catch { dig = null; } }
    if (dig === null || dig !== p.dig) return fail("digest_mismatch");

    let bucket = nonceBuckets.get(peerId);
    const exp = bucket?.get(p.nonce);
    if (exp !== undefined && exp > now) return fail("replay");
    if (!bucket) { bucket = new Map(); nonceBuckets.set(peerId, bucket); }
    for (const [n, e] of bucket) if (e <= now) bucket.delete(n);
    if (bucket.size >= NONCE_CAP) return fail("replay_cache_full");
    bucket.set(p.nonce, now + NONCE_TTL_MS);

    const name = sanitizeActorName(p.name.replace(/[()[\]]/g, ""), p.bot);
    return { ok: true, actor: { bot: p.bot, name, src: p.src } };
  } catch {
    return fail("malformed");
  }
}

// Rate-limited log: key -> last logged ms. Insertion order doubles as age.
const logged = new Map();

export function _resetRemoteActorLog() {
  logged.clear();
}

function shouldLog(key) {
  const t = Date.now();
  const last = logged.get(key);
  if (last !== undefined && t - last < LOG_WINDOW_MS) return false;
  logged.delete(key);
  logged.set(key, t);
  while (logged.size > LOG_CAP) logged.delete(logged.keys().next().value);
  return true;
}

/** Log a verification outcome at most once per key per hour. Never logs a key, sig or header. */
export function noteRemoteActorResult({ sourceId, mount, result } = {}) {
  if (!result) return;
  if (result.ok) {
    const bot = result.actor?.bot;
    if (shouldLog(`ok\n${sourceId}\n${bot}\n${mount}`)) {
      console.log(`[remote-actor] accepted bot ${bot} from ${sourceId} on ${mount}`);
    }
  } else if (result.reason !== "absent") {
    if (shouldLog(`no\n${sourceId}\n${result.reason}`)) {
      console.warn(`[remote-actor] downgraded a call from ${sourceId} on ${mount}: ${result.reason}`);
    }
  }
}
