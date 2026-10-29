/**
 * The project Services JSON API (project services Task 9): list a project's services, connect
 * one with Connect and test, test it again, disconnect it.
 *
 *   GET  /dashboard/services/api/project/:slug                  the page's data (loadServicesPage)
 *   POST /dashboard/services/api/project/:slug/connect          {serviceId, accountLabel, values}
 *   POST /dashboard/services/api/connection/:uuid/test          test again
 *   POST /dashboard/services/api/connection/:uuid/disconnect    idempotent; stops the connection's child
 *   POST /dashboard/services/api/connection/:uuid/restart       Settings → Advanced (R8): stop the child,
 *                                                               clear its cooldown, start it once (Task 14)
 *   POST /dashboard/services/api/connection/:uuid/sensitive     {sensitive: bool}: the owner's "Private"
 *                                                               switch (Task 16c). OWNER ONLY: a local
 *                                                               password session from another machine
 *                                                               (isLocalPasswordSessionOn), else 403
 *                                                               not_owner; a locked service 400 bad_value
 *   GET  /dashboard/services/api/uninstall-preflight/:id        read-only: {affectedProjects:[{slug, name}]}
 *                                                               for the Extensions uninstall confirm (Task 12)
 *
 * Auth: the dashboard session gate (requireDashboardSessionJson: JSON 401/403, and it refuses
 * the Funnel), then the flag (404 while CROW_SERVICES_UI is off), then CSRF on every POST. A
 * peer-signed request is refused outright (csrfMiddleware would let a signed request through).
 * NEVER add this prefix to PUBLIC_FUNNEL_PREFIXES.
 *
 * Secrets: a value typed into the connect sheet goes to the live test and then to the keychain,
 * nowhere else. No answer carries a value (fields read "set" / "unset" from keychain metadata,
 * never decrypted), and nothing here logs a body, a value or an upstream message: the logs are
 * fixed lines ("[services] connect failed: <class>"). The connect body has its own small parser
 * (the gateway's global parser skips this prefix, index.js `_hasOwnParser`), whose failures
 * answer `bad_value` and log only "[services] bad body". Each saved secret's hash is recorded for
 * masking (recordServiceSecretValues) before it is saved.
 *
 * Errors: only the plan's classes. A keychain key fault answers 500 with no class and a fixed
 * log line.
 */
import express, { Router } from "express";
import { realpathSync } from "node:fs";

import { createDbClient } from "../../db.js";
import { resolveCrowHome } from "../../shared/crow-home.js";
import { serviceById, serviceCatalog } from "../../shared/service-catalog.js";
import {
  CONNECTION_ERROR_CLASSES, ConnectionError, RESERVED_BLOCK_NAMES, checkLabelFree, connectionDisplayStatus,
  createConnection, disconnectConnection, getConnection, listConnections, otherProjectServiceIds, projectsUsingBundle, recordTest,
} from "../../shared/service-connections.js";
import { recordServiceSecretValues } from "../../shared/secret-values.js";
import { refreshGatewaySecretValues } from "../../shared/secret-values-collect.js";
import { keyCreatedHook } from "../keychain/api.js";
import { ensureWriteKey, serviceSecretKeys, serviceSecretsFor } from "../keychain/store.js";
import { loadKeychainKey } from "../keychain/key.js";
import { csrfMiddleware } from "../dashboard/shared/csrf.js";
import { SUPPORTED_LANGS, t } from "../dashboard/shared/i18n.js";
import { installedBundleIds } from "../skills-catalog.js";
import { testConnection as defaultTestConnection, normalizeAddress, folderRefusal, suggestLabel } from "../services/connect-test.js";
import { servicesUiEnabled } from "../services/ui-flag.js";
import { ChildError, childState, ensureChild, resetChildFailures, stopChild } from "../services/children.js";
import { requireDashboardSessionJson } from "./models.js";
import { isLocalPasswordSessionOn } from "../dashboard/local-session.js";
import {
  SensitivityError, connectionBindingOk, connectionSensitivity, readConnectionBindings, readSensitivityOverrides, recordConnectionBinding, setSensitivityOverride,
} from "../../shared/service-sensitivity.js";
import { crowServerCatalog } from "../../../scripts/pi-bots/crow-server-catalog.mjs";
import { readCanonicalMcp } from "../../../scripts/pi-bots/mcp_writer.mjs";

