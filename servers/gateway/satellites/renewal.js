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
 */
import { createDbClient } from "../../db.js";
import { createNotification } from "../../shared/notifications.js";
import { needsRenewal } from "../../shared/satellite-protocol.js";
import { loadIdentityIfPresent } from "../../sharing/identity.js";
import { satelliteFetch } from "./client.js";
import { issueCert } from "./certs.js";
import { listSatellites, getSatellite, updateSatelliteStatus } from "./store.js";
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

  const commitCert = (db, id, cert, extra = {}) => updateSatelliteStatus(db, id, {
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

  async function renewOne(db, sat, { force = false } = {}) {
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
    await commitCert(db, sat.id, cert);
    return { renewed: true, expires_at: cert.payload.expires_at };
  }

  /** Settle a staged key left by an ambiguous rotation: "promoted" | "discarded" | "pending" | "none". */
  async function resolveStaged(db, sat, staged = loadStagedMgmtKey(sat.id, { env }), cert = null) {
    if (!staged) return "none";
    const old = await probe(sat);
    if (old === "ok") { discardStagedMgmtKey(sat.id, { env }); return "discarded"; }
    if (old !== "bad_key") return "pending";
    const fresh = await probe({ ...sat }, staged);
    if (fresh !== "ok") return "pending";
    promoteStagedMgmtKey(sat.id, { env });
    const extra = { mgmt_pubkey: staged.ed25519_pub };
    if (cert && cert.payload?.mgmt_pubkey === staged.ed25519_pub) await commitCert(db, sat.id, cert, extra);
    else await updateSatelliteStatus(db, sat.id, extra); // the cert itself is renewed on the next pass
    return "promoted";
  }

  async function rotateKey(db, sat) {
    if (!loadMgmtKey(sat.id, { env })) return { rotated: false, code: "no_mgmt_key" };
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
      const out = await resolveStaged(db, sat, staged, cert);
      if (out === "promoted") return { rotated: true, recovered: true };
      if (out === "discarded") return { rotated: false, code: "not_applied" };
      return { rotated: false, code: "ambiguous" };
    }
    if (r.status !== 200) {
      discardStagedMgmtKey(sat.id, { env });
      return { rotated: false, code: typeof r.json?.error === "string" ? r.json.error : `status_${r.status}` };
    }
    promoteStagedMgmtKey(sat.id, { env });
    await commitCert(db, sat.id, cert, { mgmt_pubkey: staged.ed25519_pub });
    return { rotated: true };
  }

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
          const cur = (await getSatellite(db, s.id)) || s;
          const r = await renewOne(db, cur);
          if (!r.renewed && r.code !== "not_due") log(`[satellites] cert renewal for ${s.id}: ${r.code}`);
          await warnExpiry(db, (await getSatellite(db, s.id)) || cur);
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
