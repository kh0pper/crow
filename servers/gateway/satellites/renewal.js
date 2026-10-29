/**
 * Satellite cert renewal and mgmt-key rotation, crow side (SAT-5, spec §3.2, §14).
 *
 * Daily (injectable timer, no system timer): every paired satellite whose cert has < 76 days
 * left gets a fresh cert (same mgmt key, new serial, 90 days) through signed POST
 * /satellite/v1/cert; on 200 the row takes the new cert. When < 14 days remain after the pass,
 * the owner gets one notification per satellite per day.
 *
 * Rotation (Task 6 rule): the new key is STAGED (mgmt-keys.js); the cert naming it is sent
 * signed with the OLD key; only a 200 promotes the staged key and updates mgmt_pubkey. On an
 * ambiguous failure (no answer / unverifiable answer) crow probes with the old key: it works →
 * the satellite never took the new pin, discard the staged key; refused bad_signature → probe
 * with the new key: it works → promote. Neither answers → keep both and resolve later
 * (resolveStaged), never guess.
 *
 * Every row write is conditional on the satellite not being revoked, and the row is written
 * BEFORE a staged key is promoted: an unpair during a renewal or rotation wins, no cert is
 * committed and no live key file comes back.
 */
import { createDbClient } from "../../db.js";
import { createNotification } from "../../shared/notifications.js";
import { needsRenewal } from "../../shared/satellite-protocol.js";
import { loadIdentityIfPresent } from "../../sharing/identity.js";
import { satelliteFetch } from "./client.js";
import { issueCert } from "./certs.js";
import { listSatellites, getSatellite, updateSatelliteIfNotRevoked } from "./store.js";
import { loadMgmtKey, loadStagedMgmtKey, createStagedMgmtKey, promoteStagedMgmtKey, discardStagedMgmtKey } from "./mgmt-keys.js";
import { SERVERS_URL } from "./poller.js";

const DAY = 86400000;
export const RENEW_INTERVAL_MS = DAY;
export const EXPIRY_WARN_DAYS = 14;

const parseCert = (sat) => { try { return JSON.parse(sat.cert_json); } catch { return null; } };

export function certDaysLeft(sat, now = Date.now()) {
  const exp = Date.parse(sat?.cert_expires_at);
  return Number.isFinite(exp) ? Math.floor((exp - now) / DAY) : null;
}

