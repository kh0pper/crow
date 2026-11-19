/**
 * The reports store: the report row, its recipe revisions, its own key/value state and its approval
 * audit trail.
 *
 * A report row is returned exactly as the database writes it (snake_case), because the approvals
 * module and the routes read the columns they set: `status`, `recipe_rev`, `recipe_hash`,
 * `sources_hash`, `live_rev`, `live_seal`, `live_nonce`, `sender_account_id` and the rest. Nothing
 * secret is stored here: a credential is named by its keychain row, never by the secret.
 *
 * `saveRecipe` is the only writer of a recipe. It hashes the recipe first (a refused recipe writes
 * nothing at all), then in ONE transaction reads the head revision, moves the head under a compare-and-
 * set on the revision it read, and inserts the revision row. A revision row is never updated, so a
 * reader can always see what was saved at rev N; the head columns are the fast path.
 *
 * Times are epoch ms from an injected clock (`now`), so a test's fake clock moves them. Which function
 * answers a missing report how:
 *   - `getReport`, `getRevision`, `getState` return null (a caller that lists or reads handles absence).
 *   - `saveRecipe`, `setState`, `updateReportColumns`, `recordAudit` throw `Error` with
 *     `code: "not_found"` (a caller that writes must not silently write nowhere).
 * Every refusal is an Error with a `code` string: `bad_input`, `bad_author_kind`, `bad_recipe` (from
 * the recipe hash), `not_found` or `conflict`.
 *
 * The stores never set a status word a report cannot be in: `status` and the delivery, tier and
 * visibility words are validated by the caller that owns them (the approvals module and the routes).
 * What this module validates is the shape it writes: ids, titles, author kinds and column names.
 */
import { randomBytes } from "node:crypto";
import { canonicalJson, recipeHash, sourcesHash } from "./recipe-hash.js";

/** The two writers of a recipe revision: the owner, or a bot acting in the report's project. */
export const REPORT_AUTHOR_KINDS = Object.freeze(["owner", "bot"]);

/** The decision words `report_approvals_audit` may hold. */
export const APPROVAL_DECISIONS = Object.freeze(["approved", "refused", "revoked"]);

/** The recipe a brand-new report starts from: no blocks, nothing read, nothing sent. */
export const EMPTY_RECIPE_JSON = '{"blocks":[]}';

const REPORT_COLUMNS = `id, project_id, owner, bot_id, title, status, recipe_json, recipe_rev,
  recipe_hash, sources_hash, schedule_id, delivery_mode, comment_tier_default, comment_visibility,
  ai_commentary, model_ref, pause_reason, notify_every_run, sender_account_id, artifact_id, live_rev,
  live_seal, live_nonce, approved_preview_run, pending_free_change, created_at, updated_at`;

/** A list row is the same head without the recipe body: a list never needs every block's settings. */
const REPORT_LIST_COLUMNS = `id, project_id, owner, bot_id, title, status, recipe_rev, recipe_hash,
  sources_hash, schedule_id, delivery_mode, comment_tier_default, comment_visibility, ai_commentary,
  model_ref, pause_reason, notify_every_run, sender_account_id, artifact_id, live_rev, live_seal,
  live_nonce, approved_preview_run, pending_free_change, created_at, updated_at`;

const REVISION_COLUMNS = `report_id, rev, recipe_json, recipe_hash, sources_hash, author_kind,
  created_at`;

/**
 * The columns `updateReportColumns` may write: the head's settings and approval bookkeeping. Never `id`,
 * `project_id`, `owner` or the head recipe columns (which only `saveRecipe` moves), and never
 * `created_at`.
 */
const WRITABLE_COLUMNS = Object.freeze([
  "bot_id", "title", "status", "schedule_id", "delivery_mode", "comment_tier_default",
  "comment_visibility", "ai_commentary", "model_ref", "pause_reason", "notify_every_run",
  "sender_account_id", "artifact_id", "live_rev", "live_seal", "live_nonce", "approved_preview_run",
  "pending_free_change",
]);
const WRITABLE = new Set(WRITABLE_COLUMNS);

const ID_RE = /^rpt-[0-9a-f]{16}$/;

function fail(code, detail) {
  const err = new Error(detail ? `${code}: ${detail}` : code);
  err.code = code;
  if (detail) err.detail = detail;
  return err;
}

function idOf(value, field = "reportId") {
  if (typeof value !== "string" || !ID_RE.test(value)) throw fail("bad_input", field);
  return value;
}

function clockOf(now) {
  return Number.isFinite(now) ? Number(now) : Date.now();
}

/* ------------------------------------------------------------------------- the report */

/**
 * Create a report in `draft` at revision 0 with an empty recipe. No revision row is written: revision 0
 * is the state of a report nobody has saved yet, and every save starts at rev 1.
 *
 * An empty `botId` is stored as NULL: "no bot" is null in this column, and the go-live seal reads both
 * spellings as "", so a row that carried the empty string would be indistinguishable to a reader.
 *
 * @param {object} db a libsql-shaped client
 * @param {{projectId: number, owner: string, botId?: string|null, title: string}} fields
 * @returns {Promise<{id: string}>}
 */
