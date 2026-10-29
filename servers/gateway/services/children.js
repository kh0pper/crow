/**
 * One stdio MCP child per project service connection (project services Task 14).
 *
 * Its own registry: nothing here imports or writes proxy.js's connectedServers (builder check
 * §11), so a connection's tools never reach /router/mcp, /tools/mcp, voice or peers.
 *
 *  - Lazy: nothing starts until ensureChild. Listing tools reads the per-service cache
 *    (tool-cache.js, I3) and never starts anything.
 *  - Single-flight (I4): concurrent ensureChild calls for one uuid share one start.
 *  - Cooldown (I4): 3 failed starts or unexpected exits within 5 minutes → 5 minutes in which
 *    ensureChild throws child_unavailable without spawning; recordChildFailure runs once.
 *  - Limits: idle stop after CROW_SERVICE_CHILD_IDLE_MS (default 600000); at most
 *    CROW_SERVICE_CHILD_MAX (default 2) running per gateway, the least recently used idle one
 *    stopping to make room; none idle → busy. Connect timeout 60 s. The default is 2, not the
 *    plan's 6 (spec §12 budget: three gateways × the cap × one child's RSS ≤ 1.5 GB): a freshly
 *    started npx launcher chain (npm exec + sh + node) measured about 180 MB RSS.
 *  - Credentials: read from the keychain at each spawn (serviceSecretsFor: active rows only) and
 *    put in the child's ENVIRONMENT only, never argv. A keychain key fault, or a declared secret
 *    that has no saved value, never spawns (child_unavailable). The environment is an allowlist
 *    (connectionChildEnv, M14): the gateway's own env never leaks a Crow-wide token in.
 *  - Serving: only the local owner's active connection in a project that is not archived
 *    (servableConnection, m8), else not_active. Every folder field is re-checked at spawn with the
 *    shared folderRefusal, including symlinks planted inside it (M4).
 *  - Stderr (I6): piped, never written to the console; each line has this connection's injected
 *    values replaced by [redacted] and is kept in a 50-line ring buffer (Settings → Advanced).
 *    The console gets fixed lines only, and one line per exit with the stderr line count.
 *
 * Errors are ChildError with `code` one of not_installed | not_active | child_unavailable | busy.
 * A pending callTool settles when its child exits (the SDK rejects open requests on close).
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

import { resolveCrowHome } from "../../shared/crow-home.js";
import { serviceById, renderDerivedEnv } from "../../shared/service-catalog.js";
import { recordChildFailure, recordChildRecovered, servableConnection } from "../../shared/service-connections.js";
import { redactAcross, redactSecrets, redactThenTruncate, MIN_SECRET_LENGTH } from "../../shared/redact-secrets.js";
import { resolveAddonCommand, checkLauncherArgs } from "../../shared/resolve-command.js";
import { serviceSecretsFor } from "../keychain/store.js";
import { loadKeychainKey } from "../keychain/key.js";
import { folderRefusal } from "./connect-test.js";
import { readToolCache, writeToolCache } from "./tool-cache.js";

export const CHILD_ERROR_CODES = Object.freeze(new Set(["not_installed", "not_active", "child_unavailable", "busy"]));

export class ChildError extends Error {
  constructor(code) {
    super(CHILD_ERROR_CODES.has(code) ? code : "child_unavailable");
    this.name = "ChildError";
    this.code = this.message;
  }
}

const STDERR_LINES = 50;
const LINE_MAX = 2048;
const FAILURES_TO_COOL = 3;
const FOLDER_CLASSES = ["forbidden_target", "not_found", "not_a_vault"];

const timing = { windowMs: 5 * 60_000, cooldownMs: 5 * 60_000, connectTimeoutMs: 60_000 };
let folderOpts = {};
let now = () => Date.now();

/** Tests only: shorter windows, a folder scan without the host's instance scan, a clock. */
export function _setChildrenForTest({ windowMs, cooldownMs, connectTimeoutMs, folder, clock } = {}) {
  if (windowMs != null) timing.windowMs = windowMs;
  if (cooldownMs != null) timing.cooldownMs = cooldownMs;
  if (connectTimeoutMs != null) timing.connectTimeoutMs = connectTimeoutMs;
  if (folder !== undefined) folderOpts = folder || {};
  if (clock !== undefined) now = clock || (() => Date.now());
}

