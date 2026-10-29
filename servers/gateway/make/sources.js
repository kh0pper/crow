// servers/gateway/make/sources.js — the Make tab's data layer: one list of artifacts and Workspace
// office files, scoped by project through shell_items. Read-only apart from ensureItem, which records
// where an artifact started (the project of the chat it was made in) the first time it is listed.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createDbClient } from "../../db.js";
import { tasksDbPath as defaultTasksDbPath } from "../../../scripts/pi-bots/instance-paths.mjs";
import {
  ensureItem, getItem, projectOfItems, activeProjectWhere, deriveArtifactProject,
} from "../../shared/shell-items.js";
import { documentCard } from "./card-docs.js";

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
 * @property {"ready"|"pending"|"off"|"workspace"} previewState  "workspace": the client tries Nextcloud's image
 * @property {string|null} previewUrl
 * @property {string|null} previewReason  why it is "off" (make/previews.js); "not_enabled" for an artifact while
 *   the previews switch is off (Workspace files keep Nextcloud's preview either way)
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
  } catch (err) {
    console.warn(`[make] bot project lookup failed for ${botId}: ${err.message}`);
    return null;
  }
}

/**
 * Map<cardId, projectId|null> for the given cards, one query against tasks.db; null when tasks.db
 * could not be read at all (distinct from a card that simply has no project).
 */
async function cardProjects(cardIds, tasksDb, tasksDbPath) {
  if (!cardIds.length) return new Map();
  let tdb = tasksDb;
  try {
    tdb ||= createDbClient(tasksDbPath());
    const { rows } = await tdb.execute({
      sql: "SELECT id, project_id FROM tasks_items WHERE id IN (SELECT value FROM json_each(?))",
      args: [JSON.stringify(cardIds)],
    });
    return new Map(rows.map((r) => [Number(r.id), num(r.project_id)]));
  } catch (err) {
    console.warn(`[make] tasks.db unreadable, origin cards not consulted: ${err.message}`);
    return null;
  } finally {
    if (!tasksDb) { try { tdb && tdb.close(); } catch {} }
  }
}

