/**
 * Remote management of paired satellites, crow side (SAT-5, spec §7.1, §8, §9.1, §11.1).
 * routes/satellites.js mounts these behind its owner-only gate; every satellite call goes through
 * satelliteFetch (signed request, verified signed answer) as caller "owner-local".
 *
 * Rules held here:
 *   - an older agent (agent_protocol < crow's AGENT_PROTOCOL) refuses every management call
 *     except update / status (refresh) / cert (renew, rotate) with 409 update_first;
 *   - the host picker: only bundles whose manifest in crow's OWN checkout is satellite-eligible
 *     (satellite: true or {min_ram_mb}); one host per bundle id (installs.js bundleHost);
 *   - consent is relayed: the satellite's challenge goes to the owner, the owner's answer goes
 *     back signed, and the satellite's consent token goes on the retried install;
 *   - an install's finished job records installed.json + mcp-addons + skills; an uninstall's
 *     removes them and the tool pin. Only jobs crow itself started count (id, bundle and action
 *     must match crow's record, consumed once), and eligibility is re-checked at that moment.
 *     The GET job route finishes a job, and so does a background watcher (injectable timers)
 *     for a dialog that was closed;
 *   - the tool list the owner approves is re-read at approval and must hash to what they saw.
 *
 * Errors are ManageError {status, code, extra}; routes answer {error: code, ...extra}.
 */
import { execFile } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { AGENT_PROTOCOL, isSatelliteId } from "../../shared/satellite-protocol.js";
import { APP_BUNDLES, APP_ROOT } from "../bundles-config.js";
import { getBootSha } from "../convergence.js";
import { satelliteEligible } from "../../satellite/gate.js";
import { skillSyncMode } from "../bundle-skill-sync.js";
import { satelliteFetch } from "./client.js";
import { getSatellite, getToolPin, putToolPin, deleteToolPins, updateSatelliteIfNotRevoked } from "./store.js";
import { bundleHost, installPaths, recordSatelliteInstall, removeSatelliteInstall, removeAllForSatellite, satelliteInstalls } from "./installs.js";
import { fetchToolList } from "./remote.js";
import { sanitizeStatus } from "./status-sanitize.js";
import { checkToolList, diffTools, toolsSha, toolsState, lastRecord, reportedTools, MAX_TOOLS } from "./tools-pin.js";
import { discardStagedMgmtKey } from "./mgmt-keys.js";
import { createSatellitePoller } from "./poller.js";
import { createCertRenewer, certDaysLeft } from "./renewal.js";

export class ManageError extends Error {
  constructor(status, code, extra = {}) {
    super(code);
    this.status = status;
    this.code = code;
    this.extra = extra;
  }
}
const no = (status, code, extra) => new ManageError(status, code, extra);

const BUNDLE_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;
const JOB_RE = /^[0-9a-f]{16}$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const NAME_MAX = 64;
const LOG_MAX_BYTES = 300 * 1024;
const LOG_TEXT_CAP = 256 * 1024;
const ENV_KEY = /^[A-Z_][A-Z0-9_]{0,127}$/;

/** Calls allowed on an agent older than crow (spec §11.1 "update first"). */
export const ALWAYS_ALLOWED = new Set(["update", "status", "cert"]);

/** `git rev-list --count from..to` in crow's checkout; null when unknown. */
export function defaultBehindBy(from, to, { appRoot = APP_ROOT } = {}) {
  if (!SHA_RE.test(String(from)) || !SHA_RE.test(String(to))) return Promise.resolve(null);
  if (from === to) return Promise.resolve(0);
  return new Promise((done) => {
    execFile("git", ["-C", appRoot, "rev-list", "--count", `${from}..${to}`], { timeout: 5000 }, (err, out) => {
      const n = Number(String(out || "").trim());
      done(err || !Number.isInteger(n) ? null : n);
    });
  });
}