function intEnv(name, dflt, min = 1) {
  const n = Number(process.env[name]);
  return Number.isInteger(n) && n >= min ? n : dflt;
}
const idleMs = () => intEnv("CROW_SERVICE_CHILD_IDLE_MS", 600_000);
const maxChildren = () => intEnv("CROW_SERVICE_CHILD_MAX", 2);

/** uuid → record. A record outlives its process (cooldown, stderr, injected values). */
const records = new Map();

function recordFor(uuid) {
  let r = records.get(uuid);
  if (!r) {
    r = {
      uuid, serviceId: null, bundleId: null, state: "stopped", client: null, transport: null, tools: [],
      pid: null, startPromise: null, lastUsedAt: 0, inFlight: 0, idleTimer: null, generation: 0,
      stderr: [], secrets: [], failures: [], coolingUntil: 0, pendingRecord: false, calls: new Set(),
    };
    records.set(uuid, r);
  }
  return r;
}

const cooling = (r) => r.coolingUntil > now();
const isLive = (r) => r.state === "running" || r.startPromise != null;

// ---------------------------------------------------------------------------------------------
// Environment (M14)

const BASE_KEYS = new Set([
  "PATH", "HOME", "LANG", "LC_ALL", "TZ", "TMPDIR",
  "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY", "http_proxy", "https_proxy", "no_proxy",
  "NODE_EXTRA_CA_CERTS", "SSL_CERT_FILE", "SSL_CERT_DIR",
]);

/** Derived env (connect.derived_env), rendered from this connection's values only. A key whose
 * fields are not all set is left out, the rule Crow-wide add-ons follow (addonDerivedEnv). */
function derivedEnvFor(service, values) {
  const out = renderDerivedEnv(service, values);
  for (const [key, spec] of Object.entries(service.derivedEnv || {})) {
    const names = [...String(spec.template).matchAll(/\$\{([A-Za-z0-9_]+)\}/g)].map((m) => m[1]);
    if (names.some((n) => !values[n])) delete out[key];
  }
  return out;
}

/**
 * The child's environment: from `base` only the allowlisted keys (and XDG_*); then CROW_HOME and
 * CROW_ADDON_HOST="service"; then the add-on entry's env minus every field and derived key (a
 * Crow-wide token in mcp-addons.json never reaches a project's child); then the connection's
 * config and secrets under their field names; then the derived env.
 */
export function connectionChildEnv({ addonEntry, service, config = {}, secrets = {}, base = process.env, crowHome = resolveCrowHome() } = {}) {
  const env = {};
  for (const [k, v] of Object.entries(base || {})) {
    if (typeof v === "string" && (BASE_KEYS.has(k) || k.startsWith("XDG_"))) env[k] = v;
  }
  env.CROW_HOME = crowHome;
  env.CROW_ADDON_HOST = "service";
  const fieldNames = new Set((service?.fields || []).map((f) => f.name));
  const derivedNames = new Set(Object.keys(service?.derivedEnv || {}));
  for (const [k, v] of Object.entries(addonEntry?.env || {})) {
    if (fieldNames.has(k) || derivedNames.has(k) || k === "CROW_HOME" || k === "CROW_ADDON_HOST") continue;
    if (typeof v === "string") env[k] = v;
  }
  const values = {};
  for (const [k, v] of Object.entries(config || {})) if (fieldNames.has(k) && typeof v === "string") values[k] = v;
  for (const [k, v] of Object.entries(secrets || {})) if (fieldNames.has(k) && typeof v === "string") values[k] = v;
  Object.assign(env, values);
  if (service) Object.assign(env, derivedEnvFor(service, values));
  return env;
}

/** The values to redact for one child: each secret, plus its JSON-escaped spelling when that differs. */
function secretValuesOf(secrets) {
  const out = new Set();
  for (const v of Object.values(secrets || {})) {
    if (typeof v !== "string" || v.length < MIN_SECRET_LENGTH) continue;
    out.add(v);
    const j = JSON.stringify(v).slice(1, -1);
    if (j !== v) out.add(j);
  }
  return [...out];
}

// ---------------------------------------------------------------------------------------------
// Installed add-on

function readJson(p) {
  try { return JSON.parse(readFileSync(p, "utf8")); } catch { return null; }
}

