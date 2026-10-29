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
 *    ensureChild throws child_unavailable without spawning; recordChildFailure runs once. After
 *    the cooldown, a row left 'error' / child_unavailable is tried again (one single-flight
 *    start): success puts it back to active, another failure counts toward the next cooldown.
 *    Any other error (a failed live test, a folder refused at spawn) stays off until the owner
 *    acts (Restart or Test again).
 *  - Limits: idle stop after CROW_SERVICE_CHILD_IDLE_MS (default 600000); at most
 *    CROW_SERVICE_CHILD_MAX (default 2, an integer 1..32 overrides it) running per gateway, the least recently used idle one
 *    stopping to make room; none idle → busy. Connect timeout 60 s. The default is 2, not the
 *    plan's 6 (spec §12 budget: three gateways × the cap × one child's RSS ≤ 1.5 GB): a freshly
 *    started npx launcher chain (npm exec + sh + node) measured about 180 MB RSS.
 *  - Lifetime (a hard ceiling): a child is handed out for at most CROW_SERVICE_CHILD_MAX_LIFETIME_MS
 *    (default 1 h, bounded 1 min .. 24 h). Past it, ensureChild never returns it: idle, it is
 *    stopped; busy, it is retired (its calls finish on it) and a fresh one starts (single-flight;
 *    busy at the cap). At lifetime + CROW_SERVICE_CHILD_GRACE_MS (default 60 s, bounded
 *    1 s .. 10 min) it is stopped whatever is in flight, and those calls reject with
 *    child_unavailable. Each spawn re-runs the folder check and link walk, so a link planted
 *    while a child runs is seen at the next spawn, at most one lifetime later; no process lives
 *    past lifetime + grace.
 *  - Stop: the child's whole process tree (an npx launcher's npm exec → sh → node) is signalled,
 *    not only the direct child, so no grandchild keeps the credentials in its environment.
 *  - Credentials: read from the keychain at each spawn (serviceSecretsFor: active rows only) and
 *    put in the child's ENVIRONMENT only, never argv. A keychain key fault, or a declared secret
 *    that has no saved value, never spawns (child_unavailable); neither does a start that a stop
 *    (disconnect, uninstall) overtook while the credentials were being read. The environment is
 *    an allowlist (connectionChildEnv, M14): the gateway's own env and the add-on entry's env
 *    never reach it. The SDK's transport adds its own safe defaults under it (HOME, LOGNAME,
 *    PATH, SHELL, TERM, USER).
 *  - Tool cache: written at every successful start, sanitized with this child's injected values
 *    (sanitizeToolsForCache), since other projects' connections of the service read it.
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
import { existsSync, readFileSync, readdirSync } from "node:fs";
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
import { readToolCache, sanitizeToolsForCache, writeToolCache } from "./tool-cache.js";
import { loopbackErrorText } from "../loopback-tool-mount.js";

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
let beforeSpawnHook = null;
export function _setChildrenForTest({ windowMs, cooldownMs, connectTimeoutMs, folder, clock, beforeSpawn } = {}) {
  if (beforeSpawn !== undefined) beforeSpawnHook = beforeSpawn;
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
export const DEFAULT_MAX_CHILDREN = 2;
export const MAX_CHILDREN_CEILING = 32;
const idleMs = () => intEnv("CROW_SERVICE_CHILD_IDLE_MS", 600_000);
/** CROW_SERVICE_CHILD_MAX: an integer 1..32 overrides the default 2; anything else is ignored. */
const maxChildren = () => {
  const n = intEnv("CROW_SERVICE_CHILD_MAX", DEFAULT_MAX_CHILDREN);
  return n <= MAX_CHILDREN_CEILING ? n : DEFAULT_MAX_CHILDREN;
};

export const DEFAULT_MAX_LIFETIME_MS = 60 * 60_000;
const LIFETIME_MIN_MS = 60_000;
const LIFETIME_MAX_MS = 24 * 60 * 60_000;
/** CROW_SERVICE_CHILD_MAX_LIFETIME_MS: an integer 60000..86400000 overrides the default 1 h. */
const maxLifetimeMs = () => {
  const n = intEnv("CROW_SERVICE_CHILD_MAX_LIFETIME_MS", DEFAULT_MAX_LIFETIME_MS, LIFETIME_MIN_MS);
  return n <= LIFETIME_MAX_MS ? n : DEFAULT_MAX_LIFETIME_MS;
};

export const DEFAULT_GRACE_MS = 60_000;
const GRACE_MIN_MS = 1000;
const GRACE_MAX_MS = 10 * 60_000;
/** CROW_SERVICE_CHILD_GRACE_MS: an integer 1000..600000 overrides the default 60 s. */
const graceMs = () => {
  const n = intEnv("CROW_SERVICE_CHILD_GRACE_MS", DEFAULT_GRACE_MS, GRACE_MIN_MS);
  return n <= GRACE_MAX_MS ? n : DEFAULT_GRACE_MS;
};

/** The limits in force now (read from the env on every call). */
export function childLimits() {
  return { maxChildren: maxChildren(), idleMs: idleMs(), maxLifetimeMs: maxLifetimeMs(), graceMs: graceMs() };
}

/** uuid → record. A record outlives its process (cooldown, stderr, injected values). */
const records = new Map();
/** Children past their lifetime that still had calls in flight when a fresh one replaced them:
 * closed when their last call settles, or at their grace deadline whatever is in flight. */
const retiring = new Set();
/** One process's calls: in flight count and their aborts (a retired child keeps its own). */
const newHolder = () => ({ inFlight: 0, calls: new Set(), retired: null });

function recordFor(uuid) {
  let r = records.get(uuid);
  if (!r) {
    r = {
      uuid, serviceId: null, bundleId: null, state: "stopped", client: null, transport: null, tools: [],
      pid: null, startPromise: null, lastUsedAt: 0, h: newHolder(), idleTimer: null, generation: 0,
      stderr: [], secrets: [], failures: [], coolingUntil: 0, pendingRecord: false, startedAt: 0, lifeTimer: null, tree: [],
    };
    records.set(uuid, r);
  }
  return r;
}

const cooling = (r) => r.coolingUntil > now();
const isLive = (r) => r.state === "running" || r.startPromise != null;
const expired = (r) => r.state === "running" && now() - r.startedAt >= maxLifetimeMs();
const pastGrace = (startedAt) => now() >= startedAt + maxLifetimeMs() + graceMs();

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
 * CROW_ADDON_HOST="service"; then the connection's declared fields (config and secrets under
 * their field names); then the derived env. Nothing from the add-on entry's env: every service's
 * declared env_vars are its fields, and any other key there (a Crow-wide token under some name)
 * must never reach a project's child. `addonEntry` is accepted and ignored for that reason.
 * (derivedEnvFor mirrors legacy-sources.js addonDerivedEnv, which PR 4 deletes.)
 */