/** Tailnet peers from `tailscale status --json` (name, online, tags, os, addresses). */
export function parseTailscalePeers(j) {
  const peers = Object.values(j?.Peer || {});
  return peers.map((p) => ({
    name: typeof p?.DNSName === "string" ? p.DNSName.replace(/\.$/, "") : null,
    host_name: typeof p?.HostName === "string" ? p.HostName : null,
    os: typeof p?.OS === "string" ? p.OS : null,
    online: p?.Online === true,
    tags: Array.isArray(p?.Tags) ? p.Tags.filter((t) => typeof t === "string") : [],
    addresses: Array.isArray(p?.TailscaleIPs) ? p.TailscaleIPs.filter((t) => typeof t === "string") : [],
  })).filter((p) => p.name).sort((a, b) => a.name.localeCompare(b.name));
}

export function defaultPeers({ timeoutMs = 5000 } = {}) {
  return new Promise((done) => {
    execFile("tailscale", ["status", "--json"], { timeout: timeoutMs, maxBuffer: 4 * 1024 * 1024 }, (err, out) => {
      if (err) return done([]);
      try { done(parseTailscalePeers(JSON.parse(out))); } catch { done([]); }
    });
  });
}

export function createSatelliteManager({
  fetchImpl = globalThis.fetch, env = process.env, now = Date.now,
  appBundlesDir = () => APP_BUNDLES, paths = null, bootShaFn = getBootSha,
  behindByFn = defaultBehindBy, peersFn = defaultPeers, skillMode = skillSyncMode(),
  identityFn, watchJobs = true, watchIntervalMs = 3000, watchMaxMs = 30 * 60000,
  setTimeoutImpl = setTimeout, dbFactory = null, poller = null, renewer = null, log = (m) => console.warn(m),
} = {}) {
  const P = () => paths || installPaths();
  const theRenewer = renewer || createCertRenewer({ fetchImpl, env, now, ...(identityFn ? { identityFn } : {}), log });
  const thePoller = poller || createSatellitePoller({ fetchImpl, env, now, log });
  const behindCache = new Map();

  function manifestOf(id) {
    try { return JSON.parse(readFileSync(join(appBundlesDir(), id, "manifest.json"), "utf8")); } catch { return null; }
  }

  async function satOf(db, id) {
    if (!isSatelliteId(id)) throw no(400, "bad_id");
    const sat = await getSatellite(db, id);
    if (!sat) throw no(404, "not_found");
    if (sat.status === "revoked") throw no(409, "revoked");
    return sat;
  }

  function gate(sat, op) {
    if (ALWAYS_ALLOWED.has(op)) return;
    const p = Number(sat.agent_protocol);
    if (!Number.isInteger(p) || p < AGENT_PROTOCOL) throw no(409, "update_first", { agent_protocol: Number.isInteger(p) ? p : null, crow_protocol: AGENT_PROTOCOL });
  }

  const bundleId = (b) => { if (!BUNDLE_RE.test(String(b))) throw no(400, "bad_bundle_id"); return b; };

  /** A signed call; a transport failure is 502 {error: code}; the satellite's answer is passed on. */
  async function relay(sat, method, path, body, { maxBytes } = {}) {
    let r;
    try {
      r = await satelliteFetch(sat, { method, path, body, caller: "owner-local", fetchImpl, env, ...(maxBytes ? { maxBytes } : {}) });
    } catch (err) {
      const code = err?.code || "unreachable";
      throw no(code === "no_mgmt_key" ? 409 : 502, code);
    }
    // A 401 from the satellite is about crow's signature, not the owner's session.
    return { status: r.status === 401 ? 409 : r.status, json: r.json && typeof r.json === "object" ? r.json : {} };
  }

  // ── finishing jobs ──────────────────────────────────────────────────────────────────────
  // Every job crow starts, keyed "<sat>:<job>" → {bundle, action}. A job report is acted on only
  // when its id, bundle and action all match a record crow made, and the record is consumed: a
  // satellite cannot get crow to record an install (or drop an entry) it was never asked for.
  // In memory: a gateway restart mid-job leaves that one install unrecorded (the card shows it
  // as not recorded; reinstall or uninstall from the card).
  const startedJobs = new Map();
  const JOB_RECORD_MAX = 256;
  function noteJob(satId, jobId, bundle, action) {
    if (startedJobs.size >= JOB_RECORD_MAX) startedJobs.delete(startedJobs.keys().next().value);
    startedJobs.set(`${satId}:${jobId}`, { bundle, action });
  }

  async function removeRecords(db, sat, id) {
    const r = removeSatelliteInstall({ id, satelliteId: sat.id, appBundles: appBundlesDir(), paths: P(), log });
    try { await deleteToolPins(db, sat.id, id); } catch (err) { log(`[satellites] pins ${id}: ${err.message}`); }
    return r;
  }

  async function finishJob(db, sat, job, jobId) {
    if (!job || typeof jobId !== "string" || job.id !== jobId) return null;
    const key = `${sat.id}:${jobId}`;
    const rec = startedJobs.get(key);
    if (!rec || job.bundle_id !== rec.bundle || job.action !== rec.action) return null;
    if (job.status === "running") return null;
    startedJobs.delete(key); // finished either way: consumed
    if (job.status !== "complete") return null;
    const id = rec.bundle;
    if (rec.action === "install") {
      // Re-read the row AFTER the relay: an unpair that landed while the job report was in
      // flight wins (recordSatelliteInstall is synchronous from here on, nothing interleaves).
      const cur = await getSatellite(db, sat.id);
      if (!cur || cur.status === "revoked") return { ok: false, code: "revoked" };
      const m = manifestOf(id);
      if (!m || m.id !== id || !satelliteEligible(m)) {
        log(`[satellites] ${sat.id}: install of ${id} finished but ${id} is no longer satellite-eligible here; not recorded`);
        return { ok: false, code: "not_satellite" };
      }
      const r = recordSatelliteInstall({ id, satelliteId: sat.id, version: manifestOf(id)?.version ?? null, appBundles: appBundlesDir(), paths: P(), now, skillMode, log });
      if (!r.ok) log(`[satellites] ${sat.id}: install of ${id} finished but not recorded: ${r.code}`);
      return r;
    }
    if (rec.action === "uninstall") return removeRecords(db, sat, id);
    return null;
  }

  function watch(satId, jobId) {
    if (!watchJobs || !dbFactory) return;
    const started = now();
    const step = async () => {
      let db;
      try {
        db = dbFactory();
        const sat = await getSatellite(db, satId);
        if (!sat || sat.status === "revoked") return;
        const r = await relay(sat, "GET", `/satellite/v1/jobs/${jobId}`);
        if (r.status === 200 && r.json.status !== "running") { await finishJob(db, sat, r.json, jobId); return; }
        if (r.status === 404) return;
      } catch { /* retry */ } finally { try { db?.close?.(); } catch { /* best effort */ } }
      if (now() - started < watchMaxMs) setTimeoutImpl(step, watchIntervalMs)?.unref?.();
    };
    setTimeoutImpl(step, watchIntervalMs)?.unref?.();
  }

  // ── read side ───────────────────────────────────────────────────────────────────────────
  async function behindBy(satSha) {
    const boot = bootShaFn();
    if (!SHA_RE.test(String(satSha)) || !SHA_RE.test(String(boot))) return null;
    const k = `${satSha}..${boot}`;
    if (!behindCache.has(k)) behindCache.set(k, await behindByFn(satSha, boot));
    return behindCache.get(k);
  }

  /** The Servers card data for one satellite row (no network beyond a cached git count). */
  async function card(db, sat) {
    const rec = lastRecord(sat);
    // Sanitized again on read (review M1): an older or hand-edited record never reaches the card raw.
    const st = rec?.status && typeof rec.status === "object" ? sanitizeStatus(rec.status) : null;
    const installed = [];
    const ids = new Set([...(st?.installed || []).map((b) => b.id), ...satelliteInstalls(P(), sat.id).map((r) => r.id)]);
    for (const id of [...ids].sort()) {
      if (!BUNDLE_RE.test(String(id))) continue;
      const fromSat = (st?.installed || []).find((b) => b.id === id);
      const pin = await getToolPin(db, sat.id, id);
      installed.push({
        id, version: fromSat?.version ?? null, recorded: bundleHost(id, P()).host === sat.id,
        tools: toolsState(sat, id, pin), pinned_at: pin?.approved_at ?? null,
      });
    }
    const p = Number(sat.agent_protocol);
    return {
      polled_at: typeof rec?.polled_at === "string" ? rec.polled_at.slice(0, 40) : null,
      error: typeof rec?.error === "string" ? rec.error.slice(0, 48) : null, sha: st?.sha ?? null,
      behind_by: st?.sha ? await behindBy(st.sha) : null,
      cert_days_left: certDaysLeft(sat, now()),
      mem: st?.mem ?? null, psi_memory_some_avg10: st?.psi_memory_some_avg10 ?? null,
      disk_free_bytes: st?.disk_free_bytes ?? null, uptime_s: st?.uptime_s ?? null,
      skew_ms: typeof rec?.skew_ms === "number" && Number.isFinite(rec.skew_ms) ? rec.skew_ms : null, installed,
      update_first: !Number.isInteger(p) || p < AGENT_PROTOCOL,
    };
  }

  function eligibleBundles() {
    let ids = [];
    try {
      ids = readdirSync(appBundlesDir(), { withFileTypes: true }).filter((d) => d.isDirectory() && BUNDLE_RE.test(d.name)).map((d) => d.name);
    } catch { return []; }
    return ids.filter((id) => { const m = manifestOf(id); return m && m.id === id && satelliteEligible(m); }).sort();
  }

  // ── actions ─────────────────────────────────────────────────────────────────────────────
  async function install(db, satId, body = {}) {
    const sat = await satOf(db, satId);
    gate(sat, "install");
    const id = bundleId(body.bundle);
    const m = manifestOf(id);
    if (!m || m.id !== id) throw no(404, "unknown_bundle");
    if (!satelliteEligible(m)) throw no(400, "not_satellite");
    const host = bundleHost(id, P());
    if (host.where === "local") throw no(409, "installed_locally");
    if (host.where === "satellite") throw no(409, host.host === sat.id ? "already_installed" : "installed_on_other_server", { host: host.host });
    if (body.env !== undefined && (typeof body.env !== "object" || body.env === null || Array.isArray(body.env))) throw no(400, "bad_env");
    for (const [k, v] of Object.entries(body.env || {})) {
      if (!ENV_KEY.test(k) || typeof v !== "string") throw no(400, "bad_env", { key: k });
    }
    const out = { id };
    if (body.env && Object.keys(body.env).length) out.env = body.env;
    if (typeof body.consent_token === "string") out.consent_token = body.consent_token;
    const r = await relay(sat, "POST", "/satellite/v1/bundles/install", out);
    if (r.status === 202 && JOB_RE.test(String(r.json.job_id))) { noteJob(sat.id, r.json.job_id, id, "install"); watch(sat.id, r.json.job_id); }
    return r;
  }

  async function consent(db, satId, bundle, body = {}) {
    const sat = await satOf(db, satId);
    gate(sat, "consent");
    const id = bundleId(bundle);
    return relay(sat, "POST", `/satellite/v1/bundles/${id}/consent`, { token: String(body.token ?? ""), accept: body.accept === true });
  }

  async function uninstall(db, satId, bundle) {
    const sat = await satOf(db, satId);
    gate(sat, "uninstall");
    const id = bundleId(bundle);
    const r = await relay(sat, "POST", "/satellite/v1/bundles/uninstall", { id });
    if (r.status === 202 && JOB_RE.test(String(r.json.job_id))) { noteJob(sat.id, r.json.job_id, id, "uninstall"); watch(sat.id, r.json.job_id); }
    // Not installed there any more: crow's records go too (a half-finished earlier uninstall;
    // the bundle id is the owner's, from this route, not the satellite's report).
    if (r.status === 404 && r.json.error === "not_installed") await removeRecords(db, sat, id);
    return r;
  }

  async function job(db, satId, jobId) {
    const sat = await satOf(db, satId);
    if (!JOB_RE.test(String(jobId))) throw no(400, "bad_job_id");
    const r = await relay(sat, "GET", `/satellite/v1/jobs/${jobId}`);
    if (r.status === 200) {
      const done = await finishJob(db, sat, r.json, jobId);
      if (done && done.ok === false) r.json = { ...r.json, crow_record: done.code };
    }
    return r;
  }

  async function simple(db, satId, op, method, pathFn, bodyFn, opts) {
    const sat = await satOf(db, satId);
    gate(sat, op);
    return relay(sat, method, pathFn(sat), bodyFn ? bodyFn(sat) : undefined, opts);
  }

  const lifecycle = (db, satId, bundle, action) => {
    if (!["start", "stop", "restart"].includes(action)) throw no(400, "bad_action");
    const id = bundleId(bundle);
    return simple(db, satId, action, "POST", () => `/satellite/v1/bundles/${id}/${action}`);
  };
  const repin = (db, satId, bundle) => { const id = bundleId(bundle); return simple(db, satId, "repin", "POST", () => "/satellite/v1/bundles/repin", () => ({ id })); };
  const getEnv = (db, satId, bundle) => { const id = bundleId(bundle); return simple(db, satId, "env", "GET", () => `/satellite/v1/bundles/${id}/env`); };
  function putEnv(db, satId, bundle, body = {}) {
    const id = bundleId(bundle);
    const e = body.env;
    if (!e || typeof e !== "object" || Array.isArray(e)) throw no(400, "bad_env");
    for (const [k, v] of Object.entries(e)) if (!ENV_KEY.test(k) || !(typeof v === "string" || v === null)) throw no(400, "bad_env", { key: k });
    return simple(db, satId, "env", "PUT", () => `/satellite/v1/bundles/${id}/env`, () => ({ env: e }));
  }
  function logs(db, satId, bundle, query = {}) {
    const id = bundleId(bundle);
    const qs = new URLSearchParams();
    if (query.tail !== undefined) {
      const n = Number(query.tail);
      if (!/^\d{1,4}$/.test(String(query.tail)) || n < 1 || n > 2000) throw no(400, "bad_tail");
      qs.set("tail", String(n));
    }
    if (query.since !== undefined) {
      if (typeof query.since !== "string" || !/^[0-9A-Za-z:.+-]{1,40}$/.test(query.since)) throw no(400, "bad_since");
      qs.set("since", query.since);
    }
    const q = qs.toString();
    return simple(db, satId, "logs", "GET", () => `/satellite/v1/bundles/${id}/logs${q ? `?${q}` : ""}`, null, { maxBytes: LOG_MAX_BYTES }).then((r) => {
      // The satellite caps its log at 256 KiB; crow holds it to that too, after parsing (review L3).
      if (r.status === 200) {
        const log = typeof r.json.log === "string" ? r.json.log : "";
        const buf = Buffer.from(log, "utf8");
        const capped = buf.length > LOG_TEXT_CAP ? buf.subarray(0, LOG_TEXT_CAP).toString("utf8").replace(/\uFFFD$/, "") : log;
        r.json = { log: capped, truncated: r.json.truncated === true || capped !== log };
      }
      return r;
    });
  }
  const backups = (db, satId, bundle) => { const id = bundleId(bundle); return simple(db, satId, "backups", "GET", () => `/satellite/v1/bundles/${id}/backups`); };

  async function update(db, satId) {
    const boot = bootShaFn();
    if (!SHA_RE.test(String(boot))) throw no(409, "no_boot_sha");
    return simple(db, satId, "update", "POST", () => "/satellite/v1/update", () => ({ target_sha: boot }));
  }

  async function refresh(db, satId) {
    const sat = await satOf(db, satId);
    const r = await thePoller.pollNow(db, sat.id);
    return { status: 200, json: { ok: !!r.ok, error: r.ok ? null : r.code } };
  }

  async function renewCert(db, satId) {
    const sat = await satOf(db, satId);
    const r = await theRenewer.renewOne(db, sat, { force: true });
    return { status: r.renewed ? 200 : 502, json: r.renewed ? { renewed: true, expires_at: r.expires_at } : { renewed: false, error: r.code } };
  }

  async function rotateKey(db, satId) {
    const sat = await satOf(db, satId);
    const r = await theRenewer.rotateKey(db, sat);
    const status = r.rotated ? 200 : ["rotation_pending", "revoked", "no_mgmt_key"].includes(r.code) ? 409 : 502;
    return { status, json: r.rotated ? { rotated: true } : { rotated: false, error: r.code } };
  }

  async function rename(db, satId, body = {}) {
    const sat = await satOf(db, satId);
    const name = typeof body.name === "string" ? body.name.trim() : "";
    if (!name || name.length > NAME_MAX || /[\u0000-\u001f\u007f]/.test(name)) throw no(400, "bad_name");
    if (!(await updateSatelliteIfNotRevoked(db, sat.id, { name }))) throw no(409, "revoked");
    return { status: 200, json: { ok: true, name } };
  }

  // ── tools and pins (spec §9.1) ──────────────────────────────────────────────────────────
  async function readTools(sat, id) {
    try {
      return await fetchToolList(sat, id, { fetchImpl, env });
    } catch (err) {
      throw no(err?.code === "refused" ? 409 : 502, err?.code === "refused" ? "tools_unavailable" : err?.code || "unreachable", err?.code === "refused" ? { detail: String(err.message).slice(0, 200) } : {});
    }
  }

  async function tools(db, satId, bundle) {
    const sat = await satOf(db, satId);
    gate(sat, "tools");
    const id = bundleId(bundle);
    const list = await readTools(sat, id);
    const pin = await getToolPin(db, sat.id, id);
    let old = [];
    try { old = pin ? JSON.parse(pin.tools_json) : []; } catch { old = []; }
    const reported = reportedTools(sat, id);
    const version = reported?.version ?? null;
    return {
      status: 200,
      json: {
        bundle: id, version, tools: list, tools_sha256: toolsSha(list), check: checkToolList(id, list), max_tools: MAX_TOOLS,
        pin: pin ? { tools_sha256: pin.tools_sha256, version: pin.version, approved_at: pin.approved_at } : null,
        diff: pin ? diffTools(old, list) : null,
        same_version: !!pin && pin.version != null && version != null && String(pin.version) === String(version),
      },
    };
  }

  async function approveTools(db, satId, bundle, body = {}) {
    const sat = await satOf(db, satId);
    gate(sat, "tools");
    const id = bundleId(bundle);
    if (bundleHost(id, P()).host !== sat.id) throw no(409, "not_installed_here");
    const list = await readTools(sat, id);
    const sha = toolsSha(list);
    if (body.tools_sha256 !== sha) throw no(409, "tools_changed", { tools_sha256: sha });
    if (checkToolList(id, list).tooMany) throw no(400, "too_many_tools", { max: MAX_TOOLS });
    const prev = await getToolPin(db, sat.id, id);
    await thePoller.pollNow(db, sat.id).catch(() => null); // the reported hash next to the pin
    const fresh = (await getSatellite(db, sat.id)) || sat;
    const version = reportedTools(fresh, id)?.version ?? manifestOf(id)?.version ?? null;
    await putToolPin(db, {
      satellite_id: sat.id, bundle: id, version: version == null ? null : String(version), tools_sha256: sha,
      tools_json: JSON.stringify(list),
      // Read marks are tied to the pinned hash: a new list clears them (spec §9.1).
      read_marks_json: prev && prev.tools_sha256 === sha ? prev.read_marks_json : "[]",
      approved_at: new Date(now()).toISOString(),
    });
    return { status: 200, json: { ok: true, tools_sha256: sha, state: toolsState(fresh, id, { tools_sha256: sha }).state } };
  }

  // ── unpair cleanup (the pairing service does the signed unpair and the revocation) ──────────
  function afterUnpair(satId) {
    for (const k of [...startedJobs.keys()]) if (k.startsWith(`${satId}:`)) startedJobs.delete(k);
    const ids = removeAllForSatellite({ satelliteId: satId, appBundles: appBundlesDir(), paths: P(), log });
    try { discardStagedMgmtKey(satId, { env }); } catch (err) { log(`[satellites] staged key ${satId}: ${err.message}`); }
    return ids;
  }

  const peers = async () => ({ status: 200, json: { peers: await peersFn() } });

  return {
    card, eligibleBundles, install, consent, uninstall, job, lifecycle, repin, getEnv, putEnv, logs, backups,
    update, refresh, renewCert, rotateKey, rename, tools, approveTools, afterUnpair, peers, finishJob,
    pendingJobs: (satId) => [...startedJobs.keys()].filter((k) => k.startsWith(`${satId}:`)).length,
    poller: thePoller, renewer: theRenewer, bootSha: () => bootShaFn() || null,
  };
}