export const SERVICES_API_BASE = "/dashboard/services/api";
const GROUPS = ["network", "signin", "paste", "builtin"];
const VALUE_MAX = 4096;
const CONTROL_RE = /\p{Cc}/u;
const BUNDLE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;   // routes/bundles.js isValidBundleId
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_FAULTS = new Set(["KEYCHAIN_KEY_MISSING", "KEYCHAIN_KEY_INVALID"]);

/**
 * The block names a connection may never take (I9, scan R13): every server a bot can already
 * get, from this instance's catalog (servers and the unconfigured ones that may become servers)
 * and the canonical ~/.pi/agent/mcp.json. Computed here, never taken from the client. A source
 * that can't be read contributes nothing (the bot config builder still refuses a collision).
 */
export function defaultReservedNames(crowHome = resolveCrowHome(), { catalog: readCatalog = crowServerCatalog, canonical: readCanonical = readCanonicalMcp } = {}) {
  let catalog = [];
  let canonical = [];
  try {
    const c = readCatalog(crowHome);
    catalog = [...Object.keys(c?.servers || {}), ...Object.keys(c?.unconfigured || {})];
  } catch {
    console.warn("[services] server catalog unreadable");
  }
  try {
    canonical = Object.keys(readCanonical()?.mcpServers || {});
  } catch { /* no canonical config: nothing to collide with */ }
  return RESERVED_BLOCK_NAMES(catalog, canonical);
}

async function findProject(db, slug) {
  if (typeof slug !== "string" || !slug) return null;
  const r = (await db.execute({
    sql: "SELECT id, slug, name FROM project_spaces WHERE slug = ? AND status != 'archived' AND archived_at IS NULL",
    args: [slug],
  })).rows[0];
  return r ? { id: Number(r.id), slug: r.slug, name: r.name } : null;
}

const toSet = (v) => (v instanceof Set ? v : new Set(Array.isArray(v) ? v : []));

/**
 * One connection as the dashboard sees it: no value, ever. `private` is its effective
 * sensitivity (Task 16c: on = bots can't read it yet; locked = the owner can't turn it off).
 */
export async function connectionView(db, conn, service, { installed, crowHome = resolveCrowHome(), overrides, bindings } = {}) {
  const { status, labelKey } = connectionDisplayStatus(conn, { installed });
  const saved = await serviceSecretKeys(db, conn.uuid);
  const fields = {};
  for (const f of service?.fields || []) {
    const set = f.kind === "secret" ? saved.has(f.name) : typeof conn.config?.[f.name] === "string" && conn.config[f.name] !== "";
    fields[f.name] = set ? "set" : "unset";
  }
  return {
    uuid: conn.uuid,
    serviceId: conn.serviceId,
    name: service?.name || conn.serviceId,
    accountLabel: conn.accountLabel,
    status,
    labelKey,
    lastTestedAt: conn.lastTestedAt,
    lastError: conn.lastError,
    fields,
    private: privateView(conn, { crowHome, overrides, bindings }),
  };
}

/** {on, locked}; any failure, or a row that isn't the service the owner connected, reads as private and locked. */
function privateView(conn, { crowHome, overrides, bindings }) {
  try {
    if (!connectionBindingOk(conn, { crowHome, bindings })) return { on: true, locked: true };
    const s = connectionSensitivity(conn, { crowHome, overrides });
    return { on: s.sensitive !== false, locked: s.locked === true };
  } catch {
    return { on: true, locked: false };
  }
}

function serviceCard(s, installed) {
  return {
    serviceId: s.id,
    bundleId: s.bundleId,                  // the Install sheet installs this extension (Task 12)
    name: s.name,
    installed: installed.has(s.bundleId),
    labelFrom: s.labelFrom || null,        // the connect sheet suggests the account name the same way
    fields: (s.fields || []).map((f) => ({ name: f.name, kind: f.kind, labelKey: f.label_key || null, helpKey: f.help_key || null })),
    steps: [...(s.steps || [])],
    stepLinks: { ...(s.stepLinks || {}) },
  };
}

/**
 * The Services page's data for one project (shared with the page, Task 10). null when the slug
 * names no live project. Reads are active-only: disconnected rows never show.
 * @param {object} db
 * @param {string} slug
 * @param {{installedIds?: Set<string>|string[], lang?: string}} [opts]
 */