export async function createReport(db, { projectId, owner, botId = null, title } = {}) {
  if (!Number.isInteger(projectId)) throw fail("bad_input", "projectId");
  if (typeof owner !== "string" || !owner.trim()) throw fail("bad_input", "owner");
  if (typeof title !== "string" || !title.trim()) throw fail("bad_input", "title");
  if (botId != null && typeof botId !== "string") throw fail("bad_input", "botId");
  const bot = botId ? botId : null;
  const id = "rpt-" + randomBytes(8).toString("hex");
  const at = clockOf(undefined);
  await db.execute({
    sql: `INSERT INTO reports (id, project_id, owner, bot_id, title, recipe_json, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [id, projectId, owner.trim(), bot, title.trim(), EMPTY_RECIPE_JSON, at, at],
  });
  return { id };
}

/**
 * One report, every column, snake_case, or null when there is no such report.
 *
 * @param {object} db
 * @param {string} id
 * @returns {Promise<object|null>}
 */
export async function getReport(db, id) {
  if (typeof id !== "string" || !id) return null;
  const { rows } = await db.execute({
    sql: `SELECT ${REPORT_COLUMNS} FROM reports WHERE id = ?`,
    args: [id],
  });
  return rows[0] ?? null;
}

/**
 * Reports newest first, without their recipe bodies. `projectId` narrows the list to one project's
 * reports; omitted (or null), every report is listed.
 *
 * @param {object} db
 * @param {{projectId?: number|null}} [opts]
 * @returns {Promise<object[]>}
 */
export async function listReports(db, { projectId } = {}) {
  if (projectId != null && !Number.isInteger(projectId)) throw fail("bad_input", "projectId");
  const where = projectId == null ? "" : "WHERE project_id = ?";
  const { rows } = await db.execute({
    sql: `SELECT ${REPORT_LIST_COLUMNS} FROM reports ${where} ORDER BY created_at DESC, id DESC`,
    args: projectId == null ? [] : [projectId],
  });
  return rows;
}

/**
 * Save a recipe: hash it, then move the report's head and insert its revision in ONE transaction.
 *
 * The head move is the compare-and-set (`recipe_rev` equal to the revision that was read), so two
 * concurrent saves cannot both claim rev N + 1; the loser gets `code: "conflict"` and nothing is
 * written. Revision 0 has no row — a report nobody has saved yet is at 0 — so the first save is rev 1.
 *
 * @param {object} db
 * @param {{reportId: string, recipe: object, authorKind: "owner"|"bot",
 *   registry?: Record<string, {sourceBearing?: boolean}>|null, now?: number}} fields
 * @returns {Promise<{rev: number, hash: string, sourcesHash: string}>}
 * @throws {Error} `bad_input`, `bad_author_kind`, `bad_recipe`, `not_found`, `conflict`
 */
export async function saveRecipe(db, { reportId, recipe, authorKind, registry = null, now } = {}) {
  idOf(reportId);
  if (!REPORT_AUTHOR_KINDS.includes(authorKind)) throw fail("bad_author_kind", "authorKind");
  // Before the transaction: a refused recipe leaves the row and the revision table exactly as they
  // were, with no transaction ever opened.
  const hash = recipeHash(recipe);
  const srcHash = sourcesHash(recipe, registry);
  const recipeJson = canonicalJson(recipe);
  const at = clockOf(now);

  return db.runTransaction((run) => {
    const head = run({ sql: "SELECT recipe_rev FROM reports WHERE id = ?", args: [reportId] }).rows[0];
    if (!head) throw fail("not_found", "report");
    const previous = Number(head.recipe_rev) || 0;
    const rev = previous + 1;

    const moved = run({
      sql: `UPDATE reports
               SET recipe_json = ?, recipe_rev = ?, recipe_hash = ?, sources_hash = ?, updated_at = ?
             WHERE id = ? AND recipe_rev = ?`,
      args: [recipeJson, rev, hash, srcHash, at, reportId, previous],
    });
    if (moved.rowsAffected !== 1) throw fail("conflict", "recipe_rev");

    run({
      sql: `INSERT INTO report_recipe_revisions (${REVISION_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [reportId, rev, recipeJson, hash, srcHash, authorKind, at],
    });
    return { rev, hash, sourcesHash: srcHash };
  });
}

/**
 * One saved revision, or null when the report has no revision at that number.
 *
 * @param {object} db
 * @param {string} reportId
 * @param {number} rev
 * @returns {Promise<object|null>}
 */
export async function getRevision(db, reportId, rev) {
  if (typeof reportId !== "string" || !reportId) return null;
  if (!Number.isInteger(rev)) return null;
  const { rows } = await db.execute({
    sql: `SELECT ${REVISION_COLUMNS} FROM report_recipe_revisions WHERE report_id = ? AND rev = ?`,
    args: [reportId, rev],
  });
  return rows[0] ?? null;
}

/* -------------------------------------------------------------------------- the state */

/**
 * One `report_state` value, parsed from its JSON, or null when the key has never been written.
 *
 * @param {object} db
 * @param {string} reportId
 * @param {string} key
 * @returns {Promise<*|null>}
 */