/** Live, non-deleted artifacts in a scope, newest first. */
export async function listArtifactItems(db, scope = { all: true }, { limit = 60, now = Date.now(), tasksDb = null, tasksDbPath = defaultTasksDbPath, ids: only = null } = {}) {
  // only: restrict to these artifact ids (a card's documents). The query, the filing step and the
  // listing then touch at most those rows, however old they are.
  if (only && !only.length) return [];
  let artifacts;
  try {
    ({ rows: artifacts } = await db.execute({ sql:
      `SELECT a.id, a.title, a.type, a.created_by_bot, a.origin_session, a.origin_card, a.received, a.origin_contact,
              a.current_version, a.updated_at, v.made_by, v.created_at AS version_created_at
         FROM artifacts a
         LEFT JOIN artifact_versions v ON v.artifact_id = a.id AND v.n = a.current_version
        WHERE a.deleted_at IS NULL${only ? " AND a.id IN (SELECT value FROM json_each(?))" : ""}
        ORDER BY a.updated_at DESC, a.id`,
      args: only ? [JSON.stringify(only.map(String))] : [],
    }));
  } catch (err) {
    if (!missingTable(err)) throw err;
    return [];
  }
  if (!artifacts.length) return [];
  const ids = artifacts.map((a) => a.id);
  if (only) limit = Math.max(limit, ids.length);

  // File each artifact that has no row yet under the project of the chat (card, bot) it came from.
  const existing = await itemRows(db, "artifact", ids);
  // At most `limit` per call, so a big backlog is filed over a few listings rather than in one.
  const fresh = artifacts.filter((a) => !existing.has(a.id)).slice(0, limit);
  if (fresh.length) {
    const live = await liveProjectIds(db);
    const cardIds = [...new Set(fresh.map((a) => num(a.origin_card)).filter((c) => c !== null))];
    const cards = await cardProjects(cardIds, tasksDb, tasksDbPath); // null = tasks.db unreadable
    for (const a of fresh) {
      const hasCard = num(a.origin_card) !== null;
      // ensureItem is INSERT OR IGNORE, so a wrong answer would be frozen: with the card leg unknown,
      // leave the artifact unfiled this time (it lists as Unassigned) and file it on a later listing.
      if (hasCard && cards === null) continue;
      const thread = a.origin_session ? await getItem(db, "perch_thread", a.origin_session) : null;
      const projectId = deriveArtifactProject({
        cardProjectId: hasCard ? (cards.get(num(a.origin_card)) ?? null) : null,
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
      cardId: null, projectId,
      justMade: justMadeArtifact({ madeBy: a.made_by, versionN: Number(a.current_version), versionCreatedAt: a.version_created_at, seenVersion: meta.seenVersion }, now),
      openUrl: `/dashboard/make/open/artifact/${a.id}`,
      _card: { handCardId: meta.cardId, originCard: num(a.origin_card), originSession: a.origin_session || null },
    });
  }
  const out = items.slice(0, limit);
  // The tile's #<n> chip: the document's card by card-docs.js's one rule (hand link, origin
  // card, origin thread's card), worked out only for the tiles returned.
  for (const item of out) {
    item.cardId = await documentCard(db, item._card);
    delete item._card;
  }
  return out;
}

const WS_TYPES = {
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "document",
  "application/vnd.oasis.opendocument.text": "document",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "spreadsheet",
  "application/vnd.oasis.opendocument.spreadsheet": "spreadsheet",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "deck",
  "application/vnd.oasis.opendocument.presentation": "deck",
};

const CARD_STAT_MAX = 50;
const CARD_STAT_CONCURRENCY = 4;
const CARD_STAT_DEADLINE_MS = 5000;

/**
 * A card's files: stat each id directly (not the recent list), at most CARD_STAT_MAX ids, four at a
 * time, all under one deadline. A file that is gone (not_found) or a bad id (bad_ref) is skipped. Any
 * other failure, or the deadline, means the Workspace can't answer: throw (code not_ready kept, else
 * unavailable) so the listing says so instead of claiming the card has no files.
 */
async function statCardFiles(cfg, fileIds, st, { deadlineMs }) {
  const ids = fileIds.slice(0, CARD_STAT_MAX);
  const found = new Array(ids.length).fill(null);
  let failure = null;
  let next = 0;
  let timer;
  const deadline = new Promise((resolve) => {
    timer = setTimeout(() => { failure ||= Object.assign(new Error(`Workspace lookups passed ${deadlineMs} ms`), { code: "timeout" }); resolve(); }, deadlineMs);
  });
  const worker = async () => {
    while (!failure && next < ids.length) {
      const i = next++;
      try {
        const e = await st(cfg, { file_id: Number(ids[i]) });
        if (e) found[i] = e;
      } catch (err) {
        if (err?.code === "not_found" || err?.code === "bad_ref") continue;
        failure ||= err;
      }
    }
  };
  try {
    await Promise.race([Promise.all(Array.from({ length: Math.min(CARD_STAT_CONCURRENCY, ids.length) }, worker)), deadline]);
  } finally {
    clearTimeout(timer);
  }
  if (failure) throw failure;
  const out = found.filter(Boolean);
  if (fileIds.length > ids.length) out.capped = ids.length;
  return out;
}

const workspaceImport = (crowHome, file) => import(pathToFileURL(join(crowHome, "bundles", "workspace", "server", file)).href);

/** Office files the Workspace bot can see, newest first. The array carries `status` when it can't list. */
export async function listWorkspaceItems(db, scope = { all: true }, { crowHome, limit = 40, fileIds = null, stat: statFn = null, deadlineMs = CARD_STAT_DEADLINE_MS } = {}) {
  const out = [];
  out.status = "ok";
  let files;
  // The search is not project-aware, so a project view scopes AFTER the fetch: overfetch so it isn't
  // left short by files that belong elsewhere, then cut to `limit` once scoped.
  const scoped = scope?.projectId != null || scope?.unassigned;
  try {
    const [{ getConfig }, dav] = await Promise.all([workspaceImport(crowHome, "config.js"), workspaceImport(crowHome, "nc/dav.js")]);
    const cfg = getConfig();
    if (fileIds) {
      files = await statCardFiles(cfg, fileIds, statFn || dav.stat, { deadlineMs });
      if (files.capped) out.capped = files.capped;
      limit = Math.max(limit, files.length);
    } else {
      files = await dav.listRecent(cfg, { limit: scoped ? limit * 3 : limit, mimes: Object.keys(WS_TYPES) });
    }
  } catch (err) {
    out.status = err?.code === "not_ready" ? "not_ready" : "unavailable";
    if (out.status === "unavailable") console.warn(`[make] Workspace listing failed: ${err?.message || err}`);
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
      cardId: await documentCard(db, { handCardId: rows.get(ref)?.cardId ?? null }), projectId, justMade: false,
      openUrl: `/dashboard/make/open/workspace_file/${ref}`,
    });
  }
  if (out.length > limit) out.length = limit;
  return out;
}

/**
 * Both sources merged, newest first. filter: all | documents | pages | shared.
 * previews: async (item) => { previewState, previewUrl, previewReason } (make/previews.js itemPreview),
 * applied only to the items returned; null (previews off) leaves every item a type tile.
 */