/** The installed record's version (installed.json), else the bundle folder's manifest, else null. */
function installedVersion(crowHome, bundleId) {
  const raw = readJson(join(crowHome, "installed.json"));
  let found = false;
  let version = null;
  if (Array.isArray(raw)) {
    for (const e of raw) {
      const id = typeof e === "string" ? e : e?.id;
      if (id === bundleId) { found = true; version = typeof e === "object" && typeof e.version === "string" ? e.version : null; }
    }
  } else if (raw && typeof raw === "object" && Object.hasOwn(raw, bundleId)) {
    found = true;
    version = typeof raw[bundleId]?.version === "string" ? raw[bundleId].version : null;
  }
  if (!found) return { installed: false, version: null };
  if (!version) {
    const m = readJson(join(crowHome, "bundles", bundleId, "manifest.json"));
    version = typeof m?.version === "string" ? m.version : null;
  }
  return { installed: true, version };
}

function addonEntryFor(crowHome, bundleId) {
  const all = readJson(join(crowHome, "mcp-addons.json"));
  const e = all && typeof all === "object" ? all[bundleId] : null;
  if (!e || typeof e !== "object" || e.url || (e.transport && String(e.transport).toLowerCase() !== "stdio")) return null;
  return typeof e.command === "string" && e.command ? e : null;
}

// ---------------------------------------------------------------------------------------------
// Failures and the cooldown

function noteFailure(r, { recorded = false } = {}) {
  const t = now();
  r.failures = r.failures.filter((x) => t - x < timing.windowMs);
  r.failures.push(t);
  if (r.failures.length >= FAILURES_TO_COOL) {
    r.coolingUntil = t + timing.cooldownMs;
    r.failures = [];
    r.pendingRecord = !recorded;
    console.warn("[services] child failed repeatedly, cooling down");
  }
}

async function failStart(db, r, { record = false, error = "child_unavailable" } = {}) {
  if (record) {
    try { await recordChildFailure(db, r.uuid, { error }); } catch { console.warn("[services] child failure not recorded"); }
  }
  noteFailure(r, { recorded: record });
  if (r.pendingRecord) {
    r.pendingRecord = false;
    try { await recordChildFailure(db, r.uuid); } catch { console.warn("[services] child failure not recorded"); }
  }
  return new ChildError("child_unavailable");
}

/** Forgets the failure count and any cooldown (Restart, a passing Test again). */
export function resetChildFailures(uuid) {
  const r = records.get(uuid);
  if (!r) return;
  r.failures = [];
  r.coolingUntil = 0;
  r.pendingRecord = false;
}

// ---------------------------------------------------------------------------------------------
// Stderr

function attachStderr(r, transport, generation) {
  const stream = transport.stderr;
  if (!stream) return;
  let partial = "";
  let discarding = false;
  const push = (line) => {
    r.stderr.push(line);
    if (r.stderr.length > STDERR_LINES) r.stderr.splice(0, r.stderr.length - STDERR_LINES);
  };
  const longest = () => r.secrets.reduce((m, s) => Math.max(m, s.length), 0);
  stream.setEncoding?.("utf8");
  stream.on("data", (chunk) => {
    if (r.generation !== generation) return;
    partial += String(chunk);
    let nl;
    while ((nl = partial.indexOf("\n")) !== -1) {
      const line = partial.slice(0, nl).replace(/\r$/, "");
      partial = partial.slice(nl + 1);
      if (discarding) { discarding = false; continue; }
      push(redactSecrets(line, r.secrets).slice(0, LINE_MAX));
    }
    // An endless line: redact what is held (it holds any secret that starts inside the kept part
    // whole), keep the first LINE_MAX characters, drop the rest up to the next newline.
    if (!discarding && partial.length >= LINE_MAX + longest()) {
      push(redactThenTruncate(partial, r.secrets, LINE_MAX).toString("utf8") + " [truncated]");
      partial = "";
      discarding = true;
    } else if (discarding) {
      partial = "";
    }
  });
  stream.on("error", () => { /* the child's exit is what counts */ });
}

// ---------------------------------------------------------------------------------------------
// Lifecycle

function touch(r) {
  r.lastUsedAt = now();
  scheduleIdle(r);
}

function scheduleIdle(r) {
  if (r.idleTimer) clearTimeout(r.idleTimer);
  r.idleTimer = null;
  if (r.state !== "running") return;
  r.idleTimer = setTimeout(() => {
    r.idleTimer = null;
    if (r.state !== "running") return;
    if (r.inFlight > 0) return scheduleIdle(r);
    stopChild(r.uuid).catch(() => {});
  }, idleMs());
  r.idleTimer.unref?.();
}