export function connectionChildEnv({ addonEntry: _addonEntry, service, config = {}, secrets = {}, base = process.env, crowHome = resolveCrowHome() } = {}) {
  const env = {};
  for (const [k, v] of Object.entries(base || {})) {
    if (typeof v === "string" && (BASE_KEYS.has(k) || k.startsWith("XDG_"))) env[k] = v;
  }
  env.CROW_HOME = crowHome;
  env.CROW_ADDON_HOST = "service";
  const fieldNames = new Set((service?.fields || []).map((f) => f.name));
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
    if (r.h.inFlight > 0) return scheduleIdle(r);
    stopCurrent(r.uuid).catch(() => {});
  }, idleMs());
  r.idleTimer.unref?.();
}

/** At the cap (retiring children count: they are still running), stop the least recently used
 * idle child; none idle → busy. Synchronous. */
function makeRoom() {
  const live = [...records.values()].filter(isLive);
  if (live.length + retiring.size < maxChildren()) return;
  const idle = live.filter((r) => r.state === "running" && r.h.inFlight === 0).sort((a, b) => a.lastUsedAt - b.lastUsedAt);
  if (!idle.length) throw new ChildError("busy");
  stopCurrent(idle[0].uuid).catch(() => {});
}

/** Each call is counted (idle, cap) and gets its own abort, fired when the child goes away: the
 * SDK rejects an open request on close but leaves its timeout timer running; an abort clears it. */
