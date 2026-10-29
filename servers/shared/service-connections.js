/**
 * Project service connections — the ONLY writer of service_connections. One row is one account
 * of one service in one project (an "account label" such as "Work"); its secrets live in the
 * keychain as kind 'service', keyed by the row's uuid (decision C1).
 *
 * Nothing here returns, logs or audits a secret: a Connection carries field values from `config`
 * (non-secret fields only) and never a keychain value. Reads never decrypt anything.
 *
 * Local user only: no code path creates a row with a non-null owner_contact_id (createConnection
 * refuses one), and every read for bots (connectionsFor) asks for owner_contact_id IS NULL.
 *
 * Statuses stored: active | error | needs_install | needs_reauth | disconnected. The display
 * status (connectionDisplayStatus) adds not_tested and folds in "is the bundle installed".
 */
import { randomUUID } from "node:crypto";
import { serviceById, cleanLabel, labelSlug, blockNameFor } from "./service-catalog.js";
import { appendAudit } from "./project-acl.js";
import {
  saveServiceSecret as defaultSaveServiceSecret,
  deleteServiceSecrets as defaultDeleteServiceSecrets,
  disconnectServiceSecrets as defaultDisconnectServiceSecrets,
  KeychainKeyMissingError,
} from "../gateway/keychain/store.js";

/** The dashboard error classes (plan Global Constraints). A ConnectionError carries one of these. */
export const CONNECTION_ERROR_CLASSES = Object.freeze(new Set([
  "unreachable", "auth_failed", "timeout", "bad_address", "redirect", "unexpected_response",
  "forbidden_target", "not_found", "not_a_vault", "label_taken", "missing_field", "bad_value",
  "not_installed", "unknown_service", "unknown_project", "child_unavailable", "busy",
]));

export class ConnectionError extends Error {
  constructor(code) {
    if (!CONNECTION_ERROR_CLASSES.has(code)) throw new TypeError(`service-connections: unknown error class ${code}`);
    super(code);
    this.name = "ConnectionError";
    this.code = code;
  }
}

const STATUSES = new Set(["active", "error", "needs_install", "needs_reauth", "disconnected"]);
const LIVE = "status != 'disconnected'";
const AUDIT_ACTORS = new Set(["local", "contact", "bot", "system"]);
const COLS = `id, uuid, project_id, owner_contact_id, service_id, bundle_id, method, account_label, label_slug,
  config, status, source_connection_id, last_tested_at, last_error, created_at, updated_at`;

const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d{1,9})?)?(Z|[+-]\d{2}:\d{2})$/;
const VALUE_MAX = 4096;
const CONTROL_RE = /\p{Cc}/u;

/** A timestamp as ISO text: undefined/null → now; a valid Date or ISO 8601 string → normalised; else bad_value. */
function iso(v) {
  if (v == null) return new Date().toISOString();
  const d = v instanceof Date ? v : typeof v === "string" && ISO_RE.test(v) ? new Date(v) : null;
  if (!d || Number.isNaN(d.getTime())) throw new ConnectionError("bad_value");
  return d.toISOString();
}

/** Task 9's field rule, enforced here too (the store is the only writer): trimmed, ≤ 4096 chars, no control characters. */
function cleanValue(v) {
  if (typeof v !== "string") throw new ConnectionError("bad_value");
  const t = v.trim();
  if (t === "") throw new ConnectionError("missing_field");
  if (t.length > VALUE_MAX || CONTROL_RE.test(t)) throw new ConnectionError("bad_value");
  return t;
}

const toSet = (names) => (names instanceof Set ? names : new Set(names || []));
/** Archived projects never surface: their connections are not served, listed or counted. */
const NOT_ARCHIVED = "project_id IN (SELECT id FROM project_spaces WHERE status != 'archived' AND archived_at IS NULL)";
const num = (v) => (v == null ? null : Number(v));