/** At the cap, stop the least recently used idle child; none idle → busy. Synchronous. */
function makeRoom() {
  const live = [...records.values()].filter(isLive);
  if (live.length < maxChildren()) return;
  const idle = live.filter((r) => r.state === "running" && r.inFlight === 0).sort((a, b) => a.lastUsedAt - b.lastUsedAt);
  if (!idle.length) throw new ChildError("busy");
  stopChild(idle[0].uuid).catch(() => {});
}

/** Each call is counted (idle, cap) and gets its own abort, fired when the child goes away: the
 * SDK rejects an open request on close but leaves its timeout timer running; an abort clears it. */
function wrapClient(r, client) {
  const callTool = client.callTool.bind(client);
  client.callTool = async (params, resultSchema, options = {}) => {
    const ac = new AbortController();
    r.calls.add(ac);
    const signal = options?.signal ? AbortSignal.any([options.signal, ac.signal]) : ac.signal;
    r.inFlight++;
    r.lastUsedAt = now();
    try {
      return await callTool(params, resultSchema, { ...options, signal });
    } finally {
      r.calls.delete(ac);
      r.inFlight--;
      touch(r);
    }
  };
  return client;
}

function abortCalls(r) {
  for (const ac of r.calls) { try { ac.abort(new Error("child stopped")); } catch { /* settled */ } }
  r.calls.clear();
}

function onExit(r, transport) {
  if (r.transport !== transport) return;
  console.warn(`[services] child exited (${r.stderr.length} stderr lines)`);
  r.transport = null;
  r.client = null;
  r.pid = null;
  abortCalls(r);
  if (r.idleTimer) { clearTimeout(r.idleTimer); r.idleTimer = null; }
  if (r.state === "running") {
    r.state = "error";
    noteFailure(r);
  }
}

/** Whether a Restart may start this 'error' row: a failure a start can disprove. */
function repairableClasses(service) {
  const hasFolder = (service.fields || []).some((f) => f.kind === "folder");
  return hasFolder ? ["child_unavailable", ...FOLDER_CLASSES] : ["child_unavailable"];
}

async function start(db, r, conn, service, { key, crowHome, repair }) {
  const generation = ++r.generation;
  r.state = "starting";
  r.stderr = [];
  const { installed, version } = installedVersion(crowHome, service.bundleId);
  const entry = installed ? addonEntryFor(crowHome, service.bundleId) : null;
  if (!entry) { r.state = "stopped"; throw new ChildError("not_installed"); }
  r.state = "error";

  // M4: every folder, as it is now (a swapped root, a planted symlink).
  for (const f of service.fields || []) {
    if (f.kind !== "folder") continue;
    const refusal = folderRefusal(conn.config?.[f.name], {
      crowHome, expectEntry: service.test?.expect_entry ?? null, scanLinks: true, ...folderOpts,
    });
    if (refusal) {
      console.warn("[services] folder refused at start: " + refusal);
      throw await failStart(db, r, { record: true, error: refusal });
    }
  }

  const secretNames = (service.fields || []).filter((f) => f.kind === "secret").map((f) => f.name);
  let secrets = {};
  if (secretNames.length) {
    try {
      const k = key === undefined ? loadKeychainKey({ crowHome }) : key;
      secrets = await serviceSecretsFor(db, k, conn.uuid, { allowedKeys: secretNames });
    } catch (err) {
      console.warn(err?.code === "KEYCHAIN_KEY_MISSING"
        ? "services: keychain key missing, child not started"
        : "services: credentials unreadable, child not started");
      throw await failStart(db, r, { record: true });
    }
    if (secretNames.some((n) => typeof secrets[n] !== "string" || !secrets[n])) {
      console.warn("services: credentials missing, child not started");
      throw await failStart(db, r, { record: true });
    }
  }

  const cwd = typeof entry.cwd === "string" && entry.cwd ? entry.cwd : join(crowHome, "bundles", service.bundleId);
  const rc = resolveAddonCommand(entry.command, { sha256: entry.command_sha256, cwd });
  if (rc.missing || checkLauncherArgs(rc.command, entry.args)) {
    console.warn("[services] launcher not usable, child not started");
    throw await failStart(db, r);
  }
  if (!existsSync(cwd)) {
    console.warn("[services] add-on folder missing, child not started");
    throw await failStart(db, r);
  }

  const env = connectionChildEnv({ addonEntry: entry, service, config: conn.config, secrets, crowHome });
  r.secrets = secretValuesOf(secrets);
  const transport = new StdioClientTransport({
    command: rc.command, args: Array.isArray(entry.args) ? entry.args.map(String) : [], env, cwd, stderr: "pipe",
  });
  attachStderr(r, transport, generation);
  const client = new Client({ name: `crow-service-${service.id}`, version: "1.0.0" });
  let timer;
  let tools;
  const ac = new AbortController();   // clears the SDK's request timers when the start fails
  const reqOpts = { signal: ac.signal, timeout: timing.connectTimeoutMs };
  try {
    await Promise.race([
      (async () => {
        await client.connect(transport, reqOpts);
        tools = (await client.listTools(undefined, reqOpts)).tools || [];
      })(),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error("timeout")), timing.connectTimeoutMs); timer.unref?.(); }),
    ]);
  } catch {
    clearTimeout(timer);
    ac.abort();
    try { await transport.close(); } catch { /* gone */ }
    console.warn(`[services] child did not start (${r.stderr.length} stderr lines)`);
    if (r.generation !== generation) throw new ChildError("child_unavailable");
    throw await failStart(db, r);
  }
  clearTimeout(timer);
  if (r.generation !== generation) {
    // Stopped (disconnect, uninstall) while it was starting.
    try { await transport.close(); } catch { /* gone */ }
    throw new ChildError("child_unavailable");
  }
  r.transport = transport;
  r.client = wrapClient(r, client);
  r.pid = transport.pid;
  r.tools = tools;
  r.state = "running";
  // client.onclose, not transport.onclose: the transport's handler belongs to the SDK, which
  // rejects every open request on close (so a pending callTool settles when the child exits).
  client.onclose = () => onExit(r, transport);
  try {
    writeToolCache(crowHome, service.id, version, tools.map((t) => ({
      ...t, description: typeof t?.description === "string" ? redactSecrets(t.description, r.secrets) : undefined,
    })));
  } catch {
    console.warn("[services] tool cache not written");
  }
  if (repair && conn.status === "error") {
    try { await recordChildRecovered(db, conn.uuid, { classes: repairableClasses(service) }); } catch { console.warn("[services] recovery not recorded"); }
  }
  touch(r);
  return { client: r.client, tools: r.tools };
}