function wrapClient(r, client, h) {
  const callTool = client.callTool.bind(client);
  client.callTool = async (params, resultSchema, options = {}) => {
    const ac = new AbortController();
    h.calls.add(ac);
    const signal = options?.signal ? AbortSignal.any([options.signal, ac.signal]) : ac.signal;
    h.inFlight++;
    r.lastUsedAt = now();
    try {
      return await callTool(params, resultSchema, { ...options, signal });
    } catch (err) {
      // Cut by Crow (stop, exit, the grace deadline): a fixed class, never the SDK's text.
      if (ac.signal.aborted) throw new ChildError("child_unavailable");
      throw err;
    } finally {
      h.calls.delete(ac);
      h.inFlight--;
      if (h.retired) {
        if (h.inFlight === 0) closeRetired(h.retired);
      } else if (r.h === h) {
        touch(r);
        if (r.state === "running") r.tree = processTree(r.pid);
        // Past its lifetime: stopped at its first idle moment; the next call respawns it.
        if (expired(r) && h.inFlight === 0) stopCurrent(r.uuid).catch(() => {});
      }
    }
  };
  return client;
}

/**
 * Moves the running child out of its record (it keeps its in-flight calls) so a fresh one can
 * start under the same uuid. Synchronous. It is closed when its last call settles, or at its
 * grace deadline with whatever is still in flight cut (child_unavailable).
 */
function retire(r) {
  const d = { uuid: r.uuid, h: r.h, transport: r.transport, pid: r.pid, tree: r.tree, startedAt: r.startedAt, timer: null };
  r.h.retired = d;
  retiring.add(d);
  const wait = Math.max(0, r.startedAt + maxLifetimeMs() + graceMs() - now());
  d.timer = setTimeout(() => closeRetired(d), wait);
  d.timer.unref?.();
  r.generation++;
  if (r.idleTimer) { clearTimeout(r.idleTimer); r.idleTimer = null; }
  if (r.lifeTimer) { clearTimeout(r.lifeTimer); r.lifeTimer = null; }
  r.state = "stopped";
  r.transport = null;
  r.client = null;
  r.pid = null;
  r.tree = [];
  r.h = newHolder();
}

function closeRetired(d) {
  if (!retiring.has(d)) return;
  retiring.delete(d);
  if (d.timer) clearTimeout(d.timer);
  abortCalls(d.h);
  const tree = d.pid ? [...processTree(d.pid), ...(d.tree || [])] : d.tree || [];
  console.warn("[services] child exited (retired)");
  Promise.resolve().then(() => d.transport?.close()).catch(() => {}).then(() => reapTree(tree));
}

/** The hard ceiling: anything past lifetime + grace is stopped, calls in flight or not. */
function enforceDeadlines() {
  for (const d of [...retiring]) if (pastGrace(d.startedAt)) closeRetired(d);
  for (const r of records.values()) {
    if (r.state === "running" && pastGrace(r.startedAt)) stopCurrent(r.uuid).catch(() => {});
  }
}

// ---------------------------------------------------------------------------------------------
// The process tree (Linux /proc): an npx launcher is npm exec → sh → node, and closing the
// transport signals only the first. Each pid is kept with its start time, so a recycled pid is
// never signalled.

