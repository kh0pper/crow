// servers/gateway/make/sources.js — the Make tab's data layer: one list of artifacts and Workspace
// office files, scoped by project through shell_items. Read-only apart from ensureItem, which records
// where an artifact started (the project of the chat it was made in) the first time it is listed.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  ensureItem, getItem, projectOfItems, activeProjectWhere, deriveArtifactProject,
} from "../../shared/shell-items.js";

/**
 * @typedef MakeItem
 * @property {"artifact"|"workspace_file"} kind
 * @property {string} ref
 * @property {string} title
 * @property {"document"|"spreadsheet"|"deck"|"page"|"diagram"|"other"} type
 * @property {"documents"|"pages"} filter
 * @property {boolean} shared
 * @property {string} updatedAt
 * @property {number|null} version
 * @property {number|null} cardId
 * @property {number|null} projectId
 * @property {boolean} justMade
 * @property {string} openUrl
 */

const WEEK_MS = 7 * 24 * 3600 * 1000;

/** True when installed.json lists the bundle AND its manifest is on disk. Never throws. */
export function installedBundle(crowHome, id) {
  try {
    if (!crowHome || !id) return false;
    if (!existsSync(join(crowHome, "bundles", id, "manifest.json"))) return false;
    const list = JSON.parse(readFileSync(join(crowHome, "installed.json"), "utf8"));
    return Array.isArray(list) && list.some((x) => (typeof x === "string" ? x : x && x.id) === id);
  } catch {
    return false;
  }
}

const ARTIFACT_TYPES = {
  document: "document", docx: "document", pdf: "document",
  page: "page", map: "page", image: "page", data: "page",
  diagram: "diagram", slides: "deck",
};
export const artifactType = (row) => ARTIFACT_TYPES[row?.type] || "other";
export const filterOf = (type) => (["document", "spreadsheet", "deck"].includes(type) ? "documents" : "pages");

// SQLite datetime('now') is "YYYY-MM-DD HH:MM:SS" in UTC; normalise to ISO.
const toIso = (v) => {
  if (!v) return new Date(0).toISOString();
  const s = String(v);
  const t = Date.parse(/[zZ]|[+-]\d\d:?\d\d$/.test(s) ? s : `${s.replace(" ", "T")}Z`);
  return Number.isNaN(t) ? new Date(0).toISOString() : new Date(t).toISOString();
};
const num = (v) => (v === null || v === undefined ? null : Number(v));

/** A bot's version the operator has not looked at yet, made in the last 7 days. */
export function justMadeArtifact({ madeBy, versionN, versionCreatedAt, seenVersion }, now = Date.now()) {
  if (madeBy !== "bot") return false;
  if (!(seenVersion == null || seenVersion < versionN)) return false;
  const made = Date.parse(toIso(versionCreatedAt));
  return now - made <= WEEK_MS && made - now < WEEK_MS;
}

const missingTable = (err) => /no such table/i.test(String(err?.message || err));

/** Existing shell_items rows for a kind: Map<ref, { cardId, seenVersion }>. */
async function itemRows(db, kind, refs) {
  if (!refs.length) return new Map();
  try {
    const { rows } = await db.execute({
      sql: `SELECT item_ref, card_id, seen_version FROM shell_items
             WHERE item_kind = ? AND item_ref IN (SELECT value FROM json_each(?))`,
      args: [kind, JSON.stringify(refs.map(String))],
    });
    return new Map(rows.map((r) => [r.item_ref, { cardId: num(r.card_id), seenVersion: num(r.seen_version) }]));
  } catch (err) {
    if (!missingTable(err)) throw err;
    return new Map();
  }
}

const inScope = (scope, projectId) => {
  if (scope?.projectId != null) return projectId === Number(scope.projectId);
  if (scope?.unassigned) return projectId === null;
  return true;
};

async function liveProjectIds(db) {
  try {
    const { rows } = await db.execute(`SELECT id FROM project_spaces WHERE ${activeProjectWhere()}`);
    return new Set(rows.map((r) => Number(r.id)));
  } catch (err) {
    if (!missingTable(err)) throw err;
    return new Set();
  }
}

async function botProject(db, botId) {
  if (!botId) return null;
  try {
    const { rows } = await db.execute({ sql: "SELECT project_id FROM pi_bot_defs WHERE bot_id = ?", args: [botId] });
    return num(rows[0]?.project_id);
  } catch {
    return null;
  }
}

