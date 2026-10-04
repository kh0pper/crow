/**
 * Kiosk pairing (spec §4.4). Everything is in memory and nothing survives a
 * restart: a restart simply asks the display for a new code. Only
 * sha256(poll_secret) is kept. The code is guessed on the AUTHENTICATED side
 * (dashboard), so 10^6 codes plus a lockout is enough; the poll secret stops
 * a bystander who saw the code from collecting the token.
 */
import { createHash, randomBytes as nodeRandomBytes, randomInt as nodeRandomInt, timingSafeEqual } from "node:crypto";

export const PAIR_TTL_MS = 10 * 60 * 1000;
export const PICKUP_GRACE_MS = 2 * 60 * 1000;
export const MAX_PENDING = 3;
export const START_LIMIT_PER_MIN = 5;
export const LOCK_AFTER = 5;
export const LOCK_WINDOW_MS = 10 * 60 * 1000;
export const LOCK_MS = 10 * 60 * 1000;

const sha = (s) => createHash("sha256").update(String(s)).digest("hex");
function sameHex(a, b) {
  const x = Buffer.from(String(a), "hex"); const y = Buffer.from(String(b), "hex");
  return x.length > 0 && x.length === y.length && timingSafeEqual(x, y);
}

export function createPairingStore({ now = Date.now, randomInt = nodeRandomInt, randomBytes = nodeRandomBytes } = {}) {
  const pending = new Map();
  const startHits = new Map();
  let wrong = [];
  let lockedUntil = 0;

  function sweep() {
    const t = now();
    for (const [id, p] of pending) if (p.expires <= t) pending.delete(id);
    for (const [ip, hits] of startHits) { const keep = hits.filter((x) => t - x < 60_000); if (keep.length) startHits.set(ip, keep); else startHits.delete(ip); }
  }

  function start({ ip, ua, login, nameHint }) {
    sweep();
    const t = now();
    // Rate-limit key: the Serve-asserted Tailscale identity when present (a direct
    // LAN/tailnet client could forge X-Forwarded-For and so req.ip — review m3), else the IP.
    const key = String(login || ip || "?");
    const hits = startHits.get(key) || [];
    if (hits.length >= START_LIMIT_PER_MIN) return { error: "rate_limited", status: 429 };
    hits.push(t);
    startHits.set(key, hits);
    if (pending.size >= MAX_PENDING) return { error: "too_many_pending", status: 429 };
    let code;
    for (let i = 0; i < 20; i++) {
      code = String(randomInt(0, 1_000_000)).padStart(6, "0");
      if (![...pending.values()].some((p) => p.code === code)) break;
    }
    const pair_id = randomBytes(16).toString("hex");
    const poll_secret = randomBytes(32).toString("hex");
    pending.set(pair_id, {
      pair_id, code, pollHash: sha(poll_secret), ip: String(ip || "?"),
      ua: String(ua || "").slice(0, 200), login: login ? String(login).slice(0, 128) : null,
      name_hint: String(nameHint || "").slice(0, 64),
      created: t, expires: t + PAIR_TTL_MS, claimed: false, result: null,
    });
    return { pair_id, code, poll_secret, expires_in_s: PAIR_TTL_MS / 1000 };
  }

  function listPending() {
    sweep();
    return [...pending.values()].filter((p) => !p.result)
      .map(({ pair_id, ip, ua, login, name_hint, created, expires }) => ({ pair_id, ip, ua, login, name_hint, created, expires }));
  }

  function claim(code) {
    const t = now();
    if (t < lockedUntil) return { error: "locked", status: 429, retry_after_s: Math.ceil((lockedUntil - t) / 1000) };
    sweep();
    const c = String(code || "").replace(/\s+/g, "");
    const p = /^\d{6}$/.test(c) ? [...pending.values()].find((x) => x.code === c && !x.claimed && !x.result) : null;
    if (!p) {
      wrong = wrong.filter((x) => t - x < LOCK_WINDOW_MS);
      wrong.push(t);
      if (wrong.length >= LOCK_AFTER) { lockedUntil = t + LOCK_MS; wrong = []; }
      return { error: "bad_code", status: 400 };
    }
    p.claimed = true;
    return { pending: { pair_id: p.pair_id, ip: p.ip, ua: p.ua, login: p.login, name_hint: p.name_hint } };
  }

  function complete(pair_id, { device_id, token }) {
    const p = pending.get(pair_id);
    if (!p) return false;
    p.result = { device_id, token };
    p.expires = Math.max(p.expires, now() + PICKUP_GRACE_MS);
    return true;
  }

  function release(pair_id) { const p = pending.get(pair_id); if (p && !p.result) p.claimed = false; }

  function status(pair_id, pollSecret) {
    sweep();
    const p = pending.get(String(pair_id || ""));
    if (!p) return { status: 404, body: { state: "gone" } };
    if (!pollSecret || !sameHex(sha(pollSecret), p.pollHash)) return { status: 403, body: { error: "bad_poll_secret" } };
    if (!p.result) return { status: 200, body: { state: "pending" } };
    pending.delete(p.pair_id);
    return { status: 200, body: { state: "approved", device_id: p.result.device_id, token: p.result.token } };
  }

  return { start, listPending, claim, complete, release, status };
}
