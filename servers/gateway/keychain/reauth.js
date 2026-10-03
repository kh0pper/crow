/**
 * Fresh re-auth for keychain reveal/copy/delete/export/import/vault-save (spec §5.4).
 * Per dashboard session (sha256 of the session token), in memory: a 5-minute grant;
 * 5 consecutive failures lock re-auth for that session for 15 minutes. An INSTANCE-WIDE
 * ceiling (review S1: a paired peer can mint fresh SSO sessions, each with its own
 * 5 tries) locks re-auth for everyone after 20 failures in an hour.
 * With dashboard 2FA on, ONLY a TOTP code counts; otherwise the dashboard password.
 * With neither (Kevin Q6), method() is "none" and nothing can be granted — no bypass.
 * A gateway restart forgets everything, which only means "ask again".
 */
import { createHash } from "node:crypto";

export function createReauthGate({
  now = () => Date.now(),
  ttlMs = 5 * 60 * 1000,
  maxFailures = 5,
  lockMs = 15 * 60 * 1000,
  globalMaxFailures = 20,
  globalWindowMs = 60 * 60 * 1000,
  is2faEnabled,
  hasDashboardPassword,
  verifyTotpCode,
  verifyDashboardPassword,
}) {
  const grants = new Map();   // key → expiresAt (ms)
  const failures = new Map(); // key → { count, lockedUntil }
  let recentFailures = [];    // instance-wide failure timestamps
  const keyOf = (token) => createHash("sha256").update(String(token)).digest("hex");

  async function method() {
    if (await is2faEnabled()) return "totp";
    return (await hasDashboardPassword()) ? "password" : "none";
  }

  function globalLockedUntil(t) {
    recentFailures = recentFailures.filter((x) => x > t - globalWindowMs);
    return recentFailures.length >= globalMaxFailures ? recentFailures[0] + globalWindowMs : 0;
  }

  async function verify(token, { password, totp_code } = {}) {
    if (!token) return { ok: false, error: "No dashboard session." };
    const m = await method();
    if (m === "none") return { ok: false, unavailable: true, method: m, error: "Set a dashboard password or two-factor authentication first." };
    const k = keyOf(token);
    const t = now();
    const g = globalLockedUntil(t);
    if (g > t) return { ok: false, locked: true, global: true, locked_until: g, error: "Too many wrong attempts on this Crow. Try again later." };
    const f = failures.get(k);
    if (f && f.lockedUntil > t) {
      return { ok: false, locked: true, locked_until: f.lockedUntil, error: "Too many wrong attempts. Try again later." };
    }
    // Reserve this attempt SYNCHRONOUSLY (no await between the lock checks above and here),
    // so concurrent requests cannot all pass the checks before any failure is recorded.
    const prevCount = f && f.lockedUntil <= t && f.lockedUntil !== 0 ? 0 : (f?.count || 0);
    const count = prevCount + 1;
    const lockedByMe = count >= maxFailures;
    failures.set(k, lockedByMe ? { count: 0, lockedUntil: t + lockMs } : { count, lockedUntil: 0 });
    recentFailures.push(t);
    const justLockedGlobally = recentFailures.length === globalMaxFailures;
    let ok = false;
    try {
      ok = m === "totp"
        ? await verifyTotpCode(String(totp_code ?? "").trim())
        : await verifyDashboardPassword(String(password ?? ""));
    } catch {
      ok = false;
    }
    if (!ok) {
      return { ok: false, method: m, global_lock_started: justLockedGlobally, error: m === "totp" ? "That code is not valid." : "That password is not correct." };
    }
    // Success: roll the reservation back.
    const i = recentFailures.indexOf(t);
    if (i >= 0) recentFailures.splice(i, 1);
    const cur = failures.get(k);
    if (lockedByMe || !cur || cur.lockedUntil === 0) failures.delete(k);
    grants.set(k, t + ttlMs);
    return { ok: true, method: m, expires_at: t + ttlMs };
  }

  function isGranted(token) {
    if (!token) return false;
    const k = keyOf(token);
    const exp = grants.get(k);
    if (!exp) return false;
    if (exp <= now()) { grants.delete(k); return false; }
    return true;
  }

  function expiresAt(token) {
    return isGranted(token) ? grants.get(keyOf(token)) : null;
  }

  function revoke(token) {
    if (token) grants.delete(keyOf(token));
  }

  return { method, verify, isGranted, expiresAt, revoke };
}
