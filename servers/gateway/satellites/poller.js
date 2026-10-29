/**
 * Satellite status poller (SAT-5, spec §8, §9.1, §11.1, §14). Every 60 s, for each paired
 * (non-revoked) satellite: the unsigned GET /health (clock skew for the card) and a signed
 * GET /satellite/v1/status. The result lands in satellites.last_status_json as
 *
 *   {v:1, polled_at, status:<the satellite's status body>, health:{protocol,time,skew_ms}|null, skew_ms,
 *    error:null|<code>, alerts:{psi:boolean, tools:{<bundle>: <hash notified>}}}
 *
 * and last_seen_at / agent_protocol are updated. Rules:
 *   - no answer (transport failure or an unverifiable answer) for 10 min → status 'unreachable'
 *     and ONE notification; the next good poll puts it back to 'active'. A signed refusal (e.g.
 *     clock_skew) is an answer: recorded as `error`, never counted as unreachable.
 *   - memory PSI (some avg10) > 10 % → one notification per episode.
 *   - a reported tool hash ≠ the pin → the transport disables that bundle's tools (toolsState),
 *     and the owner gets one notification per new hash with a +/−/~ diff; a change at the same
 *     version is flagged suspicious. A bundle with no sha256 reported (tools_too_large) is
 *     "tools unavailable", never a mismatch.
 *
 * Every write is conditional on the row not being revoked (an unpair during a poll wins), and
 * notifications are sent only after the write. Clocks and timers are injectable; nothing here registers a system timer. tick() does one
 * SELECT and no network when there are no satellites.
 */
import { createDbClient } from "../../db.js";
import { createNotification } from "../../shared/notifications.js";
import { satelliteFetch } from "./client.js";
import { listSatellites, getSatellite, updateSatelliteIfNotRevoked, getToolPin } from "./store.js";
import { readHealth, fetchToolList } from "./remote.js";
import { diffTools, formatDiff, lastRecord } from "./tools-pin.js";
import { sanitizeStatus } from "./status-sanitize.js";

export const POLL_INTERVAL_MS = 60000;
export const UNREACHABLE_AFTER_MS = 10 * 60000;
export const PSI_ALERT_PCT = 10;
export const SERVERS_URL = "/dashboard/extensions?view=servers";

const hhmm = (iso) => { const d = new Date(iso); return Number.isFinite(d.getTime()) ? d.toISOString().slice(11, 16) + " UTC" : "?"; };