/**
 * The connection's child, started if needed. `key`: the keychain key (default: loaded from
 * `crowHome`). `repair` (the owner's Restart only): an 'error' row whose error a start can
 * disprove may start, and goes back to active when it does.
 * @returns {Promise<{client: import("@modelcontextprotocol/sdk/client/index.js").Client, tools: object[]}>}
 */
export async function ensureChild(db, uuid, { key, crowHome = resolveCrowHome(), repair = false } = {}) {
  const existing = records.get(uuid);
  if (existing && cooling(existing)) {
    existing.lastUsedAt = now();
    if (existing.pendingRecord) {
      existing.pendingRecord = false;
      try { await recordChildFailure(db, uuid); } catch { console.warn("[services] child failure not recorded"); }
    }
    throw new ChildError("child_unavailable");
  }
  const conn = await servableConnection(db, uuid, { allowError: repair });
  if (!conn) throw new ChildError("not_active");
  const service = serviceById(conn.serviceId);
  if (!service || service.crowWide) throw new ChildError("not_installed");
  if (conn.status === "error" && !(repair && repairableClasses(service).includes(conn.lastError))) throw new ChildError("not_active");

  // Synchronous from here to the start promise: concurrent callers share one start.
  const r = recordFor(uuid);
  if (cooling(r)) throw new ChildError("child_unavailable");
  r.serviceId = service.id;
  r.bundleId = service.bundleId;
  r.lastUsedAt = now();
  if (r.state === "running" && r.client) {
    touch(r);
    return { client: r.client, tools: r.tools };
  }
  if (r.startPromise) return r.startPromise;
  makeRoom();
  const p = start(db, r, conn, service, { key, crowHome, repair });
  r.startPromise = p;
  const clear = () => { if (r.startPromise === p) r.startPromise = null; };
  p.then(clear, clear);
  return p;
}

/** Stops the child (disconnect, uninstall, idle, Restart). Safe to repeat. `forget` also drops
 * the record (its stderr and injected values) once the child is gone. */