function startTimeOf(pid) {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf8");
    return stat.slice(stat.lastIndexOf(")") + 2).split(" ")[19] || null;
  } catch {
    return null;
  }
}

/** Every descendant of `pid` (not pid itself), each as {pid, start}. [] off Linux or when gone. */
export function processTree(pid) {
  const out = [];
  if (!Number.isInteger(pid) || pid <= 0) return out;
  const stack = [pid];
  const seen = new Set([pid]);
  while (stack.length && out.length < 256) {
    const p = stack.pop();
    let tids = [];
    try { tids = readdirSync(`/proc/${p}/task`); } catch { continue; }
    for (const tid of tids) {
      let kids = "";
      try { kids = readFileSync(`/proc/${p}/task/${tid}/children`, "utf8"); } catch { continue; }
      for (const k of kids.split(/\s+/).filter(Boolean).map(Number)) {
        if (seen.has(k)) continue;
        seen.add(k);
        const start = startTimeOf(k);
        if (start) out.push({ pid: k, start });
        stack.push(k);
      }
    }
  }
  return out;
}

function signalTree(tree, sig) {
  for (const { pid, start } of tree || []) {
    if (startTimeOf(pid) !== start) continue;   // gone, or the pid was reused
    try { process.kill(pid, sig); } catch { /* gone */ }
  }
}

/** SIGTERM what is left of the tree now, SIGKILL whatever survives 2 s. */
function reapTree(tree) {
  if (!tree || !tree.length) return;
  signalTree(tree, "SIGTERM");
  const t = setTimeout(() => signalTree(tree, "SIGKILL"), 2000);
  t.unref?.();
}

function abortCalls(h) {
  for (const ac of h.calls) { try { ac.abort(new Error("child stopped")); } catch { /* settled */ } }
  h.calls.clear();
}

function onExit(r, transport) {
  if (r.transport !== transport) {
    for (const d of retiring) if (d.transport === transport) closeRetired(d);
    return;
  }
  console.warn(`[services] child exited (${r.stderr.length} stderr lines)`);
  r.transport = null;
  r.client = null;
  r.pid = null;
  abortCalls(r.h);
  reapTree(r.tree);
  r.tree = [];
  if (r.lifeTimer) { clearTimeout(r.lifeTimer); r.lifeTimer = null; }
  if (r.idleTimer) { clearTimeout(r.idleTimer); r.idleTimer = null; }
  if (r.state === "running") {
    r.state = "error";
    noteFailure(r);
  }
}

/** The 'error' classes a start may try to disprove: child_unavailable always (after its cooldown);
 * a folder class only on the owner's Restart (repair) for a service with a folder field. */