export async function listMakeItems(db, scope = { all: true }, { crowHome, filter = "all", limit, previews = null, cardRefs = null, wsStat = null, wsDeadlineMs } = {}) {
  // cardRefs (a Set of "kind:ref"): only those items, and the project scope is ignored. The sources
  // are asked for exactly the card's documents.
  if (cardRefs) { scope = { all: true }; limit = undefined; }
  const refsOf = (kind) => (cardRefs ? [...cardRefs].filter((k) => k.startsWith(`${kind}:`)).map((k) => k.slice(kind.length + 1)) : null);
  const artifacts = installedBundle(crowHome, "artifacts") ? "installed" : "missing";
  let workspace = installedBundle(crowHome, "workspace") ? "installed" : "missing";
  let wsCapped = 0; // card mode: the card has more Workspace files than were looked up
  const lists = [];
  if (artifacts === "installed") lists.push(await listArtifactItems(db, scope, cardRefs ? { ids: refsOf("artifact") } : limit ? { limit } : {}));
  if (workspace === "installed") {
    const ws = await listWorkspaceItems(db, scope, { crowHome, ...(cardRefs ? { fileIds: refsOf("workspace_file"), stat: wsStat, ...(wsDeadlineMs ? { deadlineMs: wsDeadlineMs } : {}) } : limit ? { limit } : {}) });
    if (ws.status !== "ok") workspace = ws.status;
    if (ws.capped) wsCapped = ws.capped;
    lists.push(ws);
  }
  let items = lists.flat();
  if (cardRefs) items = items.filter((i) => cardRefs.has(`${i.kind}:${i.ref}`));
  if (filter === "shared") items = items.filter((i) => i.shared);
  else if (filter === "documents" || filter === "pages") items = items.filter((i) => i.filter === filter);
  items.sort((a, b) => (a.updatedAt < b.updatedAt ? 1 : a.updatedAt > b.updatedAt ? -1 : 0));
  if (limit) items = items.slice(0, limit);
  for (const item of items) {
    Object.assign(item, { previewState: "off", previewUrl: null, previewReason: "not_enabled" });
    if (previews) Object.assign(item, await previews(item));
  }
  return { items, artifacts, workspace, ...(wsCapped ? { wsCapped } : {}) };
}

const BLANK_KINDS = {
  docx: { file: "tools/docs.js", exportName: "docsWriteDefs", tool: "ws_docs_create", args: (folder, title) => ({ folder, title, content: "", find_existing: false }) },
  xlsx: { file: "tools/sheets.js", exportName: "sheetsDefs", tool: "ws_sheets_create", args: (folder, title) => ({ folder, title, find_existing: false }) },
  pptx: { file: "tools/slides.js", exportName: "slidesDefs", tool: "ws_slides_create", args: (folder, title) => ({ title, folder }) },
};
export const BLANK_KIND_IDS = Object.keys(BLANK_KINDS);

/**
 * Create an empty office file in Crow/<project slug or "Unassigned"> by running the Workspace bundle's
 * own create tool, with the same ctx shape createWorkspaceServer builds. Every argument is spelled out
 * because zod defaults do not apply on a direct call; find_existing:false makes the tool pick a free
 * name, so Blank never re-files an existing document. Throws WsError-style errors (err.code) as the
 * bundle raises them; err.code === "workspace_missing" when the bundle is not installed.
 * @returns {Promise<{ fileId: number, webUrl: string }>}
 */
export async function createBlankWorkspaceFile({ crowHome, kind, title, projectSlug }) {
  const spec = BLANK_KINDS[kind];
  if (!spec) throw Object.assign(new Error(`unknown kind ${kind}`), { code: "bad_kind" });
  if (!installedBundle(crowHome, "workspace")) throw Object.assign(new Error("Workspace is not installed"), { code: "workspace_missing" });
  const [{ getConfig }, { realClock }, tools, { mkcol }, { toPublic }] = await Promise.all([
    workspaceImport(crowHome, "config.js"), workspaceImport(crowHome, "server.js"), workspaceImport(crowHome, spec.file),
    workspaceImport(crowHome, "nc/dav.js"), workspaceImport(crowHome, "tools/common.js"),
  ]);
  const def = (tools[spec.exportName] || []).find((d) => d.name === spec.tool);
  if (!def) throw new Error(`Workspace bundle has no ${spec.tool}`);
  const ctx = Object.freeze({ getConfig, clock: realClock });
  const cfg = getConfig(); // throws not_ready before anything is created
  await mkcol(cfg, ["Crow"]);
  const sub = projectSlug || "Unassigned";
  await mkcol(cfg, ["Crow", sub]);
  const out = await def.run(spec.args(`Crow/${sub}`, title), ctx);
  const fileId = Number(out?.file_id);
  if (!Number.isInteger(fileId) || fileId < 1) throw new Error(`${spec.tool} returned no file id`);
  return { fileId, webUrl: toPublic({ fileId }, cfg).web_url };
}