export async function getState(db, reportId, key) {
  if (typeof reportId !== "string" || !reportId) return null;
  if (typeof key !== "string" || !key) return null;
  const { rows } = await db.execute({
    sql: "SELECT value_json FROM report_state WHERE report_id = ? AND key = ?",
    args: [reportId, key],
  });
  if (!rows[0]) return null;
  try {
    return JSON.parse(rows[0].value_json);
  } catch {
    return null;
  }
}

/**
 * Write one `report_state` value (JSON, upsert) for a report that exists, and read it back.
 *
 * @param {object} db
 * @param {string} reportId
 * @param {string} key
 * @param {*} value anything JSON can carry faithfully
 * @returns {Promise<{key: string, value: *, updatedAt: number}>}
 * @throws {Error} `bad_input` or `not_found`
 */
export async function setState(db, reportId, key, value) {
  idOf(reportId);
  if (typeof key !== "string" || !key) throw fail("bad_input", "key");
  const json = canonicalJson(value);
  const found = await db.execute({ sql: "SELECT id FROM reports WHERE id = ?", args: [reportId] });
  if (!found.rows[0]) throw fail("not_found", "report");
  const at = clockOf(undefined);
  const [, read] = await db.batch([
    {
      sql: `INSERT INTO report_state (report_id, key, value_json, updated_at) VALUES (?, ?, ?, ?)
            ON CONFLICT(report_id, key) DO UPDATE SET value_json = excluded.value_json,
              updated_at = excluded.updated_at`,
      args: [reportId, key, json, at],
    },
    { sql: "SELECT updated_at FROM report_state WHERE report_id = ? AND key = ?", args: [reportId, key] },
  ]);
  return { key, value, updatedAt: read.rows[0]?.updated_at ?? at };
}

/* ------------------------------------------------------------------------ the head columns */

/**
 * Update named head columns on one report (the approvals module's write path), setting `updated_at`
 * with them. A column that is not in WRITABLE_COLUMNS throws, so this cannot be talked into moving the
 * head recipe, the report's id or its owner.
 *
 * @param {object} db
 * @param {string} reportId
 * @param {Record<string, *>} columns column name to value (snake_case, as the schema names them)
 * @returns {Promise<object>} the report row after the write
 * @throws {Error} `bad_input`, `unknown_column` or `not_found`
 */
export async function updateReportColumns(db, reportId, columns) {
  idOf(reportId);
  if (columns == null || typeof columns !== "object" || Array.isArray(columns)) {
    throw fail("bad_input", "columns");
  }
  const names = Object.keys(columns);
  if (!names.length) throw fail("bad_input", "columns");
  for (const name of names) {
    if (!WRITABLE.has(name)) throw fail("unknown_column", name);
  }
  const assignments = names.map((name) => `${name} = ?`).join(", ");
  const args = names.map((name) => (columns[name] === undefined ? null : columns[name]));
  const at = clockOf(undefined);
  const result = await db.execute({
    sql: `UPDATE reports SET ${assignments}, updated_at = ? WHERE id = ?`,
    args: [...args, at, reportId],
  });
  if (result.rowsAffected !== 1) throw fail("not_found", "report");
  return getReport(db, reportId);
}

/* ----------------------------------------------------------------------------- the audit */

/**
 * Append one approval decision to `report_approvals_audit`. `actor` is a short token (`owner`, a bot
 * id) when it is a string; any other value is stored as its canonical JSON. `subject` names what was
 * decided (a recipient address, a host, a proposal id) and may be null.
 *
 * @param {object} db
 * @param {{reportId: string, kind: string, subject?: string|null, actor?: string|object|null,
 *   decided: "approved"|"refused"|"revoked", at?: number}} fields
 * @returns {Promise<{id: number}>}
 * @throws {Error} `bad_input` or `not_found`
 */
export async function recordAudit(db, { reportId, kind, subject = null, actor = null, decided, at } = {}) {
  idOf(reportId);
  if (typeof kind !== "string" || !kind) throw fail("bad_input", "kind");
  if (!APPROVAL_DECISIONS.includes(decided)) throw fail("bad_input", "decided");
  if (subject != null && typeof subject !== "string") throw fail("bad_input", "subject");
  let actorText = null;
  if (typeof actor === "string") actorText = actor;
  else if (actor != null && typeof actor === "object") actorText = canonicalJson(actor);
  else if (actor != null) throw fail("bad_input", "actor");
  const stamp = clockOf(at);
  const results = await db.batch([
    {
      sql: `INSERT INTO report_approvals_audit (report_id, kind, subject, actor, decided, at)
            SELECT ?, ?, ?, ?, ?, ?
            WHERE EXISTS (SELECT 1 FROM reports WHERE id = ?)`,
      args: [reportId, kind, subject, actorText, decided, stamp, reportId],
    },
    { sql: "SELECT last_insert_rowid() AS id", args: [] },
    { sql: "SELECT id FROM reports WHERE id = ?", args: [reportId] },
  ]);
  if (!results[2].rows[0]) throw fail("not_found", "report");
  return { id: Number(results[1].rows[0]?.id ?? 0) };
}