export function createCertRenewer({
  dbFactory = createDbClient, closeDb = true, fetchImpl = globalThis.fetch, env = process.env, now = Date.now,
  identityFn = () => loadIdentityIfPresent(), notify = createNotification, intervalMs = RENEW_INTERVAL_MS,
  setIntervalImpl = setInterval, clearIntervalImpl = clearInterval, log = (m) => console.warn(m),
} = {}) {
  let timer = null;
  const warnedDay = new Map(); // satellite id → UTC day notified

  function newCert(sat, mgmtPub) {
    const identity = identityFn();
    if (!identity) { const e = new Error("no identity"); e.code = "no_identity"; throw e; }
    const old = parseCert(sat);
    return issueCert({
      identity, instanceId: old?.payload?.primary_instance_id, primaryUrl: sat.primary_url,
      satellite_id: sat.id, satellite_pubkey: sat.satellite_pubkey, mgmt_pubkey: mgmtPub, now: now(),
    });
  }

  // Conditional on the row not being revoked: false means an unpair won the race.
  const commitCert = (db, id, cert, extra = {}) => updateSatelliteIfNotRevoked(db, id, {
    cert_json: JSON.stringify(cert), cert_serial: cert.payload.serial, cert_expires_at: cert.payload.expires_at, ...extra,
  });

  /** "ok" | "bad_key" | "refused" | "unreachable" for a signed GET status with `key` (default: live). */
  async function probe(sat, key) {
    try {
      const r = await satelliteFetch(sat, { method: "GET", path: "/satellite/v1/status", caller: "owner-local", fetchImpl, env, ...(key ? { mgmtKey: key } : {}) });
      if (r.status === 200) return "ok";
      return r.json?.error === "bad_signature" ? "bad_key" : "refused";
    } catch (err) {
      return err?.code === "no_mgmt_key" ? "bad_key" : "unreachable";
    }
  }

  // One cert/key operation per satellite at a time (review M2): renew, rotate and resolve all
  // take this in-process lock, and each re-reads the row inside it.
  const locks = new Map();
  function withLock(satId, fn) {
    const prev = locks.get(satId) || Promise.resolve();
    const run = prev.catch(() => {}).then(fn);
    const tail = run.catch(() => {});
    locks.set(satId, tail);
    tail.then(() => { if (locks.get(satId) === tail) locks.delete(satId); });
    return run;
  }
  const fresh = async (db, sat) => {
    const cur = await getSatellite(db, sat.id);
    return cur && cur.status !== "revoked" ? cur : null;
  };

  async function renewOneUnlocked(db, sat, { force = false } = {}) {
    if (!force && !needsRenewal(parseCert(sat), now())) return { renewed: false, code: "not_due" };
    let cert;
    try { cert = newCert(sat, sat.mgmt_pubkey); } catch (err) { return { renewed: false, code: err.code || "cert_failed" }; }
    let r;
    try {
      r = await satelliteFetch(sat, { method: "POST", path: "/satellite/v1/cert", body: { cert }, caller: "owner-local", fetchImpl, env });
    } catch (err) {
      return { renewed: false, code: err?.code || "unreachable" };
    }
    if (r.status !== 200) return { renewed: false, code: typeof r.json?.error === "string" ? r.json.error : `status_${r.status}` };
    if (!(await commitCert(db, sat.id, cert))) return { renewed: false, code: "revoked" };
    return { renewed: true, expires_at: cert.payload.expires_at };
  }

  /** Settle a staged key left by an ambiguous rotation: "promoted" | "discarded" | "pending" | "none" | "revoked". */
  async function resolveStagedUnlocked(db, sat, staged = loadStagedMgmtKey(sat.id, { env }), cert = null) {
    if (!staged) return "none";
    const old = await probe(sat);
    if (old === "ok") { discardStagedMgmtKey(sat.id, { env }); return "discarded"; }
    if (old !== "bad_key") return "pending";
    const viaNew = await probe({ ...sat }, staged);
    if (viaNew !== "ok") return "pending";
    // The row first (conditional), then the key file: a revoked satellite never gets a live key back.
    const extra = { mgmt_pubkey: staged.ed25519_pub };
    const wrote = cert && cert.payload?.mgmt_pubkey === staged.ed25519_pub
      ? await commitCert(db, sat.id, cert, extra)
      : await updateSatelliteIfNotRevoked(db, sat.id, extra); // the cert itself is renewed on the next pass
    if (!wrote) { discardStagedMgmtKey(sat.id, { env }); return "revoked"; }
    promoteStagedMgmtKey(sat.id, { env, expectedPub: staged.ed25519_pub });
    return "promoted";
  }

  async function rotateKeyUnlocked(db, sat) {
    if (!loadMgmtKey(sat.id, { env })) return { rotated: false, code: "no_mgmt_key" };
    // A staged key from an earlier ambiguous rotation is settled first; while it cannot be,
    // a new rotation would destroy the only key the satellite may now accept (review M2).
    const pending = await resolveStagedUnlocked(db, sat);
    if (pending === "revoked") return { rotated: false, code: "revoked" };
    if (pending !== "none") return { rotated: false, code: "rotation_pending", resolved: pending };
    const staged = createStagedMgmtKey(sat.id, { env, now: now() });
    let cert;
    try { cert = newCert(sat, staged.ed25519_pub); } catch (err) {
      discardStagedMgmtKey(sat.id, { env });
      return { rotated: false, code: err.code || "cert_failed" };
    }
    let r;
    try {
      r = await satelliteFetch(sat, { method: "POST", path: "/satellite/v1/cert", body: { cert }, caller: "owner-local", fetchImpl, env });
    } catch {
      const out = await resolveStagedUnlocked(db, sat, staged, cert);
      if (out === "promoted") return { rotated: true, recovered: true };
      if (out === "revoked") return { rotated: false, code: "revoked" };
      if (out === "discarded") return { rotated: false, code: "not_applied" };
      return { rotated: false, code: "ambiguous" };
    }
    if (r.status !== 200) {
      discardStagedMgmtKey(sat.id, { env });
      return { rotated: false, code: typeof r.json?.error === "string" ? r.json.error : `status_${r.status}` };
    }
    if (!(await commitCert(db, sat.id, cert, { mgmt_pubkey: staged.ed25519_pub }))) {
      discardStagedMgmtKey(sat.id, { env });
      return { rotated: false, code: "revoked" };
    }
    promoteStagedMgmtKey(sat.id, { env, expectedPub: staged.ed25519_pub });
    return { rotated: true };
  }

  const locked = (fn, revokedAnswer) => (db, sat, ...rest) => withLock(sat.id, async () => {
    const cur = await fresh(db, sat);
    return cur ? fn(db, cur, ...rest) : revokedAnswer;
  });
  const renewOne = locked(renewOneUnlocked, { renewed: false, code: "revoked" });
  const rotateKey = locked(rotateKeyUnlocked, { rotated: false, code: "revoked" });
  // resolveStaged(db, sat) only: the staged key and cert arguments are internal to a rotation.
  const resolveStaged = locked((db, sat) => resolveStagedUnlocked(db, sat), "revoked");

  async function warnExpiry(db, sat) {
    const left = certDaysLeft(sat, now());
    if (left === null || left >= EXPIRY_WARN_DAYS) return;
    const day = new Date(now()).toISOString().slice(0, 10);
    if (warnedDay.get(sat.id) === day) return;
    warnedDay.set(sat.id, day);
    const title = left >= 0 ? `${sat.name}'s certificate expires in ${left} days` : `${sat.name}'s certificate has expired`;
    try {
      await notify(db, {
        type: "system", source: `satellite:${sat.id}:cert`, priority: "high", title,
        body: "crow renews it automatically when it can reach the server. Check that the server is online.", action_url: SERVERS_URL,
      });
    } catch (err) { log(`[satellites] notification failed: ${err?.message}`); }
  }

  async function tick() {
    let db;
    try {
      db = dbFactory();
      const sats = (await listSatellites(db)).filter((s) => s.status !== "revoked");
      for (const s of sats) {
        try {
          if (loadStagedMgmtKey(s.id, { env })) await resolveStaged(db, s);
          const r = await renewOne(db, s);
          if (!r.renewed && r.code !== "not_due") log(`[satellites] cert renewal for ${s.id}: ${r.code}`);
          const cur = await getSatellite(db, s.id);
          if (cur && cur.status !== "revoked") await warnExpiry(db, cur);
        } catch (err) {
          log(`[satellites] renewal ${s.id}: ${err?.message}`);
        }
      }
    } catch (err) {
      log(`[satellites] renewal: ${err?.message}`);
    } finally {
      if (closeDb) { try { db?.close?.(); } catch { /* best effort */ } }
    }
  }

  function start() {
    if (timer) return;
    timer = setIntervalImpl(() => { tick().catch(() => {}); }, intervalMs);
    timer?.unref?.();
  }
  function stop() {
    if (timer) clearIntervalImpl(timer);
    timer = null;
  }

  return { tick, renewOne, rotateKey, resolveStaged, probe, start, stop };
}