export function createSatellitePoller({
  dbFactory = createDbClient, closeDb = true, fetchImpl = globalThis.fetch, env = process.env, now = Date.now,
  notify = createNotification, intervalMs = POLL_INTERVAL_MS, setIntervalImpl = setInterval, clearIntervalImpl = clearInterval,
  log = (m) => console.warn(m),
} = {}) {
  let timer = null;
  let running = null;

  const say = async (db, sat, kind, title, body) => {
    try {
      await notify(db, { type: "system", source: `satellite:${sat.id}:${kind}`, priority: "high", title, body, action_url: SERVERS_URL });
    } catch (err) { log(`[satellites] notification failed: ${err?.message}`); }
  };

  async function failed(db, sat, code) {
    const t = now();
    const since = sat.unreachable_since || new Date(t).toISOString();
    const patch = {};
    if (!sat.unreachable_since) patch.unreachable_since = since;
    const rec = lastRecord(sat) || { v: 1, status: null, health: null, alerts: { psi: false, tools: {} } };
    rec.error = code;
    rec.polled_at = new Date(t).toISOString();
    patch.last_status_json = JSON.stringify(rec);
    let became = false;
    if (sat.status === "active" && t - Date.parse(since) >= UNREACHABLE_AFTER_MS) { patch.status = "unreachable"; became = true; }
    // Conditional: an unpair that landed during the poll wins (never revived, never notified).
    if (!(await updateSatelliteIfNotRevoked(db, sat.id, patch))) return { ok: false, code: "revoked" };
    if (became) await say(db, sat, "unreachable", `${sat.name} is unreachable`, `No answer since ${hhmm(since)}. Its tools return an error until it is back.`);
    return { ok: false, code };
  }

  async function checkTools(db, sat, status, prevAlerts, later) {
    const notified = { ...(prevAlerts?.tools || {}) };
    for (const [bundle, t] of Object.entries(status?.tools || {})) {
      const pin = await getToolPin(db, sat.id, bundle);
      if (!pin || typeof t?.sha256 !== "string" || !t.sha256) continue; // unpinned / unavailable
      if (t.sha256 === pin.tools_sha256) { delete notified[bundle]; continue; }
      if (notified[bundle] === t.sha256) continue; // already told the owner about this hash
      notified[bundle] = t.sha256;
      let diffText = "the new list could not be read";
      try {
        const fresh = await fetchToolList(sat, bundle, { fetchImpl, env });
        let old = [];
        try { old = JSON.parse(pin.tools_json); } catch { old = []; }
        diffText = formatDiff(diffTools(old, fresh));
      } catch { /* keep the fallback text */ }
      const same = pin.version != null && t.version != null && String(pin.version) === String(t.version);
      const body = `${diffText}.${same ? ` Same version (${t.version}) as approved: this is suspicious.` : ""} The tools are off until you approve them on the Servers page.`;
      later.push([`tools:${bundle}`, `${sat.name}'s ${bundle} tools changed; approve them on the Servers page`, body]);
    }
    for (const b of Object.keys(notified)) if (!status?.tools?.[b]) delete notified[b];
    return notified;
  }

  async function pollOne(db, sat) {
    const health = await readHealth(sat, { fetchImpl, now });
    let r;
    try {
      r = await satelliteFetch(sat, { method: "GET", path: "/satellite/v1/status", caller: "owner-local", fetchImpl, env });
    } catch (err) {
      return failed(db, sat, err?.code || "unreachable");
    }
    const t = now();
    const prev = lastRecord(sat);
    const rec = { v: 1, polled_at: new Date(t).toISOString(), status: prev?.status ?? null, health, skew_ms: health?.skew_ms ?? null, error: null, alerts: { psi: !!prev?.alerts?.psi, tools: prev?.alerts?.tools || {} } };
    // status only when it changes (unreachable → active); the write below never touches a revoked row.
    const patch = { unreachable_since: null };
    if (sat.status === "unreachable") patch.status = "active";
    if (r.status !== 200) {
      // A signed refusal: the satellite is there, but refused (clock_skew, cert_expired, ...).
      rec.error = typeof r.json?.error === "string" ? r.json.error.slice(0, 48) : `status_${r.status}`;
      patch.last_status_json = JSON.stringify(rec);
      if (!(await updateSatelliteIfNotRevoked(db, sat.id, patch))) return { ok: false, code: "revoked" };
      return { ok: false, code: rec.error, answered: true };
    }
    // Only the whitelisted, type-checked form is ever stored (review M1).
    const status = sanitizeStatus(r.json);
    rec.status = status;
    patch.last_seen_at = new Date(t).toISOString();
    if (Number.isInteger(status.agent_protocol)) patch.agent_protocol = status.agent_protocol;
    const psi = Number(status.psi_memory_some_avg10);
    const hot = Number.isFinite(psi) && psi > PSI_ALERT_PCT;
    const later = []; // notifications go out only once the record is written
    if (hot && !rec.alerts.psi) later.push(["psi", `${sat.name} is low on memory`, `Memory pressure is ${psi.toFixed(1)} % (over ${PSI_ALERT_PCT} %). The kernel may stop its extensions.`]);
    rec.alerts.psi = hot;
    rec.alerts.tools = await checkTools(db, sat, status, prev?.alerts, later);
    patch.last_status_json = JSON.stringify(rec);
    if (!(await updateSatelliteIfNotRevoked(db, sat.id, patch))) return { ok: false, code: "revoked" };
    for (const [kind, title, body] of later) await say(db, sat, kind, title, body);
    return { ok: true };
  }

  /** One pass over every non-revoked satellite (sequential; one bad satellite never stops the rest). */
  async function tick() {
    if (running) return running;
    running = (async () => {
      let db;
      try {
        db = dbFactory();
        const sats = (await listSatellites(db)).filter((s) => s.status !== "revoked");
        for (const s of sats) {
          try { await pollOne(db, s); } catch (err) { log(`[satellites] poll ${s.id}: ${err?.message}`); }
        }
      } catch (err) {
        log(`[satellites] poll: ${err?.message}`);
      } finally {
        if (closeDb) { try { db?.close?.(); } catch { /* best effort */ } }
        running = null;
      }
    })();
    return running;
  }

  /** Poll one satellite now (the card's refresh); returns pollOne's answer. */
  async function pollNow(db, id) {
    const sat = await getSatellite(db, id);
    if (!sat || sat.status === "revoked") return { ok: false, code: "not_found" };
    return pollOne(db, sat);
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

  return { tick, pollNow, start, stop };
}
