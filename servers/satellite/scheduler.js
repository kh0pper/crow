/**
 * The satellite agent's housekeeping (SAT-3, spec §5.1, §6.3, §14):
 *   hourly  delete request nonces and pair_nonces older than 24 h, audit rows older than 90 days;
 *   daily   log the cert's days left (or that it is in the grace, lapsed, or not paired).
 * Both run once at start(), then on unref'd intervals (they never keep the process alive).
 * The clock and the timer functions are injectable for tests.
 */
import { certTimeState, GRACE_MS } from "../shared/satellite-protocol.js";

export const HOUR_MS = 3600000;
export const DAY_MS = 24 * HOUR_MS;
export const NONCE_KEEP_MS = DAY_MS;
export const PAIR_NONCE_KEEP_MS = DAY_MS;
export const AUDIT_KEEP_MS = 90 * DAY_MS;

export function createScheduler({
  db, now = Date.now, log = console.log, getCert = () => null,
  setIntervalImpl = setInterval, clearIntervalImpl = clearInterval,
}) {
  let timers = [];

  function runHourly() {
    const t = now();
    try {
      db.prepare("DELETE FROM nonces WHERE seen_at < ?").run(t - NONCE_KEEP_MS);
      db.prepare("DELETE FROM pair_nonces WHERE issued_at < ?").run(t - PAIR_NONCE_KEEP_MS);
      db.prepare("DELETE FROM audit WHERE ts < ?").run(new Date(t - AUDIT_KEEP_MS).toISOString());
    } catch (err) {
      log(`satellite: housekeeping failed: ${err?.message || err}`);
    }
  }

  function runDaily() {
    const t = now();
    const cert = getCert();
    const exp = Date.parse(cert?.payload?.expires_at);
    if (!cert || !Number.isFinite(exp)) return log("satellite: not paired");
    const state = certTimeState(cert, t);
    if (state === "valid") return log(`satellite: cert expires in ${Math.floor((exp - t) / DAY_MS)} days (${cert.payload.expires_at})`);
    const ago = Math.floor((t - exp) / DAY_MS);
    if (state === "grace") {
      return log(`satellite: cert expired ${ago} days ago, within the ${GRACE_MS / DAY_MS}-day grace (${Math.floor((exp + GRACE_MS - t) / DAY_MS)} days left to renew)`);
    }
    return log(`satellite: cert lapsed ${ago} days ago; re-pair from crow (installer --repair)`);
  }

  return {
    runHourly,
    runDaily,
    start() {
      if (timers.length) return;
      runHourly();
      runDaily();
      timers = [setIntervalImpl(runHourly, HOUR_MS), setIntervalImpl(runDaily, DAY_MS)];
      for (const h of timers) h?.unref?.();
    },
    stop() {
      for (const h of timers) clearIntervalImpl(h);
      timers = [];
    },
    running: () => timers.length > 0,
  };
}