export async function stopChild(uuid, { forget = false } = {}) {
  const r = records.get(uuid);
  if (!r) return;
  r.generation++;
  if (r.idleTimer) { clearTimeout(r.idleTimer); r.idleTimer = null; }
  const transport = r.transport;
  r.state = "stopped";
  r.transport = null;
  r.client = null;
  r.pid = null;
  abortCalls(r);
  if (transport) {
    console.warn(`[services] child exited (${r.stderr.length} stderr lines)`);
    try { await transport.close(); } catch { /* gone */ }
  }
  if (forget) records.delete(uuid);
}

/** Closes one connection's in-flight calls by stopping its child (the mount's cancelCall hook). */
export const cancelCall = (uuid) => stopChild(uuid);

/** Uninstall: stops every child of that bundle. */
export async function stopChildrenForBundle(bundleId) {
  const mine = [...records.values()].filter((r) => r.bundleId === bundleId).map((r) => r.uuid);
  await Promise.all(mine.map((u) => stopChild(u)));
  return mine.length;
}

/** Gateway shutdown and tests: stops every child and forgets every record. */
export async function stopAllChildren() {
  await Promise.all([...records.keys()].map((u) => stopChild(u, { forget: true })));
}

/** @returns {"running"|"starting"|"stopped"|"error"|"cooling"} */
export function childState(uuid) {
  const r = records.get(uuid);
  if (!r) return "stopped";
  if (cooling(r)) return "cooling";
  if (r.startPromise) return "starting";
  return r.state === "running" || r.state === "error" ? r.state : "stopped";
}

/** Every known child: no values, ever. */
export function listChildren() {
  return [...records.values()].map((r) => ({
    uuid: r.uuid, serviceId: r.serviceId, state: childState(r.uuid), pid: r.pid,
    lastUsedAt: r.lastUsedAt || null, inFlight: r.inFlight, stderrLines: r.stderr.length,
  }));
}

/** The redacted stderr ring buffer (Settings → Advanced). */
export function childStderr(uuid) {
  return [...(records.get(uuid)?.stderr || [])];
}

/** The values injected into this connection's child at its last spawn (for masking its results). */
export function childSecretValues(uuid) {
  return [...(records.get(uuid)?.secrets || [])];
}

/**
 * The cached tools of a connection's service, without starting anything (null: no cache yet,
 * or the installed version changed since). Reads the row for its service only.
 */
export async function listedTools(db, uuid, { crowHome = resolveCrowHome() } = {}) {
  const r = (await db.execute({ sql: "SELECT service_id FROM service_connections WHERE uuid = ?", args: [uuid] })).rows[0];
  if (!r) return null;
  return serviceTools(r.service_id, { crowHome });
}

/** A service's cached tools at its installed version (null on a miss). Starts nothing. */
export function serviceTools(serviceId, { crowHome = resolveCrowHome() } = {}) {
  const service = serviceById(serviceId);
  if (!service) return null;
  const { installed, version } = installedVersion(crowHome, service.bundleId);
  if (!installed) return null;
  return readToolCache(crowHome, service.id, version);
}

export const SERVICE_RESULT_MAX_BYTES = 256 * 1024;

/**
 * A child's tools/call result made safe to show (Task 17's mount shapes its own; Task 20's
 * dashboard chat, which bypasses the mount, uses this): text items only (others are dropped), redacted as one text with
 * the values injected into that child (a secret split over two items is caught), capped at
 * `maxBytes` (redacted first, then cut). No other field survives but isError.
 * @returns {{content: Array<{type:"text", text:string}>, isError?: true, truncated?: true}}
 */
export function shapeServiceResult(result, uuid, { maxBytes = SERVICE_RESULT_MAX_BYTES } = {}) {
  const secrets = childSecretValues(uuid);
  const items = result && typeof result === "object" && Array.isArray(result.content) ? result.content : [];
  const texts = items.filter((i) => i && typeof i === "object" && i.type === "text" && typeof i.text === "string").map((i) => i.text);
  const redacted = redactAcross(texts, secrets);
  const content = [];
  let used = 0;
  let truncated = false;
  for (const text of redacted) {
    const bytes = Buffer.byteLength(text);
    if (used + bytes <= maxBytes) { content.push({ type: "text", text }); used += bytes; continue; }
    const room = maxBytes - used;
    // Already redacted: a cut can only shorten a [redacted] marker, never expose a value.
    if (room > 0) content.push({ type: "text", text: Buffer.from(text).subarray(0, room).toString("utf8").replace(/�$/, "") });
    truncated = true;
    break;
  }
  const out = { content };
  if (result?.isError === true) out.isError = true;
  if (truncated) out.truncated = true;
  return out;
}