function parseConfig(text) {
  if (!text) return {};
  try {
    const v = JSON.parse(text);
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

function toConnection(r) {
  return {
    id: Number(r.id),
    uuid: r.uuid,
    projectId: Number(r.project_id),
    ownerContactId: num(r.owner_contact_id),
    serviceId: r.service_id,
    bundleId: r.bundle_id ?? null,
    method: r.method,
    accountLabel: r.account_label,
    labelSlug: r.label_slug,
    blockName: `${r.service_id}-${r.label_slug}`,
    config: parseConfig(r.config),
    status: r.status,
    sourceConnectionId: num(r.source_connection_id),
    lastTestedAt: r.last_tested_at ?? null,
    lastError: r.last_error ?? null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
}

/**
 * The block names a connection's block may never take (I9): every Crow server a bot can already
 * get, so a labelled block cannot shadow one (e.g. `google-workspace-alex` from the canonical
 * config). This module never reads ~/.pi or the instance's catalog itself; the caller (Task 9)
 * computes both lists and passes them in:
 * @param {Iterable<string>} catalogNames  keys of `crowServerCatalog(crowHome).servers`
 *   (scripts/pi-bots/crow-server-catalog.mjs: core + installed bundle servers)
 * @param {Iterable<string>} canonicalNames  keys of the canonical `~/.pi/agent/mcp.json`, read
 *   through scripts/pi-bots/mcp_writer.mjs (`readCanonicalMcp`, serversForBot's source)
 * @returns {Set<string>}
 */
export function RESERVED_BLOCK_NAMES(catalogNames = [], canonicalNames = []) {
  const out = new Set();
  for (const list of [catalogNames, canonicalNames]) {
    for (const n of list || []) if (typeof n === "string" && n) out.add(n);
  }
  return out;
}

function requireProjectId(projectId) {
  if (!Number.isInteger(projectId) || projectId <= 0) throw new ConnectionError("bad_value");
}

async function requireLiveProject(db, projectId) {
  requireProjectId(projectId);
  const r = (await db.execute({ sql: "SELECT id, status, archived_at FROM project_spaces WHERE id = ?", args: [projectId] })).rows[0];
  if (!r || r.status === "archived" || r.archived_at != null) throw new ConnectionError("unknown_project");
}

function requireLabel(accountLabel) {
  if (accountLabel != null && typeof accountLabel !== "string") throw new ConnectionError("bad_value");
  const label = cleanLabel(accountLabel);
  if (!label) throw new ConnectionError("missing_field");
  return label;
}

/**
 * Throws label_taken when the label's slug is already used by a live connection of this service
 * in this project (local owner), when its block name is reserved, or when another live
 * connection in the project already has that block name. Task 9 calls it before the live test
 * (M5), so a credential never leaves Crow for a name that cannot be saved. The slug index is still
 * the final word under concurrency (createConnection maps its UNIQUE error).
 * @param {{projectId:number, serviceId:string, accountLabel:string, reservedNames?:Set<string>|string[]}} p
 *   reservedNames: from RESERVED_BLOCK_NAMES (never read from ~/.pi here); a Set or an array
 */
export async function checkLabelFree(db, { projectId, serviceId, accountLabel, reservedNames = new Set() } = {}) {
  requireProjectId(projectId);
  if (typeof serviceId !== "string" || !serviceId) throw new ConnectionError("unknown_service");
  const label = requireLabel(accountLabel);
  const slug = labelSlug(label);
  const block = blockNameFor(serviceId, label);
  if (toSet(reservedNames).has(block)) throw new ConnectionError("label_taken");
  const { rows } = await db.execute({
    sql: `SELECT service_id, label_slug FROM service_connections
          WHERE project_id = ? AND owner_contact_id IS NULL AND ${LIVE}`,
    args: [projectId],
  });
  for (const r of rows) {
    if ((r.service_id === serviceId && r.label_slug === slug) || `${r.service_id}-${r.label_slug}` === block) {
      throw new ConnectionError("label_taken");
    }
  }
}

function isSlugConflict(err) {
  const msg = String(err?.message || "");
  return /UNIQUE constraint failed/i.test(msg) && /idx_service_connections_slug|label_slug/.test(msg);
}

// Strict: every declared field is required, secrets only in `secret` fields, config only in the
// others. An oauth service (roadmap) keeps tokens that are not declared fields; it will need its
// own path here.
function splitValues(service, config, secrets) {
  if (config == null) config = {};
  if (secrets == null) secrets = {};
  if (typeof config !== "object" || Array.isArray(config) || typeof secrets !== "object" || Array.isArray(secrets)) {
    throw new ConnectionError("bad_value");
  }
  const kinds = new Map(service.fields.map((f) => [f.name, f.kind]));
  for (const k of Object.keys(config)) {
    if (!kinds.has(k) || kinds.get(k) === "secret") throw new ConnectionError("bad_value");
  }
  for (const k of Object.keys(secrets)) {
    if (kinds.get(k) !== "secret") throw new ConnectionError("bad_value");
  }
  const out = { config: {}, secrets: {} };
  for (const [name, kind] of kinds) {
    const src = kind === "secret" ? secrets : config;
    if (!Object.hasOwn(src, name)) throw new ConnectionError("missing_field");
    out[kind === "secret" ? "secrets" : "config"][name] = cleanValue(src[name]);
  }
  return out;
}

/**
 * Creates one connection. Order (M8): insert with status 'error' / last_error
 * 'child_unavailable', save every secret, then flip to 'active'. If anything throws after the
 * insert, best-effort cleanup deletes that uuid's secrets, then its (still non-active) row, then
 * the ORIGINAL error is rethrown (cleanup errors are swallowed, never logged). A crash between the
 * steps leaves at worst an 'error' row, never an active row without its secrets. No transaction:
 * the shared client would capture unrelated concurrent writes. Two concurrent creates whose labels
 * share a slug ("Work" / "work!") cannot both pass: the slug index refuses the second insert,
 * mapped to label_taken.
 *
 * Test seams (tests only; production callers must not pass them): `saveServiceSecret`,
 * `deleteServiceSecrets`, `_registryForTest` (handed to serviceById, so it can invent a service).
 * A KeychainKeyMissingError from the keychain is thrown unchanged (checked before the insert).
 * @returns {Promise<Connection>} never a secret
 */
export async function createConnection(
  db,
  { projectId, ownerContactId = null, serviceId, accountLabel, config = {}, secrets = {}, testedAt = null, sourceConnectionId = null } = {},
  {
    key, actor = "local", reservedNames = new Set(),
    saveServiceSecret = defaultSaveServiceSecret, deleteServiceSecrets = defaultDeleteServiceSecrets, _registryForTest,
  } = {},
) {
  const service = typeof serviceId === "string" && serviceId ? serviceById(serviceId, _registryForTest ? { registry: _registryForTest } : undefined) : null;
  if (!service || service.crowWide) throw new ConnectionError("unknown_service");
  // Local user only (spec §6.6): nothing creates a contact-owned row yet.
  if (ownerContactId != null) throw new ConnectionError("bad_value");
  if (!AUDIT_ACTORS.has(actor)) throw new ConnectionError("bad_value");
  if (sourceConnectionId != null && !Number.isInteger(sourceConnectionId)) throw new ConnectionError("bad_value");
  const testedText = testedAt == null ? null : iso(testedAt);
  await requireLiveProject(db, projectId);
  const label = requireLabel(accountLabel);
  const values = splitValues(service, config, secrets);
  const secretEntries = Object.entries(values.secrets);
  if (secretEntries.length > 0 && (!key || typeof key.id !== "string" || !Buffer.isBuffer(key.seed))) {
    throw new KeychainKeyMissingError();
  }
  await checkLabelFree(db, { projectId, serviceId, accountLabel: label, reservedNames });

  const uuid = randomUUID();
  const configText = Object.keys(values.config).length ? JSON.stringify(values.config) : null;
  try {
    await db.execute({
      sql: `INSERT INTO service_connections
              (uuid, project_id, owner_contact_id, service_id, bundle_id, method, account_label, label_slug,
               config, status, source_connection_id, last_error)
            VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, 'error', ?, 'child_unavailable')`,
      args: [uuid, projectId, service.id, service.bundleId, service.method, label, labelSlug(label), configText, sourceConnectionId],
    });
  } catch (err) {
    if (isSlugConflict(err)) throw new ConnectionError("label_taken");
    throw err;
  }

  try {
    for (const [envKey, secret] of secretEntries) {
      await saveServiceSecret(db, key, {
        connectionUuid: uuid,
        bundleId: service.bundleId,
        envKey,
        label: `${service.name} — ${label} — ${envKey}`,
        secret,
      });
    }
    await db.execute({
      sql: `UPDATE service_connections SET status = 'active', last_error = NULL, last_tested_at = ?, updated_at = datetime('now')
            WHERE uuid = ?`,
      args: [testedText, uuid],
    });
  } catch (err) {
    await undoCreate(db, uuid, deleteServiceSecrets);
    throw err;
  }
  await appendAudit(db, { project_id: projectId, actor_type: actor, action: "service.connect", target: uuid, payload: { service_id: service.id } });
  return getConnection(db, uuid);
}

// Best-effort, silent: only a row that never went active is removed, secrets first.
async function undoCreate(db, uuid, deleteServiceSecrets) {
  try {
    const r = (await db.execute({ sql: "SELECT status FROM service_connections WHERE uuid = ?", args: [uuid] })).rows[0];
    if (r && r.status === "active") return;
    await deleteServiceSecrets(db, uuid);
    await db.execute({ sql: "DELETE FROM service_connections WHERE uuid = ? AND status != 'active'", args: [uuid] });
  } catch { /* the original error wins; never log */ }
}

/** @returns {Promise<Connection|null>} */
export async function getConnection(db, uuid) {
  if (typeof uuid !== "string" || !uuid) return null;
  const r = (await db.execute({ sql: `SELECT ${COLS} FROM service_connections WHERE uuid = ?`, args: [uuid] })).rows[0];
  return r ? toConnection(r) : null;
}

/**
 * Connections for a dashboard view. `ownerContactId`: undefined = any owner, null = the local
 * user only. Disconnected rows only with includeDisconnected; archived projects' rows only with
 * includeArchivedProjects.
 */
export async function listConnections(db, { projectId, ownerContactId, serviceId, includeDisconnected = false, includeArchivedProjects = false } = {}) {
  const where = [];
  const args = [];
  if (projectId !== undefined) { where.push("project_id = ?"); args.push(projectId); }
  if (ownerContactId === null) where.push("owner_contact_id IS NULL");
  else if (ownerContactId !== undefined) { where.push("owner_contact_id = ?"); args.push(ownerContactId); }
  if (serviceId != null) { where.push("service_id = ?"); args.push(serviceId); }
  if (!includeDisconnected) where.push(LIVE);
  if (!includeArchivedProjects) where.push(NOT_ARCHIVED);
  const { rows } = await db.execute({
    sql: `SELECT ${COLS} FROM service_connections ${where.length ? "WHERE " + where.join(" AND ") : ""} ORDER BY service_id, label_slug, id`,
    args,
  });
  return rows.map(toConnection);
}

/**
 * The active connections a turn in `projectId` may use. `owner` null = the local user (the only
 * owner in this release). `projectId == null` (a chat or job outside any project) → []. An
 * archived project serves nothing unless includeArchivedProjects.
 */
export async function connectionsFor(db, { projectId, owner = null, serviceId = null, includeArchivedProjects = false } = {}) {
  if (projectId == null) return [];
  const args = [projectId];
  let sql = `SELECT ${COLS} FROM service_connections WHERE project_id = ? AND status = 'active'`;
  if (!includeArchivedProjects) sql += ` AND ${NOT_ARCHIVED}`;
  if (owner == null) sql += " AND owner_contact_id IS NULL";
  else { sql += " AND owner_contact_id = ?"; args.push(owner); }
  if (serviceId != null) { sql += " AND service_id = ?"; args.push(serviceId); }
  const { rows } = await db.execute({ sql: sql + " ORDER BY service_id, label_slug, id", args });
  return rows.map(toConnection);
}

/** Service ids connected (not disconnected) in any OTHER non-archived project, for "Also on your Crow". */
export async function otherProjectServiceIds(db, projectId) {
  const { rows } = await db.execute({
    sql: `SELECT DISTINCT service_id FROM service_connections
          WHERE project_id != ? AND owner_contact_id IS NULL AND ${LIVE} AND ${NOT_ARCHIVED} ORDER BY service_id`,
    args: [projectId ?? -1],
  });
  return rows.map((r) => r.service_id);
}

/**
 * Records a live test. ok → active, last_error cleared; not ok → error with a fixed class (an
 * unknown class is stored as unexpected_response, never free text). A disconnected or
 * needs_install row keeps its status. @returns {Promise<Connection|null>}
 */
export async function recordTest(db, uuid, { ok, error = null, now } = {}) {
  const cls = ok ? null : CONNECTION_ERROR_CLASSES.has(error) ? error : "unexpected_response";
  await db.execute({
    sql: `UPDATE service_connections SET
            status = CASE WHEN status IN ('active', 'error', 'needs_reauth') THEN ? ELSE status END,
            last_tested_at = ?, last_error = ?, updated_at = datetime('now')
          WHERE uuid = ? AND ${LIVE}`,
    args: [ok ? "active" : "error", iso(now), cls, uuid],
  });
  return getConnection(db, uuid);
}

/** A child failed to start or exited early (Task 14's cooldown): error / child_unavailable. */
export async function recordChildFailure(db, uuid) {
  await db.execute({
    sql: `UPDATE service_connections SET status = 'error', last_error = 'child_unavailable', updated_at = datetime('now')
          WHERE uuid = ? AND status IN ('active', 'error', 'needs_reauth')`,
    args: [uuid],
  });
  return getConnection(db, uuid);
}

/**
 * Disconnects: the keychain secrets are marked 'disconnected' first (kept, never served, still
 * masked; the owner deletes them for good from the keychain page; if marking throws, the row is
 * untouched and a retry starts over), then the row goes 'disconnected', then the audit row. Safe
 * to repeat: an already-disconnected uuid re-marks any leftover active secret and writes no
 * second audit row. Unknown uuid → not_found. `disconnectServiceSecrets` is a test seam (tests only).
 */
export async function disconnectConnection(db, uuid, { actor = "local", disconnectServiceSecrets = defaultDisconnectServiceSecrets } = {}) {
  if (!AUDIT_ACTORS.has(actor)) throw new ConnectionError("bad_value");
  const conn = await getConnection(db, uuid);
  if (!conn) throw new ConnectionError("not_found");
  await disconnectServiceSecrets(db, uuid);
  if (conn.status !== "disconnected") {
    await db.execute({
      sql: "UPDATE service_connections SET status = 'disconnected', updated_at = datetime('now') WHERE uuid = ?",
      args: [uuid],
    });
    await appendAudit(db, { project_id: conn.projectId, actor_type: actor, action: "service.disconnect", target: uuid, payload: { service_id: conn.serviceId } });
  }
  return getConnection(db, uuid);
}

/**
 * Disconnects EVERY connection of a project, whatever its status and whether or not the project is
 * archived, the way disconnectConnection does (secrets 'disconnected' first, then the row, one
 * audit row per connection that changed). A project delete MUST call this before deleting the
 * project_spaces row: service_connections.project_id cascades, and without it the keychain rows
 * would be left 'active' with no connection (once disconnected they stay masked, never served).
 * Safe to repeat. @returns {Promise<{disconnected:number}>} connections that changed state.
 */
export async function disconnectProjectConnections(db, projectId, { actor = "local" } = {}) {
  if (!AUDIT_ACTORS.has(actor)) throw new ConnectionError("bad_value");
  const { rows } = await db.execute({ sql: "SELECT uuid, status FROM service_connections WHERE project_id = ? ORDER BY id", args: [projectId] });
  let disconnected = 0;
  for (const r of rows) {
    await disconnectConnection(db, r.uuid, { actor });
    if (r.status !== "disconnected") disconnected++;
  }
  return { disconnected };
}

/**
 * Uninstall of `bundleId`: its active, error and needs_reauth connections become needs_install
 * (last_error kept, so a reinstall restores each to active or error). A needs_reauth row with no
 * last_error gets 'auth_failed', so it comes back as error (Not working) and a fresh test decides.
 * Reports the projects of the rows this UPDATE actually changed (RETURNING), so a row that changes
 * state concurrently is never reported without being marked, or marked without being reported.
 * @returns {Promise<Array<{projectId:number, slug:string, name:string}>>}
 */
export async function markConnectionsNeedInstall(db, bundleId) {
  if (typeof bundleId !== "string" || !bundleId) return [];
  const changed = await db.execute({
    sql: `UPDATE service_connections SET status = 'needs_install',
            last_error = CASE WHEN status = 'needs_reauth' AND last_error IS NULL THEN 'auth_failed' ELSE last_error END,
            updated_at = datetime('now')
          WHERE bundle_id = ? AND status IN ('active', 'error', 'needs_reauth') RETURNING project_id`,
    args: [bundleId],
  });
  const ids = [...new Set(changed.rows.map((r) => Number(r.project_id)))];
  if (ids.length === 0) return [];
  const { rows } = await db.execute({
    sql: `SELECT id, slug, name FROM project_spaces WHERE id IN (${ids.map(() => "?").join(", ")}) ORDER BY slug`,
    args: ids,
  });
  return rows.map((r) => ({ projectId: Number(r.id), slug: r.slug, name: r.name }));
}

/** Reinstall of `bundleId`: needs_install rows go back to active (or error when last_error is set). */
export async function restoreConnectionsAfterInstall(db, bundleId) {
  if (typeof bundleId !== "string" || !bundleId) return 0;
  const r = await db.execute({
    sql: `UPDATE service_connections SET status = CASE WHEN last_error IS NULL THEN 'active' ELSE 'error' END,
            updated_at = datetime('now') WHERE bundle_id = ? AND status = 'needs_install'`,
    args: [bundleId],
  });
  return r.rowsAffected;
}

/**
 * What the dashboard shows. `installed === false` → needs_install whatever the row says; an active
 * row never tested → not_tested. labelKey is the i18n key `services.status.<status>`.
 */
export function connectionDisplayStatus(conn, { installed } = {}) {
  let status;
  if (installed === false) status = "needs_install";
  else if (!conn || !STATUSES.has(conn.status)) status = "error";
  else if (conn.status === "active" && !conn.lastTestedAt) status = "not_tested";
  else status = conn.status;
  return { status, labelKey: `services.status.${status}` };
}

/**
 * Who may write connections of `serviceId`. Always this instance for now; satellite Part 2 returns
 * {kind:"primary", instanceId} for a satellite that follows a primary (mirrors roleBindingAuthority
 * in model-roles-store.js).
 * @returns {Promise<{kind:"self"}|{kind:"primary", instanceId:string}>}
 */
export async function connectionAuthority(_db, _serviceId) {
  return { kind: "self" };
}