/** Live, non-deleted artifacts in a scope, newest first. */
export async function listArtifactItems(db, scope = { all: true }, { limit = 60, now = Date.now() } = {}) {
  let artifacts;
  try {
    ({ rows: artifacts } = await db.execute(
      `SELECT a.id, a.title, a.type, a.created_by_bot, a.origin_session, a.origin_card, a.received, a.origin_contact,
              a.current_version, a.updated_at, v.made_by, v.created_at AS version_created_at
         FROM artifacts a
         LEFT JOIN artifact_versions v ON v.artifact_id = a.id AND v.n = a.current_version
        WHERE a.deleted_at IS NULL
        ORDER BY a.updated_at DESC, a.id`,
    ));
  } catch (err) {
    if (!missingTable(err)) throw err;
    return [];
  }
  if (!artifacts.length) return [];
  const ids = artifacts.map((a) => a.id);

  // File each artifact that has no row yet under the project of the chat (card, bot) it came from.
  const existing = await itemRows(db, "artifact", ids);
  const fresh = artifacts.filter((a) => !existing.has(a.id));
  if (fresh.length) {
    const live = await liveProjectIds(db);
    for (const a of fresh) {
      const thread = a.origin_session ? await getItem(db, "perch_thread", a.origin_session) : null;
      const projectId = deriveArtifactProject({
        cardProjectId: null, // a card's project lives in tasks.db, which the gateway read path does not open
        threadProjectId: thread?.live ? thread.projectId : null,
        botProjectId: await botProject(db, a.created_by_bot),
        liveProjectIds: live,
      });
      try {
        await ensureItem(db, "artifact", a.id, { projectId, cardId: num(a.origin_card), setBy: "origin" });
      } catch (err) {
        if (err.code !== "not_migrated") throw err;
      }
    }
  }
  const rowsNow = await itemRows(db, "artifact", ids);
  const projects = await projectOfItems(db, "artifact", ids);

  const items = [];
  for (const a of artifacts) {
    const projectId = projects.get(a.id) ?? null;
    if (!inScope(scope, projectId)) continue;
    const meta = rowsNow.get(a.id) || { cardId: null, seenVersion: null };
    const type = artifactType(a);
    items.push({
      kind: "artifact", ref: a.id, title: a.title, type, filter: filterOf(type),
      shared: Number(a.received) === 1 && a.origin_contact != null,
      updatedAt: toIso(a.updated_at), version: num(a.current_version),
      cardId: meta.cardId, projectId,
      justMade: justMadeArtifact({ madeBy: a.made_by, versionN: Number(a.current_version), versionCreatedAt: a.version_created_at, seenVersion: meta.seenVersion }, now),
      openUrl: `/dashboard/make/open/artifact/${a.id}`,
    });
  }
  return items.slice(0, limit);
}

const WS_TYPES = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "document",
  "application/vnd.oasis.opendocument.text": "document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "spreadsheet",
  "application/vnd.oasis.opendocument.spreadsheet": "spreadsheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "deck",
  "application/vnd.oasis.opendocument.presentation": "deck",
};

const workspaceImport = (crowHome, file) => import(pathToFileURL(join(crowHome, "bundles", "workspace", "server", file)).href);

/** Office files the Workspace bot can see, newest first. The array carries `status` when it can't list. */
export async function listWorkspaceItems(db, scope = { all: true }, { crowHome, limit = 40 } = {}) {
  const out = [];
  out.status = "ok";
  let files;
  try {
    const [{ getConfig }, { listRecent }] = await Promise.all([workspaceImport(crowHome, "config.js"), workspaceImport(crowHome, "nc/dav.js")]);
    files = await listRecent(getConfig(), { limit, mimes: Object.keys(WS_TYPES) });
  } catch (err) {
    out.status = err?.code === "not_ready" ? "not_ready" : "unavailable";
    return out;
  }
  files = files.filter((f) => !f.isFolder && Number.isInteger(f.fileId) && WS_TYPES[f.mime]);
  const refs = files.map((f) => String(f.fileId));
  const projects = await projectOfItems(db, "workspace_file", refs);
  const rows = await itemRows(db, "workspace_file", refs);
  for (const f of files) {
    const ref = String(f.fileId);
    const projectId = projects.get(ref) ?? null;
    if (!inScope(scope, projectId)) continue;
    const type = WS_TYPES[f.mime];
    out.push({
      kind: "workspace_file", ref, title: f.name, type, filter: filterOf(type), shared: false,
      updatedAt: f.modified || new Date(0).toISOString(), version: null,
      cardId: rows.get(ref)?.cardId ?? null, projectId, justMade: false,
      openUrl: `/dashboard/make/open/workspace_file/${ref}`,
    });
  }
  return out;
}

/** Both sources merged, newest first. filter: all | documents | pages | shared. */
export async function listMakeItems(db, scope = { all: true }, { crowHome, filter = "all", limit } = {}) {
  const artifacts = installedBundle(crowHome, "artifacts") ? "installed" : "missing";
  let workspace = installedBundle(crowHome, "workspace") ? "installed" : "missing";
  const lists = [];
  if (artifacts === "installed") lists.push(await listArtifactItems(db, scope, limit ? { limit } : {}));
  if (workspace === "installed") {
    const ws = await listWorkspaceItems(db, scope, { crowHome, ...(limit ? { limit } : {}) });
    if (ws.status !== "ok") workspace = ws.status;
    lists.push(ws);
  }
  let items = lists.flat();
  if (filter === "shared") items = items.filter((i) => i.shared);
  else if (filter === "documents" || filter === "pages") items = items.filter((i) => i.filter === filter);
  items.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  return { items: limit ? items.slice(0, limit) : items, artifacts, workspace };
}