function retryableClasses(service, repair) {
  const hasFolder = (service.fields || []).some((f) => f.kind === "folder");
  return repair && hasFolder ? ["child_unavailable", ...FOLDER_CLASSES] : ["child_unavailable"];
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

  if (beforeSpawnHook) await beforeSpawnHook(conn.uuid);
  // A Disconnect or uninstall that landed while the credentials were read: never spawn with them.
  if (r.generation !== generation) throw new ChildError("child_unavailable");
  const env = connectionChildEnv({ service, config: conn.config, secrets, crowHome });
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
  r.h = newHolder();
  r.client = wrapClient(r, client, r.h);
  r.pid = transport.pid;
  r.tools = tools;
  r.state = "running";
  r.startedAt = now();
  r.tree = processTree(r.pid);
  if (r.lifeTimer) clearTimeout(r.lifeTimer);
  // At the lifetime: stopped if idle; at lifetime + grace: stopped whatever is in flight.
  const atLife = () => {
    r.lifeTimer = null;
    if (r.generation !== generation || r.state !== "running") return;
    if (r.h.inFlight === 0 || pastGrace(r.startedAt)) return void stopCurrent(r.uuid).catch(() => {});
    r.lifeTimer = setTimeout(atLife, Math.max(1, r.startedAt + maxLifetimeMs() + graceMs() - now()));
    r.lifeTimer.unref?.();
  };
  r.lifeTimer = setTimeout(atLife, maxLifetimeMs());
  r.lifeTimer.unref?.();
  // client.onclose, not transport.onclose: the transport's handler belongs to the SDK, which
  // rejects every open request on close (so a pending callTool settles when the child exits).
  client.onclose = () => onExit(r, transport);
  try {
    // Sanitized with THIS child's values: other projects' connections of the service read it.
    writeToolCache(crowHome, service.id, version, sanitizeToolsForCache(tools, r.secrets));
  } catch {
    console.warn("[services] tool cache not written");
  }
  if (conn.status === "error") {
    try { await recordChildRecovered(db, conn.uuid, { classes: retryableClasses(service, repair) }); } catch { console.warn("[services] recovery not recorded"); }
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
  enforceDeadlines();
  const existing = records.get(uuid);
  if (existing && cooling(existing)) {
    existing.lastUsedAt = now();
    if (existing.pendingRecord) {
      existing.pendingRecord = false;
      try { await recordChildFailure(db, uuid); } catch { console.warn("[services] child failure not recorded"); }
    }
    throw new ChildError("child_unavailable");
  }
  const conn = await servableConnection(db, uuid, { allowError: true });
  if (!conn) throw new ChildError("not_active");
  const service = serviceById(conn.serviceId);
  if (!service || service.crowWide) throw new ChildError("not_installed");
  // An 'error' row: a transient child failure is retried once its cooldown is over; a folder
  // refused at spawn only on the owner's Restart; a failed live test never here.
  if (conn.status === "error" && !retryableClasses(service, repair).includes(conn.lastError)) throw new ChildError("not_active");

  // Synchronous from here to the start promise: concurrent callers share one start.
  const r = recordFor(uuid);
  if (cooling(r)) throw new ChildError("child_unavailable");
  r.serviceId = service.id;
  r.bundleId = service.bundleId;
  r.lastUsedAt = now();
  if (r.state === "running" && r.client && expired(r)) {
    // Never hand out an expired child: idle, it stops now; busy, it is retired (its calls finish
    // on it, up to its grace deadline) and a fresh one starts below, or busy at the cap.
    if (r.h.inFlight === 0) stopCurrent(uuid).catch(() => {});
    else retire(r);
  }
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

/** Stops the child and any retired child of the same uuid (disconnect, uninstall, idle, Restart). Safe to repeat. `forget` also drops
 * the record (its stderr and injected values) once the child is gone. */
export async function stopChild(uuid, { forget = false } = {}) {
  // Every retired (moved-aside) child of this uuid goes too, at once: its calls are cut with
  // child_unavailable and its tree killed, never left running until its grace deadline.
  for (const d of [...retiring]) if (d.uuid === uuid) closeRetired(d);
  return stopCurrent(uuid, { forget });
}

/** Stops only the record's current child. The internal stops (idle, cap, lifetime) use this, so
 * a retired child still finishing its calls is left to its own close (last call, grace). */
async function stopCurrent(uuid, { forget = false } = {}) {
  const r = records.get(uuid);
  if (!r) return;
  r.generation++;
  if (r.idleTimer) { clearTimeout(r.idleTimer); r.idleTimer = null; }
  if (r.lifeTimer) { clearTimeout(r.lifeTimer); r.lifeTimer = null; }
  const transport = r.transport;
  const tree = r.pid ? [...processTree(r.pid), ...(r.tree || [])] : r.tree || [];
  r.state = "stopped";
  r.transport = null;
  r.client = null;
  r.pid = null;
  r.tree = [];
  abortCalls(r.h);
  if (transport) {
    console.warn(`[services] child exited (${r.stderr.length} stderr lines)`);
    try { await transport.close(); } catch { /* gone */ }
  }
  reapTree(tree);
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
  for (const d of [...retiring]) closeRetired(d);
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
    lastUsedAt: r.lastUsedAt || null, inFlight: r.h.inFlight, stderrLines: r.stderr.length,
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
  const conn = await servableConnection(db, uuid);   // only a connection that may be served
  if (!conn) return null;
  return serviceTools(conn.serviceId, { crowHome });
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
const IMAGE_MIME = new Set(["image/png", "image/jpeg", "image/gif", "image/webp"]);
const BASE64_RE = /^[A-Za-z0-9+/]*={0,2}$/;
const TOOL_CODES = new Set([
  "busy", "child_unavailable", "not_installed", "unreachable", "tools_changed",
  "not_owner_turn", "scope_unknown", "wrong_project", "not_selected", "owner_mismatch", "not_granted", "not_active",
]);
const isPlainObject = (v) => v !== null && typeof v === "object" && !Array.isArray(v);
const errResult = (text) => ({ content: [{ type: "text", text }], isError: true });

/**
 * A child's tools/call result made safe to show, by the loopback mount's own rules
 * (loopback-tool-mount.js runTool step 6, mirrored because it isn't exported there; a parity
 * test feeds both the same results). Task 20's dashboard chat bypasses the mount and uses this
 * with `secrets: childSecretValues(uuid)`:
 *  - a non-object result, or one without a content array: its `code` (if a known one) or
 *    "<tool> failed.";
 *  - items rebuilt from an allowlist: text → {type, text}; image → {type, mimeType, data} for
 *    png/jpeg/gif/webp and a base64 string; everything else dropped, with one fixed note;
 *  - text redacted as one text across items (redactAcross) with `secrets`;
 *  - only content and isError survive; over `maxBytes` (JSON, images count) → "Result too
 *    large (<n> KiB)." as an error; any throw while shaping → "<tool> failed.".
 * The texts are the mount's (loopbackErrorText), in `lang`.
 * @returns {{content: object[], isError?: true}}
 */
export function shapeServiceResult(result, { secrets = [], maxBytes = SERVICE_RESULT_MAX_BYTES, lang = "en", tool = "The tool", contentTypes = ["text", "image"] } = {}) {
  const kinds = new Set(contentTypes);
  const fail = (code, o = {}) => errResult(loopbackErrorText(code, { lang, tool, ...o }));
  let out, bytes;
  try {
    if (!isPlainObject(result) || !Array.isArray(result.content)) {
      const code = isPlainObject(result) && typeof result.code === "string" && TOOL_CODES.has(result.code) ? result.code : "failed";
      return fail(code);
    }
    const sec = Array.isArray(secrets) ? secrets : [];
    const content = [];
    const texts = [];
    let dropped = 0;
    for (const item of result.content) {
      const kind = isPlainObject(item) && kinds.has(item.type) ? item.type : null;
      const text = kind === "text" ? item.text : undefined;
      if (kind === "text" && typeof text === "string") { texts.push(content.length); content.push({ type: "text", text }); }
      else if (kind === "image" && typeof item.mimeType === "string" && IMAGE_MIME.has(item.mimeType) && typeof item.data === "string" && BASE64_RE.test(item.data)) {
        content.push({ type: "image", mimeType: item.mimeType, data: item.data });
      } else dropped++;
    }
    const redacted = redactAcross(texts.map((i) => content[i].text), sec);
    texts.forEach((i, k) => { content[i] = { type: "text", text: redacted[k] }; });
    if (dropped) content.push({ type: "text", text: loopbackErrorText("dropped", { lang, n: dropped }) });
    out = { content };
    if (result.isError === true) out.isError = true;
    bytes = Buffer.byteLength(JSON.stringify(out));
  } catch {
    return fail("failed");
  }
  if (bytes > maxBytes) return fail("too_large", { kib: Math.ceil(bytes / 1024) });
  return out;
}