export async function loadServicesPage(db, slug, { installedIds = new Set(), lang = "en", crowHome = resolveCrowHome() } = {}) {
  void lang; // the payload carries i18n keys; the page renders them in its language
  const project = await findProject(db, slug);
  if (!project) return null;
  const installed = toSet(installedIds);
  const catalog = serviceCatalog();
  const byId = new Map(catalog.map((s) => [s.id, s]));
  const conns = await listConnections(db, { projectId: project.id, ownerContactId: null });
  const overrides = readSensitivityOverrides({ crowHome });
  const bindings = readConnectionBindings({ crowHome });
  const connections = [];
  for (const c of conns) {
    const s = byId.get(c.serviceId);
    connections.push(await connectionView(db, c, s, { installed: s ? installed.has(s.bundleId) : false, crowHome, overrides, bindings }));
  }
  const here = new Set(conns.map((c) => c.serviceId));
  const alsoOnCrow = (await otherProjectServiceIds(db, project.id))
    .filter((id) => !here.has(id))
    .map((id) => ({ serviceId: id, name: byId.get(id)?.name || id }));
  const members = await db.execute({
    sql: "SELECT 1 FROM project_members WHERE project_id = ? AND contact_id IS NOT NULL AND revoked_at IS NULL LIMIT 1",
    args: [project.id],
  });
  const groups = Object.fromEntries(GROUPS.map((g) => [g, []]));
  for (const s of catalog) {
    if (s.crowWide || !groups[s.group]) continue;          // a toggle is a Crow-wide source, not a connection
    groups[s.group].push(serviceCard(s, installed));
  }
  return {
    project: { slug: project.slug, name: project.name },
    connections,
    hasMembers: members.rows.length > 0,
    alsoOnCrow,
    groups,
    botsLive: false,
  };
}

/**
 * The typed values, checked field by field (Task 9's rule: trimmed, ≤ 4096 characters, no
 * control characters) and split into config and secrets. An address is stored normalized and a
 * folder as its real path (after the test). Throws ConnectionError; `field` names the field.
 */
function readValues(service, values) {
  if (values == null) values = {};
  if (typeof values !== "object" || Array.isArray(values)) throw fieldError("bad_value");
  const kinds = new Map(service.fields.map((f) => [f.name, f.kind]));
  for (const k of Object.keys(values)) if (!kinds.has(k)) throw fieldError("bad_value");
  const config = {};
  const secrets = {};
  for (const [name, kind] of kinds) {
    const raw = Object.hasOwn(values, name) ? values[name] : undefined;
    if (raw == null || (typeof raw === "string" && raw.trim() === "")) throw fieldError("missing_field", name);
    if (typeof raw !== "string") throw fieldError("bad_value", name);
    const v = raw.trim();
    if (v.length > VALUE_MAX || CONTROL_RE.test(v)) throw fieldError("bad_value", name);
    if (kind === "address") {
      const a = normalizeAddress(v);
      if (!a) throw fieldError("bad_address", name);
      config[name] = a;
    } else if (kind === "secret") {
      secrets[name] = v;
    } else {
      config[name] = v;
    }
  }
  return { config, secrets };
}

function fieldError(code, field) {
  const e = new ConnectionError(code);
  if (field) e.field = field;
  return e;
}

function langOf(req) {
  const q = typeof req.query?.lang === "string" ? req.query.lang : "";
  return SUPPORTED_LANGS.includes(q) ? q : "en";
}

/**
 * @param {object} [o]
 * @param {(path?: string) => object} [o.dbFactory]
 * @param {Function} [o.sessionGate] express middleware (tests pass a stub)
 * @param {Function} [o.testConnection] Connect and test (Task 8)
 * @param {() => Set<string>|string[]} [o.installedIds] the installed bundle ids
 * @param {() => boolean} [o.uiEnabled]
 * @param {string} [o.crowHome] where the keychain key and installed.json live (default CROW_HOME)
 * @param {() => Set<string>|string[]} [o.reservedNames] block names a label may not take (tests inject them)
 * @param {(values: string[]) => void} [o.recordSecrets] masking record (default recordServiceSecretValues)
 * @param {() => void} [o.refreshMasking] re-collect this gateway's in-memory masking sets (default refreshGatewaySecretValues)
 * @param {Function} [o.audit] / [o.notify] the keychain's new-key audit and notice (keyCreatedHook)
 * @param {(db: object, req: object) => Promise<boolean>} [o.ownerCheck] the owner rule for the
 *   Private switch (default isLocalPasswordSessionOn; tests use the real one)
 */
export function servicesApiRouter({
  dbFactory = createDbClient,
  sessionGate = requireDashboardSessionJson,
  testConnection = defaultTestConnection,
  installedIds,
  uiEnabled = servicesUiEnabled,
  crowHome,
  reservedNames,
  recordSecrets,
  refreshMasking,
  audit,
  notify,
  ownerCheck = isLocalPasswordSessionOn,
} = {}) {
  const home = () => crowHome || resolveCrowHome();
  const installed = () => toSet(installedIds ? installedIds() : installedBundleIds(home()));
  const reserved = () => (reservedNames ? reservedNames() : defaultReservedNames(home()));
  const maskEnv = () => (crowHome ? { ...process.env, CROW_HOME: crowHome } : process.env);
  const record = recordSecrets || ((values) => recordServiceSecretValues(values, maskEnv()));
  // After a connect or disconnect: this gateway's card and log masks change now, not at the next spawn.
  const refresh = () => {
    try { (refreshMasking || (() => refreshGatewaySecretValues({ env: maskEnv() })))(); } catch { console.warn("[services] masking refresh failed"); }
  };
  const hookDeps = { ...(audit ? { audit } : {}), ...(notify ? { notify } : {}) };
  const router = Router();

  router.use(SERVICES_API_BASE, sessionGate, (req, res, next) => {
    if (!uiEnabled()) return res.status(404).json({ error: "not_found" });
    if (req.headers["x-crow-signature"]) return res.status(403).json({ ok: false });   // never for paired instances
    res.set("Cache-Control", "no-store");
    next();
  }, csrfMiddleware);

  const withDb = (handler) => async (req, res) => {
    const db = dbFactory();
    try {
      await handler(req, res, db);
    } catch (err) {
      if (res.headersSent) return;
      if (err instanceof ConnectionError) {
        const status = err.code === "unknown_project" || err.code === "not_found" ? 404 : 400;
        return res.status(status).json(err.field ? { error: err.code, field: err.field } : { error: err.code });
      }
      if (KEY_FAULTS.has(err?.code)) {
        console.error("[services] keychain key unavailable");
        return res.status(500).json({ ok: false });
      }
      console.error("[services] request failed");
      res.status(500).json({ ok: false });
    } finally {
      try { db.close(); } catch { /* closed */ }
    }
  };

  const fail = (res, code, extra = {}) => {
    console.warn("[services] connect failed: " + code);
    return res.status(code === "unknown_project" ? 404 : 400).json({ error: code, ...extra });
  };

  router.get(`${SERVICES_API_BASE}/project/:slug`, withDb(async (req, res, db) => {
    const page = await loadServicesPage(db, req.params.slug, { installedIds: installed(), lang: langOf(req), crowHome: home() });
    if (!page) return res.status(404).json({ error: "unknown_project" });
    res.json(page);
  }));

  const jsonBody = express.json({ limit: "16kb" });

  router.post(`${SERVICES_API_BASE}/project/:slug/connect`, jsonBody, withDb(async (req, res, db) => {
    const project = await findProject(db, req.params.slug);
    if (!project) return fail(res, "unknown_project");
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    const service = typeof body.serviceId === "string" && body.serviceId ? serviceById(body.serviceId) : null;
    if (!service || service.crowWide) return fail(res, "unknown_service");
    if (!installed().has(service.bundleId)) return fail(res, "not_installed");
    let values;
    try {
      values = readValues(service, body.values);
    } catch (err) {
      if (err instanceof ConnectionError) return fail(res, err.code, err.field ? { field: err.field } : {});
      throw err;
    }
    if (body.accountLabel != null && typeof body.accountLabel !== "string") return fail(res, "bad_value", { field: "accountLabel" });
    // An empty label is filled before the label check (no network): an address service suggests
    // its host ("this Crow :{port}" on loopback), anything else the default "main".
    let accountLabel = body.accountLabel;
    if (accountLabel == null || accountLabel.trim() === "") {
      accountLabel = (service.labelFrom && suggestLabel(service, values.config, { lang: langOf(req) })) || t("services.connect.labelDefault", langOf(req));
    }
    const reservedSet = reserved();
    try {
      await checkLabelFree(db, { projectId: project.id, serviceId: service.id, accountLabel, reservedNames: reservedSet });
    } catch (err) {
      if (err instanceof ConnectionError) return fail(res, err.code, err.code === "label_taken" ? {} : { field: "accountLabel" });
      throw err;
    }
    // The key before anything leaves Crow: a key fault is the keychain's, not the token's.
    const key = Object.keys(values.secrets).length
      ? await ensureWriteKey(db, { crowHome: home(), onNewKey: keyCreatedHook({ db, ip: req.ip, ...hookDeps }) })
      : null;

    const result = await testConnection(service, { values: { ...values.config, ...values.secrets }, crowHome: home(), lang: langOf(req) });
    if (!result || result.ok !== true) {
      const code = CONNECTION_ERROR_CLASSES.has(result?.error) ? result.error : "unexpected_response";
      return fail(res, code);
    }
    // A folder is stored as the path that was tested, resolved (Task 8 carry), and re-checked.
    for (const f of service.fields) {
      if (f.kind !== "folder") continue;
      let real;
      try { real = realpathSync.native(values.config[f.name]); } catch { return fail(res, "not_found", { field: f.name }); }
      const refusal = folderRefusal(real, { crowHome: home(), expectEntry: service.test?.expect_entry ?? null });
      if (refusal) return fail(res, refusal, { field: f.name });
      values.config[f.name] = real;
    }
    const secretValues = Object.values(values.secrets);
    if (secretValues.length) {
      // Masked from here on, even if the save below fails part way; disconnect never removes it.
      try { record(secretValues); } catch { console.warn("[services] masking record not written"); }
    }
    let conn;
    try {
      conn = await createConnection(db, {
        projectId: project.id, serviceId: service.id, accountLabel,
        config: values.config, secrets: values.secrets, testedAt: new Date(),
      }, { key, actor: "local", reservedNames: reservedSet });
    } catch (err) {
      if (err instanceof ConnectionError) return fail(res, err.code);
      throw err;
    }
    // The owner's binding uuid -> service, in the hidden secrets dir: a bot that rewrites the row's
    // service_id in crow.db gets a connection nothing serves. Unwritten, the connection is never
    // served (fail closed) and the owner reconnects.
    try { recordConnectionBinding(conn, { crowHome: home() }); } catch { console.warn("[services] connection binding not written"); }
    refresh();
    res.status(201).json({ ok: true, connection: await connectionView(db, conn, service, { installed: true, crowHome: home() }) });
  }));

  /** A live, local-owner connection in a live project, or a 404 / 400 already sent. */
  const ownConnection = async (req, res, db, { allowDisconnected = false } = {}) => {
    const uuid = req.params.uuid;
    const conn = typeof uuid === "string" && UUID_RE.test(uuid) ? await getConnection(db, uuid) : null;
    const live = conn && conn.ownerContactId == null && (await db.execute({
      sql: "SELECT 1 FROM project_spaces WHERE id = ? AND status != 'archived' AND archived_at IS NULL", args: [conn.projectId],
    })).rows.length > 0;
    if (!live || (!allowDisconnected && conn.status === "disconnected")) {
      res.status(404).json({ error: "not_found" });
      return null;
    }
    return conn;
  };

  router.post(`${SERVICES_API_BASE}/connection/:uuid/test`, withDb(async (req, res, db) => {
    const conn = await ownConnection(req, res, db);
    if (!conn) return;
    const service = serviceById(conn.serviceId);
    if (!service || service.crowWide) return res.status(400).json({ error: "unknown_service" });
    if (!installed().has(service.bundleId)) return res.status(400).json({ error: "not_installed" });
    const secretNames = service.fields.filter((f) => f.kind === "secret").map((f) => f.name);
    const secrets = secretNames.length
      ? await serviceSecretsFor(db, loadKeychainKey({ crowHome: home() }), conn.uuid, { allowedKeys: secretNames })
      : {};
    const result = await testConnection(service, { values: { ...conn.config, ...secrets }, crowHome: home(), lang: langOf(req) });
    const ok = !!result && result.ok === true;
    const error = ok ? null : CONNECTION_ERROR_CLASSES.has(result?.error) ? result.error : "unexpected_response";
    if (!ok) console.warn("[services] test failed: " + error);
    else resetChildFailures(conn.uuid);   // a passing test is the owner's repair too
    const after = await recordTest(db, conn.uuid, { ok, error });
    const { status } = connectionDisplayStatus(after || conn, { installed: true });
    res.json(ok ? { ok: true, status } : { ok: false, status, error });
  }));

  router.post(`${SERVICES_API_BASE}/connection/:uuid/disconnect`, withDb(async (req, res, db) => {
    const conn = await ownConnection(req, res, db, { allowDisconnected: true });
    if (!conn) return;
    // Idempotent. The secrets stay in the keychain as 'disconnected' (never served, still masked;
    // the keychain page deletes them for good), and the masking hash stays recorded.
    await disconnectConnection(db, conn.uuid, { actor: "local" });
    await stopChild(conn.uuid, { forget: true });
    refresh();
    res.json({ ok: true });
  }));

  // R8: the operator's repair lever. Stops the child, forgets its failures and cooldown, then
  // starts it once (which also refreshes the service's tool cache). A connection whose error a
  // start can't disprove (a failed live test) answers 404 like any connection that isn't served.
  router.post(`${SERVICES_API_BASE}/connection/:uuid/restart`, withDb(async (req, res, db) => {
    const conn = await ownConnection(req, res, db);
    if (!conn) return;
    await stopChild(conn.uuid);
    resetChildFailures(conn.uuid);
    try {
      const { tools } = await ensureChild(db, conn.uuid, { crowHome: home(), repair: true });
      res.json({ ok: true, childState: childState(conn.uuid), tools: tools.length });
    } catch (err) {
      const code = err instanceof ChildError ? err.code : "child_unavailable";
      if (code === "not_active") return res.status(404).json({ error: "not_found" });
      if (code === "busy") return res.status(409).json({ error: "busy" });
      if (code === "not_installed") return res.status(400).json({ error: "not_installed" });
      console.warn("[services] restart failed: child_unavailable");
      res.status(502).json({ error: "child_unavailable", childState: childState(conn.uuid) });
    }
  }));

  // Task 16c: the owner's "Private" switch for one connection. Owner only, and stricter than the
  // other routes: a local password session from another machine (isLocalPasswordSessionOn, which
  // refuses a peer SSO session, a session minted by a login on this machine and any request from
  // this machine itself), checked before the connection is even looked up. A locked service
  // (obsidian, or one the registry doesn't name) can't be changed: 400 bad_value. The override is
  // written only to the hidden secrets dir (service-sensitivity.js). Turning private ON also stops
  // the connection's child, so a bot's call in flight ends now; the mount refuses every later
  // request. The owner's own Test again / Restart keep working either way.
  router.post(`${SERVICES_API_BASE}/connection/:uuid/sensitive`, jsonBody, withDb(async (req, res, db) => {
    let owner = false;
    try { owner = (await ownerCheck(db, req)) === true; } catch { owner = false; }
    if (!owner) return res.status(403).json({ error: "not_owner" });
    const body = req.body && typeof req.body === "object" && !Array.isArray(req.body) ? req.body : {};
    if (typeof body.sensitive !== "boolean") return res.status(400).json({ error: "bad_value" });
    const conn = await ownConnection(req, res, db);
    if (!conn) return;
    let after;
    try {
      after = setSensitivityOverride(conn, body.sensitive, { crowHome: home() });
    } catch (err) {
      if (err instanceof SensitivityError) return res.status(400).json({ error: "bad_value" });
      console.error("[services] private switch not saved");
      return res.status(500).json({ ok: false });
    }
    if (after.sensitive) {
      try { await stopChild(conn.uuid); } catch { console.warn("[services] private switch: child stop failed"); }
    }
    res.json({ ok: true, private: { on: after.sensitive, locked: after.locked } });
  }));

  // The Extensions uninstall confirm: which projects' connections the uninstall would pause. Read
  // only, names only, [] when nothing is affected.
  router.get(`${SERVICES_API_BASE}/uninstall-preflight/:id`, withDb(async (req, res, db) => {
    const id = req.params.id;
    if (typeof id !== "string" || !BUNDLE_ID_RE.test(id)) return res.status(400).json({ error: "bad_value" });
    res.json({ affectedProjects: await projectsUsingBundle(db, id) });
  }));

  // The connect body's own parser: a malformed or oversized body may hold a pasted secret, so it
  // answers a fixed class and logs a fixed line, never the parser's message.
  router.use(SERVICES_API_BASE, (err, req, res, next) => {
    if (!err || res.headersSent) return next(err);
    // Every body-parser refusal (bad JSON, too large, an unsupported charset or encoding: 400 /
    // 413 / 415, each with a `type`) is the same fixed answer; never a 500.
    const status = Number(err.status || err.statusCode);
    if (typeof err.type === "string" || (status >= 400 && status < 500)) {
      console.warn("[services] bad body");
      return res.status(400).json({ error: "bad_value" });
    }
    console.error("[services] request failed");
    res.status(500).json({ ok: false });
  });

  return router;
}

export default servicesApiRouter;
