/**
 * api.js — the History API: an item's versions, the difference between two of
 * them, and the write that puts one back.
 *
 * One reader over item_versions (filled by the capture triggers in covered.js)
 * with three jobs:
 *
 *   listVersions    the item's versions, newest first, keyset-paginated by id;
 *   diffVersions    what changed between two versions, field by field;
 *   restoreVersion  put a version's value back — as a NEW version, never by
 *                   rewriting history (review focus 3: restoring does not delete
 *                   what came after, it is appended after it).
 *
 * Three rules this file exists to keep in one place:
 *
 *   NO WRITES TO item_versions. A restore writes the COVERED TABLE (the ordinary
 *   INSERT/UPDATE the app would make) and lets the capture trigger record it, so
 *   the restore IS the new version and the append-only guards stay untouched.
 *   The write runs inside `withWriteContext(ctx)` and through the gateway
 *   client's `runTransaction`, so the version it produces is stamped with the
 *   restorer like any other write.
 *
 *   A RESTORE IS ONE SYNCHRONOUS TRANSACTION. Its read → compare → write →
 *   version-id all happen inside one `db.runTransaction` callback
 *   (servers/db.js), i.e. one `db.transaction(...).immediate()` on the
 *   underlying handle — the same mechanism `batch()` gives an erase
 *   (erase.js). Nothing may await between the row a restore compares against and
 *   the row it writes: an `await db.execute(...)` there would let an unrelated
 *   caller's statement on the SAME shared connection join the open transaction,
 *   and it would then commit — or roll back — with the restore. So the helpers
 *   below take a synchronous `run` and never the client. The sync emit is
 *   deliberately OUTSIDE that transaction (see emitRestored): a sync problem must
 *   never undo, or hide, a restore the operator asked for.
 *
 *   A RESTORE IS A NORMAL WRITE, SYNC INCLUDED. It used to stop at the local row,
 *   which made a restore the one edit a paired instance never heard about: the
 *   peer's next write carried the pre-restore value and won last-write-wins, and
 *   an un-delete never crossed at all. So a restore now emits through the same
 *   door an ordinary write uses (`emitOrQueue` from servers/shared/sync-emit.js,
 *   exactly as servers/memory/memory-write.js does for a memory and
 *   servers/memory/server.js does for a context section), which also MINTS the
 *   fresh lamport_ts the row needs to out-rank the peer's stale copy — `insert`
 *   for an un-delete, `update` otherwise. With no emitter (a test, a host with
 *   sync off) the write still happens and `synced` is false.
 *
 *   FIVE TYPES ARE THE EXCEPTION, FOR THE SAME REASON: their ordinary writes do
 *   not emit today, so their restores are plain local writes and `synced` is
 *   false (nothing is lost — the peer's own history is its own business, and the
 *   value it holds is unaffected):
 *     blog_posts    not in instance-sync's SYNCED_TABLES at all;
 *     research_notes the research server's add/update/withdraw tools never call
 *                   emitOrQueue (only the share-import path does), so a note edit
 *                   does not ride the feed and neither does its restore;
 *     kb_article    the knowledge-base bundle owns the table and emits nothing;
 *     bot_def       the Bot Builder's definition writes emit nothing;
 *     card          tasks.db has no sync feeds of its own (cards are
 *                   instance-global, and item_versions is local-only).
 *   emitRestored therefore returns false for them rather than inventing a
 *   new wire shape.
 *
 *   THE FILING IS RESOLVED, NOT REPLAYED. project_spaces.id is a per-instance id
 *   and REUSED after a project is deleted, so a snapshot's project_id can name a
 *   different project today. A snapshot with a project_uuid is filed by uuid
 *   (uuid → current local id); a uuid whose project is gone files the item
 *   UNFILED (both keys NULL, `unfiled: true`) instead of into a stranger's
 *   project. Without a uuid the local id is kept only while it still exists and
 *   does not contradict the live row's uuid — see resolveFiling(). A context
 *   section adds one more rule: its snapshot carries the project's uuid (a
 *   derived field, covered.js), so a section version WITHOUT one predates that
 *   and is restored unfiled rather than trusted by a bare local id
 *   (spec.filingRequiresUuid).
 *
 *   THE SNAPSHOT IS THE ROW, MINUS COUNTERS. A restore writes every snapshotted
 *   column — not just the tracked ones — because that is what makes a deleted
 *   memory come back in its project (memories.project_id / project_uuid, a blog
 *   post's published_at, a section's scope keys). What it does NOT touch is
 *   anything outside the snapshot: access_count, accessed_at, created_at /
 *   updated_at, lamport_ts, sort_order. A counter is not content, so a restore
 *   never rewinds one (the operator's ruling; the plan's "an untracked column is
 *   untouched by a restore" is exactly this list). One snapshotted column is
 *   neither content nor counter — a memory's instance_id placement pointer — and
 *   it is kept as it is too (see KEEP_CURRENT).
 *
 *   A RESTORE IS ALWAYS ATTRIBUTED. `ctx` must name a real author kind
 *   (owner | bot | peer | system). A missing one is refused rather than silently
 *   recorded as 'unattributed', because the one write a person explicitly asked
 *   for is the last one that should lose its author.
 *
 *   PROJECT WORKSPACE FILES JOIN THE SAME VIEW, FROM ANOTHER STORE. The item type
 *   `workspace_file` (item id `<project id>:<relative path>`) reads a project's
 *   own file history through workspace-history.js and answers in exactly this
 *   list's shape, with the commit id as the version id;
 *   restoreWorkspaceFileVersion puts one back. It is deliberately NOT in COVERED:
 *   a file is not a table, so every function that works on tables (specFor,
 *   diffVersions, restoreVersion) keeps refusing it and none of its versions
 *   ever lands in item_versions.
 *
 *   ARTIFACTS JOIN IT THE SAME WAY, AND WRITE NOTHING. The item type `artifact`
 *   reads through the artifacts bundle's own `artifact_versions` (which already
 *   keeps every version, immutably) and restores by asking that bundle's store for
 *   a NEW version from the old one's source. No item_versions row, no trigger on
 *   `artifacts`, and no direct write to `artifact_versions` — the bundle stays the
 *   one writer of its own store.
 *
 *   A CARD'S HISTORY LIVES IN ANOTHER DATABASE. `card` is a COVERED type whose
 *   table (tasks_items) is in the instance-global tasks.db, so its versions are
 *   rows of THAT file's item_versions: this module works on whichever client it is
 *   handed, and a caller must hand it the tasks.db client for a card (the History
 *   panel does, through historyDbFor). Nothing here ever tries to read a card from
 *   crow.db.
 *
 * BLOBs: the triggers store a blob as the reversible string 'hex:<UPPERCASE HEX>'
 * (covered.js valueExpr — json_object cannot hold a blob). Reading decodes it
 * back to bytes on the way into a restore, so a restored blob is bytes again.
 *
 * TEXT IS ESCAPED OUT OF THE BLOB MARKER'S WAY, BOTH WAYS. A text value can
 * start with "hex:" ("hex:DEADBEEF" is a hex-looking string, not necessarily
 * bytes) or with "txt:" (the escape itself), so valueExpr prefixes a TEXT value
 * starting with EITHER marker with one more 'txt:', and decodeValue below strips
 * exactly one. `hex:` therefore means bytes and `txt:` means text, unambiguously
 * for every row written since the escape. ROWS WRITTEN BEFORE IT CARRY NO MARKER
 * and cannot be told apart: a pre-escape snapshot holding "hex:DEADBEEF" is read
 * back as the blob [0xDE 0xAD 0xBE 0xEF]. That ambiguity is accepted (there is no
 * information left to resolve it with) and only affects rows stored before this
 * change.
 *
 * A DERIVED SNAPSHOT FIELD IS READ, NEVER WRITTEN. crow_context's project_uuid
 * is computed from project_spaces when the version is written (covered.js
 * `derived`), not a column of crow_context: it decides the FILING of a restored
 * section and is never part of the INSERT/UPDATE into the table itself.
 */
import { homedir } from "node:os";
import { join } from "node:path";
import { BOT_DEFINITION_KEYS, COVERED, columnValueExpr, tableColumns } from "./covered.js";
import { erasureKeys, findEraseRefusalSync } from "./erase.js";
import { AUTHOR_KINDS, withWriteContext } from "./write-context.js";
import { lineDiff } from "../line-diff.js";

/** The item type project workspace FILES answer to (not a table — see listVersions). */
export const WORKSPACE_FILE_ITEM_TYPE = "workspace_file";

/**
 * The item type ARTIFACTS answer to (not a table of ours — see listVersions).
 *
 * An artifact already keeps its versions in the artifacts bundle's
 * `artifact_versions` (one row per version, immutable, with the source it was
 * rendered from), so History READS THROUGH it and writes nothing of its own: no
 * item_versions row, no trigger on `artifacts`. Its version id is that row's `n`.
 * Restoring goes through the bundle's own store (addVersion), which is the one
 * path that can write a new current version safely.
 */
export const ARTIFACT_ITEM_TYPE = "artifact";

/** Versions per page when the caller does not say. */
export const DEFAULT_LIMIT = 100;

/** The cap a caller cannot raise: a history view is a page, not an export. */
export const MAX_LIMIT = 500;

/** A stored blob: 'hex:' plus an even number of UPPERCASE hex digits. */
const HEX_BLOB_RE = /^hex:(?:[0-9A-F]{2})*$/;

/** The escape for a TEXT value that would otherwise look like a stored blob. */
const TEXT_ESCAPE = "txt:";

/** An Error with a machine-readable `code`, so a route can map it to a message. */
function historyError(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

const isObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** The covered spec for an item type, or a clear refusal. */
function specFor(itemType) {
  const spec = typeof itemType === "string" && Object.hasOwn(COVERED, itemType) ? COVERED[itemType] : null;
  if (!spec) throw historyError("unsupported", `unknown item type ${JSON.stringify(itemType)}`);
  return spec;
}

/** The item id as the TEXT item_versions stores it. */
function normalizeItemId(itemId) {
  if (typeof itemId === "number" && Number.isFinite(itemId)) return String(itemId);
  if (typeof itemId === "string") {
    const trimmed = itemId.trim();
    return trimmed === "" ? null : trimmed;
  }
  return null;
}

/** A version id as an integer, or null when it is not one. */
function normalizeVersionId(versionId) {
  if (typeof versionId !== "number" && typeof versionId !== "string") return null;
  if (typeof versionId === "string" && versionId.trim() === "") return null;
  const n = Number(versionId);
  if (!Number.isInteger(n) || n <= 0) return null;
  return n;
}

/** The page size actually used: 1…MAX_LIMIT, the default for anything unusable. */
function normalizeLimit(limit) {
  const n = Math.trunc(Number(limit));
  if (!Number.isFinite(n) || n <= 0) return DEFAULT_LIMIT;
  return Math.min(n, MAX_LIMIT);
}

/** SQL identifier quoting (nothing here is user input, but stay exact). */
const quote = (ident) => `"${String(ident).replace(/"/g, '""')}"`;

/* --------------------------------------------------------------- shapes */

/**
 * A snapshot value as it will be written: one leading 'txt:' back to text,
 * 'hex:…' back to bytes, anything else as-is. Both markers are self-describing
 * and reversible — valueExpr adds exactly one 'txt:' to a text value starting
 * with either marker, and this strips exactly one — so the only value that cannot
 * be recovered is one stored before the 'txt:' escape existed (see the BLOBs note
 * at the top of this file).
 */
function decodeValue(value) {
  if (typeof value !== "string") return value;
  if (value.startsWith(TEXT_ESCAPE)) return value.slice(TEXT_ESCAPE.length);
  if (HEX_BLOB_RE.test(value)) return Buffer.from(value.slice(4), "hex");
  return value;
}

/**
 * A comparable form of one value. Two values are "the same" for restore purposes
 * only when they would be written identically: 7 and '7' are not, a NULL and a
 * missing value are, and a blob compares by its bytes. An OBJECT or an array (a
 * bot definition's stored projection) compares by its JSON, so two versions whose
 * only difference is inside it are seen as different.
 */
function canonical(value) {
  if (value === undefined || value === null) return "null";
  if (Buffer.isBuffer(value)) return `blob:${value.toString("hex").toUpperCase()}`;
  if (value instanceof Uint8Array) return `blob:${Buffer.from(value).toString("hex").toUpperCase()}`;
  if (typeof value === "number") return `number:${value}`;
  if (typeof value === "boolean") return `boolean:${value}`;
  if (typeof value === "object") {
    try {
      return `json:${JSON.stringify(value)}`;
    } catch {
      return `object:${String(value)}`;
    }
  }
  return `string:${String(value)}`;
}

/**
 * One item_versions row in the History list shape. `itemType` / `itemId` ride
 * along because diffVersions needs the type to order and type its fields, and
 * `redacted` because a redacted version must be shown as one (Task 4 sets it).
 * The snapshot is the parsed JSON as stored — a hex blob stays a hex string
 * here; only a restore turns it back into bytes.
 */
function toVersion(row) {
  return {
    id: Number(row.id),
    itemType: row.item_type,
    itemId: row.item_id,
    op: row.op,
    authorKind: row.author_kind,
    authorId: row.author_id,
    jobId: row.job_id,
    originInstance: row.origin_instance,
    redacted: Number(row.redacted) === 1,
    createdAt: row.created_at,
    snapshot: JSON.parse(row.snapshot_json),
  };
}

const VERSION_COLUMNS = `id, item_type, item_id, op, snapshot_json,
       author_kind, author_id, job_id, origin_instance, redacted, created_at`;

/* -------------------------------------------------- workspace file items */

/** A git commit id, the only kind of version id a workspace file has. */
const SHA_RE = /^[0-9a-f]{40}$/;

/**
 * A workspace file's item id is `<project id>:<relative path>`. The split is at
 * the FIRST colon because project ids are digits and a path may contain colons.
 */
function parseWorkspaceItemId(itemId) {
  const id = normalizeItemId(itemId);
  if (id === null) throw historyError("invalid_request", "listVersions needs an itemId");
  const at = id.indexOf(":");
  if (at <= 0) throw historyError("invalid_request", "a workspace file id is <project id>:<path>");
  const projectId = id.slice(0, at);
  const relPath = id.slice(at + 1);
  if (!/^[0-9]+$/.test(projectId) || Number(projectId) <= 0) {
    throw historyError("invalid_request", "a workspace file id starts with a project id");
  }
  if (relPath === "") throw historyError("invalid_request", "a workspace file id ends with a file path");
  return { projectId: Number(projectId), relPath };
}

/** The project a workspace file belongs to, or null when there is no such row. */
async function loadWorkspaceProject(db, projectId) {
  const { rows } = await db.execute({
    sql: "SELECT id, uuid, workspace_dir FROM project_spaces WHERE id = ? AND archived_at IS NULL",
    args: [projectId],
  });
  const row = rows[0];
  if (!row) return null;
  return { id: Number(row.id), uuid: row.uuid ?? null, workspace_dir: row.workspace_dir ?? null };
}

/**
 * A workspace file's versions, in the SAME shape as the database item types'
 * versions: `id` is the commit id (a string, not an integer), the snapshot
 * carries the file's size at that version and the path, and the database-only
 * fields (`originInstance`, `redacted`) are the constants a local file store
 * always answers with.
 */
async function listWorkspaceFileVersions(db, { itemId, limit, before, dataDir }) {
  const { projectId, relPath } = parseWorkspaceItemId(itemId);
  let cursor = null;
  if (before !== null && before !== undefined) {
    cursor = String(before).trim();
    if (!SHA_RE.test(cursor)) throw historyError("invalid_request", "before must be a version id");
  }
  const project = await loadWorkspaceProject(db, projectId);
  // A project that is gone has no versions left to show (a delete removes its
  // file history at once); an empty list is the honest answer, not an error.
  if (!project) return [];
  const { listWorkspaceVersions } = await import("./workspace-history.js");
  const versions = await listWorkspaceVersions(project, relPath, {
    limit: normalizeLimit(limit),
    before: cursor,
    dataDir,
  });
  return versions.map((version) => ({
    id: version.id,
    itemType: WORKSPACE_FILE_ITEM_TYPE,
    itemId: normalizeItemId(itemId),
    op: version.op,
    authorKind: version.authorKind,
    authorId: version.authorId,
    jobId: version.jobId,
    originInstance: null,
    redacted: false,
    createdAt: version.createdAt,
    snapshot: { size: version.size, path: relPath },
  }));
}

/**
 * Put one version of a project workspace file back: the file bytes as they were,
 * written through a temporary file and then recorded as a NEW version by the file
 * history's own commit (a restore never rewrites what came after it).
 *
 * `ctx` must name a real author kind, refused exactly as restoreVersion refuses a
 * missing one: the one write a person explicitly asked for is the last one that
 * should lose its author.
 *
 * `dataDir` is optional (the instance's own data dir by default) and exists for
 * tests that keep their data somewhere else.
 *
 * @returns {Promise<{newVersionId: string|null, unchanged: boolean}>}
 */
export async function restoreWorkspaceFileVersion(db, { projectId, path, versionId } = {}, ctx, { dataDir } = {}) {
  if (!isObject(ctx) || !AUTHOR_KINDS.includes(ctx.authorKind)) {
    throw historyError(
      "invalid_context",
      "a restore must name who is restoring it (authorKind owner, bot, peer or system)",
    );
  }
  const id = normalizeVersionId(projectId);
  if (id === null) throw historyError("invalid_request", "restoreWorkspaceFileVersion needs a project id");
  const sha = typeof versionId === "string" ? versionId.trim() : "";
  if (!SHA_RE.test(sha)) throw historyError("invalid_request", "a workspace file version id is a version string");
  const project = await loadWorkspaceProject(db, id);
  if (!project) throw historyError("not_found", `no project ${id}`);
  const { restoreWorkspaceFile, makeDbLiveCheck } = await import("./workspace-history.js");
  // The project row may be purged while the restore waits for the git dir: the
  // live check is what stops a restore from re-creating a deleted project's
  // history (or writing into its old workspace).
  return restoreWorkspaceFile(project, path, sha, ctx, { dataDir, isLive: makeDbLiveCheck(db) });
}

/* ---------------------------------------------------------- artifact items */

/**
 * The artifacts bundle's own code, loaded lazily and memoized.
 *
 * The bundle is always in the checkout (`bundles/artifacts`), but nothing in
 * `servers/` may import it statically: a bundle is a thing a user installs, and a
 * static import would make the gateway fail to boot on a tree where it is gone.
 * A dynamic import that fails is reported as `unavailable`, never as a crash.
 */
const ARTIFACT_BUNDLE_DIR = new URL("../../../bundles/artifacts/server/", import.meta.url);

let artifactModules = null;

async function loadArtifactModules() {
  if (artifactModules) return artifactModules;
  const [store, blobMinio, design, renderer, dbModule] = await Promise.all([
    import(new URL("store.js", ARTIFACT_BUNDLE_DIR).href),
    import(new URL("blob-store-minio.js", ARTIFACT_BUNDLE_DIR).href),
    import(new URL("design.js", ARTIFACT_BUNDLE_DIR).href).catch(() => null),
    import("../../blog/renderer.js"),
    import("../../db.js"),
  ]);
  artifactModules = { store, blobMinio, design, markdownBlocks: renderer.markdownBlocks, resolveDataDir: dbModule.resolveDataDir };
  return artifactModules;
}

/**
 * The seams an artifact read/restore needs: the bundle's store, a blob store and
 * the render deps (the markdown renderer and the optional Design kit). A caller
 * may pass its own (`{store, blobs, renderDeps}`) — that is how a test drives it
 * without a gateway — and anything it omits is built the same way the artifacts
 * panel builds it (bundleImport/createBlobStore + `renderDeps`).
 */
async function artifactSeams(seams = {}) {
  let mods = null;
  const need = () => (mods ||= loadArtifactModules());
  const db = seams.db || null;
  const store = seams.store || (await need()).store;
  let blobs = seams.blobs || null;
  let renderDeps = seams.renderDeps || null;
  return {
    store,
    async blobs(dbClient) {
      if (blobs) return blobs;
      const m = await need();
      blobs = await m.blobMinio.createBlobStore(dbClient ?? db, m.resolveDataDir());
      return blobs;
    },
    async renderDeps(dbClient) {
      if (renderDeps) return renderDeps;
      const m = await need();
      let design = null;
      if (m.design) {
        try {
          design = m.design.createDesign({
            crowHome: process.env.CROW_HOME || join(homedir(), ".crow"),
            db: dbClient ?? db,
          });
        } catch {
          design = null; // no Design kit: a version that used libs refuses, which is honest
        }
      }
      renderDeps = { markdownBlocks: m.markdownBlocks, design };
      return renderDeps;
    },
  };
}

/**
 * An artifact's versions, in the SAME shape as the database item types' versions:
 * `id` is the artifact version number `n`, the snapshot carries what a reader
 * needs to tell two versions apart (title, state, the note, the content hash), and
 * nothing is written — `artifact_versions` is the store, and History only reads it.
 *
 * A version made from untrusted input, or flagged, is listed (it happened) with
 * `untrusted: true` so a caller can refuse to restore it.
 */
async function listArtifactVersions(db, { itemId, limit, before }) {
  const id = normalizeItemId(itemId);
  if (id === null) throw historyError("invalid_request", "listVersions needs an itemId");
  let cut = null;
  if (before !== null && before !== undefined) {
    cut = normalizeVersionId(before);
    if (cut === null) throw historyError("invalid_request", "before must be a version id");
  }
  let artRows;
  try {
    ({ rows: artRows } = await db.execute({
      sql: "SELECT id, title, current_version FROM artifacts WHERE id = ? AND deleted_at IS NULL",
      args: [id],
    }));
  } catch (err) {
    // No artifacts tables on this instance (the bundle was never installed): there
    // is no such artifact, which is the honest answer, not a crash.
    if (/no such table/i.test(String(err?.message))) throw historyError("not_found", `no artifact ${id}`);
    throw err;
  }
  const artifact = artRows[0];
  if (!artifact) throw historyError("not_found", `no artifact ${id}`);
  const args = [id];
  let sql =
    "SELECT n, state, made_by, made_by_bot, change_note, content_hash, source_json, created_at, " +
    "untrusted_input, trust_cleared_at, flagged_reason FROM artifact_versions WHERE artifact_id = ?";
  if (cut !== null) {
    sql += " AND n < ?";
    args.push(cut);
  }
  sql += " ORDER BY n DESC LIMIT ?";
  args.push(normalizeLimit(limit));
  const { rows } = await db.execute({ sql, args });
  return rows.map((row) => {
    const n = Number(row.n);
    const untrusted = Number(row.untrusted_input) === 1 && !row.trust_cleared_at;
    return {
      id: n,
      itemType: ARTIFACT_ITEM_TYPE,
      itemId: id,
      // The artifacts store has no insert/update/delete vocabulary: n=1 is the
      // artifact's own creation and everything after it is an edit.
      op: n === 1 ? "insert" : "update",
      authorKind: row.made_by === "bot" ? "bot" : "owner",
      authorId: row.made_by === "bot" ? (row.made_by_bot ?? null) : null,
      jobId: null,
      originInstance: null,
      redacted: false,
      untrusted: untrusted || Boolean(row.flagged_reason),
      createdAt: row.created_at,
      snapshot: {
        title: artifact.title ?? null,
        version: n,
        state: row.state ?? null,
        changed: row.change_note ?? null,
        content_hash: row.content_hash ?? null,
      },
    };
  });
}

/**
 * Put one artifact version back, THROUGH THE ARTIFACT STORE.
 *
 * There is no `revert` in that store, and there should not be one: a restore is
 * `addVersion` with the old version's SOURCE, which renders a NEW current version
 * (so nothing after the restored one is deleted — the same rule the table types
 * follow). `never write artifact_versions directly` is kept: this function only
 * reads the old row and hands its source to the store.
 *
 * OWNER ONLY (actor `{kind:'session'}`), and refused for:
 *   - a RECEIVED artifact (the store refuses it: it is not ours to edit),
 *   - an UNTRUSTED version (made from non-owner text) or a FLAGGED one — replaying
 *     one as a new current version would launder text the owner never approved,
 *   - a version whose source no longer parses.
 * The store's own errors are surfaced in the History API's shape (not_found,
 * untrusted, conflict, …) so a caller maps them exactly as it maps the rest.
 *
 * `synced` is always false: artifacts do not ride instance sync.
 */
async function restoreArtifactVersion(db, { itemId, versionId, artifacts }, ctx) {
  if (!isObject(ctx) || ctx.authorKind !== "owner") {
    throw historyError("invalid_context", "an artifact version is restored by the owner only");
  }
  const id = normalizeItemId(itemId);
  if (id === null) throw historyError("invalid_request", "restoring an artifact version needs its artifact id");
  const n = normalizeVersionId(versionId);
  if (n === null) throw historyError("invalid_request", "restoreVersion needs a version id");

  const { rows } = await db.execute({
    sql: "SELECT n, source_json, untrusted_input, trust_cleared_at, flagged_reason FROM artifact_versions WHERE artifact_id = ? AND n = ?",
    args: [id, n],
  });
  const version = rows[0];
  if (!version) throw historyError("not_found", `no artifact version ${n}`);
  if (artifactVersionRefused(version)) {
    throw historyError(
      "untrusted",
      `artifact version ${n} was made from content the owner has not approved, so it cannot be put back`,
    );
  }
  let source;
  try {
    source = version.source_json ? JSON.parse(version.source_json) : null;
  } catch {
    source = null;
  }
  if (!isObject(source)) throw historyError("conflict", `artifact version ${n} has no source to put back`);

  let seams;
  try {
    seams = await artifactSeams({ ...(artifacts || {}), db });
  } catch (err) {
    throw historyError("unavailable", `the artifacts bundle is not available here (${err?.message ?? err})`);
  }
  const [blobs, renderDeps] = await Promise.all([seams.blobs(db), seams.renderDeps(db)]);
  const actor = { kind: "session", id: null };
  try {
    // baseVersion = the CURRENT version, so the restore becomes current when
    // nothing else moved (the store's compare-and-set makes it a proposal if it
    // did — the owner then decides, exactly as for an ordinary edit).
    //
    // changeNote says where the new version came from, in the same stored English
    // the other notes use (the MCP tools write theirs — "The round's update
    // landed." — and nothing localizes a change note today, so this adds no es
    // string), and the version list shows it beside the version number.
    const art = await seams.store.requireAccess(db, actor, id);
    const result = await seams.store.addVersion(
      db,
      blobs,
      {
        artifactId: id,
        source,
        actor,
        baseVersion: Number(art.current_version),
        changeNote: `Restored from version ${n}`,
      },
      renderDeps,
    );
    return { newVersionId: Number(result.n), unchanged: false, synced: false, unfiled: false };
  } catch (err) {
    throw asHistoryError(artifactError(err));
  }
}

/** A stored artifact version the History API refuses to replay. */
function artifactVersionRefused(version) {
  if (version.flagged_reason) return true;
  return Number(version.untrusted_input) === 1 && !version.trust_cleared_at;
}

/** The artifacts store's error → a History API error (the code a page already maps). */
function artifactError(err) {
  const code = err && typeof err.code === "string" ? err.code : null;
  if (code === "not_found") return historyError("not_found", err.message);
  // A received artifact (the store's "cannot be edited") and a tainted input are
  // both "this is not the owner's own content": one refusal word for both.
  if (code === "forbidden" || code === "flagged") return historyError("untrusted", err.message);
  if (code === "bad_source" || code === "bad_request") return historyError("invalid_request", err.message);
  if (code === "quota_full" || code === "stale" || code === "cas_lost" || code === "busy") {
    return historyError("conflict", err.message);
  }
  return err;
}

/* ---------------------------------------------------------- listVersions */

/**
 * One item's versions, newest first.
 *
 * Keyset pagination, not OFFSET: `before` is the id of the oldest version the
 * caller already has, and the next page is `id < before`. History is append-only,
 * so an id cursor never skips or repeats a row the way an offset would when a new
 * version lands between two page requests.
 *
 * `item_type` is part of every predicate: item ids are per table (memories and
 * crow_context both have id 3), so a query on item_id alone would mix two items'
 * histories together.
 */
export async function listVersions(db, { itemType, itemId, limit = DEFAULT_LIMIT, before = null, dataDir, artifacts } = {}) {
  // A project workspace file is not a table: its versions live in the project's
  // own file history, and its version id is a commit id rather than an integer.
  // An ARTIFACT is not one of OUR tables either: it already keeps its versions
  // in the bundle's artifact_versions, so History reads through and stores
  // nothing (no item_versions row, no trigger on `artifacts`).
  // Everything else keeps the item_versions path below, unchanged.
  if (itemType === WORKSPACE_FILE_ITEM_TYPE) {
    return listWorkspaceFileVersions(db, { itemId, limit, before, dataDir });
  }
  if (itemType === ARTIFACT_ITEM_TYPE) {
    return listArtifactVersions(db, { itemId, limit, before });
  }
  specFor(itemType);
  const id = normalizeItemId(itemId);
  if (id === null) throw historyError("invalid_request", "listVersions needs an itemId");

  const args = [itemType, id];
  let sql = `SELECT ${VERSION_COLUMNS} FROM item_versions WHERE item_type = ? AND item_id = ?`;
  if (before !== null && before !== undefined) {
    const cursor = normalizeVersionId(before);
    if (cursor === null) throw historyError("invalid_request", "before must be a version id");
    sql += " AND id < ?";
    args.push(cursor);
  }
  sql += " ORDER BY id DESC LIMIT ?";
  args.push(normalizeLimit(limit));

  const { rows } = await db.execute({ sql, args });
  return rows.map(toVersion);
}

/* ---------------------------------------------------------- historySize */

/**
 * How big the version store is: the row count and an approximate byte size
 * (SUM(LENGTH(snapshot_json))). The settings section's size line is the whole
 * caller — a small machine needs to see the number rather than discover it when
 * the disk fills (the version history design §6).
 *
 * APPROXIMATE, and it says so: LENGTH counts characters for a text column, so a
 * snapshot of multi-byte text takes more bytes on disk than this adds up. It is
 * the right order of magnitude, which is what the line is for.
 *
 * A store that has not run the history migration has no table: zeros, never a
 * throw, so a settings page can never fail because history is not set up.
 *
 * @returns {Promise<{versions: number, bytes: number}>}
 */
export async function historySize(db) {
  try {
    const { rows } = await db.execute({
      sql: "SELECT COUNT(*) AS versions, COALESCE(SUM(LENGTH(snapshot_json)), 0) AS bytes FROM item_versions",
      args: [],
    });
    return { versions: Number(rows[0]?.versions) || 0, bytes: Number(rows[0]?.bytes) || 0 };
  } catch {
    return { versions: 0, bytes: 0 };
  }
}

/* ---------------------------------------------------------- diffVersions */

/** Is this snapshot value ordinary text (not a stored blob)? */
const isTextValue = (v) => typeof v === "string" && !HEX_BLOB_RE.test(v);

/**
 * A field is shown as a line diff when both sides are text-or-empty: a string on
 * at least one side and nothing but a string or NULL on the other. Everything
 * else — numbers, toggles, NULL→number, a blob — is a before/after value, where
 * a whole-value change is the honest rendering (an importance of 5 becoming 8 is
 * not a line edit).
 */
function diffKind(before, after) {
  const ok = (v) => v === null || v === undefined || isTextValue(v);
  return ok(before) && ok(after) && (isTextValue(before) || isTextValue(after)) ? "text" : "value";
}

/** The spec for a pair of versions: their item type's, or one built from their keys. */
function specForPair(a, b) {
  for (const v of [a, b]) {
    if (isObject(v) && typeof v.itemType === "string" && Object.hasOwn(COVERED, v.itemType)) return COVERED[v.itemType];
  }
  const keys = [];
  for (const v of [a, b]) {
    const snapshot = isObject(v) && isObject(v.snapshot) ? v.snapshot : {};
    for (const key of Object.keys(snapshot)) if (!keys.includes(key)) keys.push(key);
  }
  return { tracked: [], snapshot: keys };
}

/**
 * What changed between two versions: tracked fields first (the order the edit
 * form shows them in), then the rest of the snapshot, and only fields that
 * actually differ.
 *
 * Text fields carry a line diff from servers/shared/line-diff.js — a plain LCS
 * table, deterministic and dependency-free — as `lines` (with `op` " ", "-" or
 * "+"), plus `added` / `removed` counts. Non-text fields carry the two values.
 * Every entry keeps `field`, `before` and `after`, so a caller that only needs
 * to know WHAT changed does not have to care which kind it is.
 *
 * Pure and synchronous: no database, no clock, no randomness.
 */
export function diffVersions(a, b) {
  if (!isObject(a) || !isObject(b)) throw historyError("invalid_request", "diffVersions needs two versions");
  const spec = specForPair(a, b);
  const snapshotOf = (v) => (isObject(v.snapshot) ? v.snapshot : {});

  // Tracked first, then the remaining snapshot columns, then anything either
  // snapshot carries that the type's list does not name (a newer column, or a
  // hand-built snapshot).
  const fields = [...spec.tracked, ...spec.snapshot.filter((c) => !spec.tracked.includes(c))];
  for (const v of [a, b]) {
    for (const key of Object.keys(snapshotOf(v))) if (!fields.includes(key)) fields.push(key);
  }

  const out = [];
  for (const field of fields) {
    const before = snapshotOf(a)[field] ?? null;
    const after = snapshotOf(b)[field] ?? null;
    if (canonical(before) === canonical(after)) continue;

    if (diffKind(before, after) === "text") {
      const lines = lineDiff(typeof before === "string" ? before : "", typeof after === "string" ? after : "");
      out.push({
        field,
        kind: "text",
        before,
        after,
        lines: lines.lines,
        added: lines.added,
        removed: lines.removed,
        capped: lines.capped,
      });
    } else {
      out.push({ field, kind: "value", before, after });
    }
  }
  return out;
}

/* ------------------------------------------------------- restoreVersion */

/**
 * The synchronous statement runner a restore works through.
 *
 * Every read, comparison and write of a restore goes through this — `run` comes
 * from `db.runTransaction` (servers/db.js) and executes IMMEDIATELY on the
 * underlying handle, inside the one transaction the whole restore is. Deliberately
 * not `db.execute`: awaiting a statement between the read and the write would let
 * another caller's statement on the same shared connection join the transaction.
 *
 * @typedef {(statement: {sql: string, args?: any[]}) =>
 *   {rows: object[], columns: string[], rowsAffected: number, lastInsertRowid: number}} RunStatement
 */

/** The version row, or null. */
function readVersion(run, versionId) {
  const { rows } = run({ sql: `SELECT ${VERSION_COLUMNS} FROM item_versions WHERE id = ?`, args: [versionId] });
  return rows[0] ?? null;
}

/**
 * The live row's own columns (every snapshotted one the TABLE actually has — a
 * derived field is computed, not stored), or null when the row is gone.
 */
function readRow(run, spec, itemId) {
  const columns = tableColumns(spec);
  const { rows } = run({
    sql: `SELECT ${columns.map(quote).join(", ")} FROM ${quote(spec.table)} WHERE ${quote(spec.idColumn)} = ?`,
    args: [itemId],
  });
  return rows[0] ?? null;
}

/** The newest version id in the table — the watermark a restore's write crosses. */
function maxVersionId(run) {
  const { rows } = run({ sql: "SELECT COALESCE(MAX(id), 0) AS id FROM item_versions", args: [] });
  return Number(rows[0]?.id ?? 0);
}

/** The id of the newest `delete` version of this item newer than `versionId`, or null. */
function deleteVersionAfter(run, itemType, itemId, versionId) {
  const { rows } = run({
    sql: `SELECT MAX(id) AS id FROM item_versions
           WHERE item_type = ? AND item_id = ? AND op = 'delete' AND id > ?`,
    args: [itemType, itemId, versionId],
  });
  const id = rows[0]?.id;
  return id === null || id === undefined ? null : Number(id);
}

/* ------------------------------------------------------------- the filing */

/** A non-empty string, or null (an empty project_uuid is no uuid at all). */
const nonEmpty = (v) => (typeof v === "string" && v.trim() !== "" ? v : null);

/** One project_spaces row as {id, uuid}, by uuid or by local id; null when absent. */
function findProject(run, { uuid = null, id = null } = {}) {
  const byUuid = uuid !== null;
  const value = byUuid ? uuid : id;
  if (value === null || value === undefined) return null;
  const { rows } = run({
    sql: `SELECT id, uuid FROM project_spaces WHERE ${byUuid ? "uuid" : "id"} = ?`,
    args: [value],
  });
  return rows[0] ? { id: Number(rows[0].id), uuid: rows[0].uuid ?? null } : null;
}

/**
 * The filing a snapshot can actually have on THIS instance, now.
 *
 * project_spaces.id is a per-instance integer and it is REUSED: delete a project
 * and the next one created takes the id. So a version's project_id is not a fact
 * about today's project table, and writing it back verbatim can file an item into
 * a stranger's project. Four cases, in the order they are decided:
 *
 *   the snapshot names a project_uuid   the UUID is the portable key, so it wins:
 *                                       it resolves to whatever local id that
 *                                       project has NOW (which may differ from the
 *                                       snapshot's project_id), and if the uuid is
 *                                       gone its project was deleted — the item is
 *                                       written UNFILED rather than into whoever
 *                                       holds the old id.
 *   no project at all in the snapshot   unfiled, and nothing was lost (unfiled is
 *                                       false: there was no filing to lose).
 *   no uuid, and the type REQUIRES one  unfiled, `unfiled: true`. crow_context is
 *                                       that type: project_uuid is a derived
 *                                       snapshot field written WITH the triggers,
 *                                       so a version without one predates them and
 *                                       holds only a per-instance id — the one
 *                                       thing that cannot be trusted. Filing it
 *                                       into whoever holds that id now is exactly
 *                                       the corruption this function prevents.
 *   no uuid, id still exists           keep it — unless the LIVE row already names
 *                                       a different project by uuid, which is proof
 *                                       that this id no longer means this item's
 *                                       project (a memory whose uuid arrived later
 *                                       than the version being restored).
 *   no uuid, id gone                   unfiled: project_id NULL (and project_uuid
 *                                       NULL where the snapshot carries one).
 *
 * `unfiled: true` is reported for the caller to show: an item that came back but
 * could not come back to its project is not a failure, and it is not a silent
 * success either. Only the types with a project filing have one — blog posts
 * belong to the instance, not a project.
 *
 * @returns {{project_id: number|null|undefined, project_uuid: string|null|undefined,
 *   unfiled: boolean}} `undefined` for a column the snapshot does not carry: it is
 *   then not written at all, and a version predating the column stays that way.
 */
function resolveFiling(run, spec, snapshot, live) {
  const out = { project_id: undefined, project_uuid: undefined, unfiled: false };
  if (!spec.projectRef.includes("project_id")) return out;
  if (!Object.prototype.hasOwnProperty.call(snapshot, "project_id")) return out;

  const uuid = nonEmpty(snapshot.project_uuid);
  if (uuid !== null) {
    const project = findProject(run, { uuid });
    if (project) {
      out.project_id = project.id;
      out.project_uuid = uuid;
      return out;
    }
    out.project_id = null;
    out.project_uuid = null;
    out.unfiled = true;
    return out;
  }

  const wanted = snapshot.project_id ?? null;
  if (wanted === null) {
    out.project_id = null;
    return out;
  }
  // A type whose snapshot is only portable cannot be filed by a local id: see
  // spec.filingRequiresUuid and the note above.
  if (spec.filingRequiresUuid) {
    out.project_id = null;
    out.project_uuid = null;
    out.unfiled = true;
    return out;
  }
  const project = findProject(run, { id: wanted });
  if (!project) {
    out.project_id = null;
    out.project_uuid = null;
    out.unfiled = true;
    return out;
  }
  // The live row's portable key disproves the local id: this memory says it is in
  // project <liveUuid>, and the project at `wanted` is not that project.
  const liveUuid = live ? nonEmpty(live.project_uuid) : null;
  if (liveUuid !== null && project.uuid !== liveUuid) {
    out.project_id = null;
    out.project_uuid = null;
    out.unfiled = true;
    return out;
  }
  out.project_id = project.id;
  return out;
}

/* ------------------------------------------------------------ the sync emit */

/**
 * Snapshotted columns a restore does NOT write back, per table.
 *
 * memories.instance_id is a PLACEMENT pointer — which of the owner's machines
 * the memory was written on. It is in the snapshot (an erase and the reader both
 * want the whole row) but it is not content, so restoring an old value of the
 * memory must not drag the row's placement back to a machine it has since moved
 * off. Its CURRENT value is kept, which also means a version differing only in
 * instance_id is an unchanged restore (and writes no version: the trigger watches
 * content).
 */
const KEEP_CURRENT = Object.freeze({
  memories: Object.freeze(["instance_id"]),
  // A CARD RESTORES CONTENT ONLY. Title, description and the plan fields
  // (priority, due_date, phase, owner, tags) come back; everything that says what
  // the card IS right now stays as it is:
  //   status / completed_at's terminal state   a restore of an old title must not
  //                                            reopen a card that is done, nor
  //                                            mark a live one done because the
  //                                            version predates its completion;
  //   assigned_bot / bot_id / autonomy         who is working it, and with what
  //                                            licence, is a decision someone made
  //                                            after this version, not content;
  //   project_id / parent_id / board_id        placement. project_spaces ids are
  //                                            per-instance and REUSED, tasks.db has
  //                                            no project_spaces to resolve one
  //                                            against, and a card that moved to
  //                                            another project (or under another
  //                                            parent, or onto another board) must
  //                                            not be dragged back.
  // All of them stay IN the snapshot (covered.js), so History still SHOWS who was
  // assigned and which column the card was in when that version was written — a
  // restore just never replays them.
  tasks_items: Object.freeze([
    "project_id",
    "status",
    "assigned_bot",
    "bot_id",
    "autonomy",
    "parent_id",
    "board_id",
  ]),
});

/**
 * The timestamp column a restore must move, per table, the way that table's own
 * write path does — as a raw SET expression (no bind arg).
 *
 * Only a card needs it: tasks_items.updated_at is what the board's client shows
 * (routes/bot-board-api.js's `datetime(updated_at) AS updated_at`) and what the
 * move/lane rails compare, and card-service's updateCard stamps it on every
 * changed write (`sets.push("updated_at=datetime('now')")`). A restore that left
 * it alone would change a card's content while every reader that watches the
 * timestamp still saw the old one. The other covered tables leave their clocks
 * untouched on purpose (a restore never rewinds a counter or a clock — see the
 * module comment).
 */
const RESTORE_STAMPS = Object.freeze({
  tasks_items: "updated_at = datetime('now')",
});

/**
 * The board_mutations actor for a restore's owner: the same shape the dashboard
 * writes for its own card edits (bot-board-api.js's DASHBOARD_ACTOR —
 * `{kind:'human', id:null, jobId:null}`), because a restore from the History page
 * IS an operator action there.
 */
const BOARD_MUTATION_ACTOR = Object.freeze({
  owner: "human",
  bot: "bot",
  peer: "session",
  system: "session",
});

/**
 * The columns a restore cannot write verbatim, per table: a PROJECTED column is
 * kept in the version as a projection (a bot definition's non-secret keys), so a
 * restore MERGES it into the live value instead of overwriting it — otherwise it
 * would blank every key the projection deliberately omits (the credentials).
 *
 * `merge(live, snapshot)` gets the live raw value and the stored projection (both
 * already decoded) and returns what to write. `unchanged` compares the stored
 * projection with the live value's projection, so a restore that changes nothing
 * still writes nothing.
 */
const RESTORE_PROJECTIONS = Object.freeze({
  pi_bot_defs: Object.freeze({
    definition: Object.freeze({
      merge: mergeBotDefinition,
    }),
  }),
});

/**
 * Merge one version's allow-listed definition keys into the LIVE definition.
 *
 * The live document keeps every key it already has — including the credential
 * keys (gateway tokens, env blobs) that the version never stored — and only the
 * allow-listed keys the version carries are put back. So restoring an old bot
 * definition restores its persona, tools and policy and CANNOT blank or overwrite
 * a token.
 *
 * The stored value arrives as a JSON OBJECT when SQLite kept the projection's JSON
 * subtype (the normal case, which is what makes the history view able to show it)
 * or as its JSON TEXT (a snapshot written before that). Both are accepted; nothing
 * else is.
 *
 * A NULL IN THE STORED PROJECTION MEANS "THE OLD VERSION HAD NO SUCH KEY".
 * json_object('fallback', json_extract(definition, '$.fallback')) writes null when
 * the key is absent, so a version taken before a key existed carries null for it.
 * Writing that null back would ADD a key the bot never had — a definition a reader
 * (the Bot Builder's own form, the engine) would then have to special-case — so a
 * stored null is treated as absent and the LIVE key is left exactly as it is
 * (absent stays absent). A key present with a real value is written, including an
 * empty object or array. The one consequence worth naming: a definition that
 * really did hold `"key": null` at that version restores as "leave the live key
 * alone" rather than as a null, because the two shapes are indistinguishable in a
 * projection.
 *
 * A live definition that is not a JSON object cannot be merged without dropping
 * whatever text is there, so the restore is refused (`conflict`) rather than
 * half-applied: the operator repairs the definition and restores again.
 */
function mergeBotDefinition(live, snapshot) {
  let wanted = snapshot;
  if (typeof wanted === "string") {
    try {
      wanted = wanted.trim() === "" ? null : JSON.parse(wanted);
    } catch {
      throw historyError("conflict", "the stored definition in this version cannot be read");
    }
  }
  if (!isObject(wanted)) throw historyError("conflict", "this version holds no bot definition to put back");
  let current = {};
  const raw = live === null || live === undefined ? "" : String(live);
  if (raw !== "") {
    try {
      current = JSON.parse(raw);
    } catch {
      throw historyError(
        "conflict",
        "this bot's stored definition cannot be read, so nothing can be merged into it",
      );
    }
    if (!isObject(current)) {
      throw historyError("conflict", "this bot's stored definition is not an object, so nothing can be merged into it");
    }
  }
  const merged = { ...current };
  for (const key of BOT_DEFINITION_KEYS) {
    if (!Object.prototype.hasOwnProperty.call(wanted, key)) continue;
    // See the doc comment: a stored null is the projection's "this version had no
    // such key", so the live key is left untouched (absent stays absent, and a
    // live value is never replaced by a null that only meant "unset then").
    if (wanted[key] === null || wanted[key] === undefined) continue;
    merged[key] = wanted[key];
  }
  return JSON.stringify(merged);
}

/**
 * A comparable form of one JSON-ish value: a JSON TEXT is parsed, then both sides
 * are compared as their canonical JSON. Used where the same value arrives in two
 * shapes (a SQL projection read back as text, and the same projection stored
 * inside a snapshot as a nested object).
 */
function normalizeJsonValue(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

/** Are two JSON-ish values the same document? */
function sameJson(a, b) {
  return JSON.stringify(normalizeJsonValue(a)) === JSON.stringify(normalizeJsonValue(b));
}

/**
 * The wire row for a restored memory: { id } plus the snapshotted columns the row
 * actually has — the same shape servers/memory/memory-write.js emits for an
 * ordinary insert/update. OUTBOUND_TRANSFORMS in instance-sync.js strips
 * project_id and a null project_uuid on the way out, so this row is filed on a
 * peer by its portable key, exactly as a normal memory write is.
 */
function memoryWireRow(row) {
  const out = { id: Number(row.id) };
  for (const column of COVERED.memory.snapshot) {
    if (Object.prototype.hasOwnProperty.call(row, column)) out[column] = row[column];
  }
  return out;
}

/**
 * Broadcast a restore, through the same door every ordinary write uses.
 *
 * The emit is best effort and runs AFTER the restore is committed: a sync failure
 * must never undo (or hide) a restore the operator asked for, and `emitOrQueue`
 * never throws anyway. Returns whether the row actually left this instance.
 *
 * A blog post is NOT synced (instance-sync's SYNCED_TABLES has no blog_posts), so
 * a plain local write is the whole story there and nothing is emitted; the same is
 * true of the other four types whose ordinary writes emit nothing (research
 * notes, KB articles, bot definitions and cards) — see the module header for the list.
 *
 * @returns {Promise<boolean>}
 */
async function emitRestored(db, syncManager, { spec, itemType, op, row }) {
  try {
    let wireRow;
    if (itemType === "memory") {
      wireRow = memoryWireRow(row);
    } else if (itemType === "context_section") {
      // Exactly what servers/memory/server.js does after an ordinary section
      // write: re-select the committed row (the wire row needs sort_order, which
      // is not part of the snapshot), build the allowlisted wire row and carry the
      // project's UUID (the local project id stays behind for the Lamport stamp to
      // find the row by).
      const { rows } = await db.execute({
        sql: `SELECT * FROM ${quote(spec.table)} WHERE ${quote(spec.idColumn)} = ?`,
        args: [row[spec.idColumn]],
      });
      if (!rows[0]) return false;
      const { buildCrowContextWireRow, crowContextProjectUuid } = await import(
        "../../sharing/instance-sync.js"
      );
      const uuid = await crowContextProjectUuid(db, rows[0].project_id ?? null);
      wireRow = buildCrowContextWireRow(rows[0], uuid);
    } else {
      return false;
    }
    const { emitOrQueue } = await import("../sync-emit.js");
    const emitted = await emitOrQueue(syncManager, db, spec.table, op, wireRow);
    return emitted !== null && emitted !== undefined;
  } catch (err) {
    console.warn(`[history] the restore of ${spec.table} could not be sent to peers:`, err?.message ?? err);
    return false;
  }
}

/* ------------------------------------------------------- the transaction */

/** The codes this module raises itself, so a mapped SQLite error cannot masquerade as one. */
const OWN_CODES = new Set([
  "erased",
  "invalid_context",
  "invalid_request",
  "not_found",
  "redacted",
  "conflict",
  "unsupported",
  "untrusted",
  "unavailable",
]);

/**
 * Run a restore's read → compare → write → version-id as ONE synchronous
 * transaction on the underlying handle.
 *
 * `db.runTransaction` (servers/db.js) runs the callback inside a single
 * `db.transaction(...).immediate()` — the same mechanism `batch()` gives an erase
 * (erase.js) — and hands it a synchronous statement runner. That is the contract
 * this module needs and the reason it does not use `db.execute`: a handle is ONE
 * connection, so a statement issued by another caller while a transaction is open
 * joins it rather than waiting, and anything awaited in the middle would let that
 * caller's write commit or roll back with the restore.
 *
 * A client without it refuses rather than falling back to a transaction spread
 * across awaits, which would look right and be wrong.
 */
function runOneTransaction(db, work) {
  if (!db || typeof db.runTransaction !== "function") {
    throw historyError(
      "unavailable",
      "this database client cannot run a restore as one transaction (it has no runTransaction)",
    );
  }
  return db.runTransaction(work);
}

/**
 * A UNIQUE / NOT NULL / CHECK refusal is the table telling us the row this
 * snapshot describes cannot exist beside what is there now (a slug taken by
 * another post, a section key taken at the same scope, a missing required column
 * in a hand-built snapshot). Reported as `conflict`, not as a raw SQL error.
 */
function asHistoryError(err) {
  if (err && OWN_CODES.has(err.code)) return err;
  if (/SQLITE_CONSTRAINT|UNIQUE constraint|NOT NULL constraint|CHECK constraint/i.test(String(err?.message))) {
    return historyError("conflict", err.message);
  }
  return err;
}

/**
 * Record a CARD restore the way the board records its own edits.
 *
 * card-service.js's recordMutation is the board's single provenance write (verb,
 * reporting actor, job id, and a per-field `{column: [old, new]}` diff), and every
 * card mutation since Track 1 goes through it. The History restore cannot CALL it:
 * updateCard is async and a restore is one synchronous transaction (nothing may
 * await inside it), so this writes the same row, with the same shape, by hand —
 * the INSERT statement is card-service's own.
 *
 * `actor_kind` follows board_mutations' CHECK (human | session | bot): an owner's
 * restore is `human` with a null id, exactly as the dashboard's DASHBOARD_ACTOR
 * writes it; a bot's is `bot` with its id; a peer's or a schedule's is `session`
 * (the same choice decision-service.js's expiry makes for a write no person
 * pressed). `job_id` is the History context's job (`session:<hash8>`, `card:<id>`, …).
 *
 * `detail` carries `restored_from_version` beside `fields`, and `fields` is the
 * `{column: [old, new]}` map recordMutation already stores (each entry IS the
 * [old, new] pair) — one diff vocabulary for the whole board rather than a second
 * one only restore rows would use. Nothing renders detail_json today (the board's
 * History strip shows verb, actor and time), so this is provenance for a reader to
 * come.
 *
 * A store without board_mutations (a bare tasks.db that never ran migration 0004,
 * a per-project card store) records nothing here: the restore itself still stands,
 * which is the honest direction — losing provenance beats refusing the restore.
 *
 * @returns {boolean} whether a row was written
 */
function recordCardRestore(run, { itemId, ctx, versionId, row, values, columns, changed }) {
  const boardItemId = Number(itemId);
  if (!Number.isInteger(boardItemId)) return false;
  const present = run({
    sql: "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'board_mutations' LIMIT 1",
    args: [],
  });
  if (present.rows.length === 0) return false;
  const fields = {};
  for (const column of changed) {
    fields[column] = [row[column] ?? null, values[columns.indexOf(column)] ?? null];
  }
  run({
    sql: "INSERT INTO board_mutations (item_id, verb, actor_kind, actor_id, job_id, detail_json) VALUES (?,?,?,?,?,?)",
    args: [
      boardItemId,
      "update",
      BOARD_MUTATION_ACTOR[ctx.authorKind] ?? "session",
      ctx.authorId ?? null,
      ctx.jobId ?? null,
      JSON.stringify({ restored_from_version: Number(versionId), fields }),
    ],
  });
  return true;
}

/**
 * Defang a card that is being re-created from a version: no assignee, gated, and the
 * board's first status (the project's board_defs row, else the default one, else
 * "pending"). Mutates `values` in place, aligned with `columns`. Items on a tracker
 * board (board_id set) keep their status: it is that tracker's own vocabulary.
 */
function neutraliseRestoredCard(run, columns, values) {
  const set = (name, value) => {
    const i = columns.indexOf(name);
    if (i >= 0) values[i] = value;
  };
  set("assigned_bot", null);
  set("bot_id", null);
  set("autonomy", "gated");
  const boardIdx = columns.indexOf("board_id");
  if (boardIdx >= 0 && values[boardIdx] != null) return;
  let status = "pending"; // the legacy first status, and the column default
  try {
    const projectIdx = columns.indexOf("project_id");
    const projectId = projectIdx >= 0 ? values[projectIdx] : null;
    const { rows } = run({
      sql: `SELECT status_values FROM board_defs
             WHERE project_id IS ? OR project_id IS NULL
             ORDER BY (project_id IS NULL) ASC, id ASC LIMIT 1`,
      args: [projectId ?? null],
    });
    const first = rows[0] ? JSON.parse(rows[0].status_values)[0] : null;
    if (typeof first === "string" && first !== "") status = first;
  } catch {
    /* a store without board_defs keeps the plain default */
  }
  set("status", status);
}

/** The board_mutations row for a card brought back from nothing (verb `create`). */
function recordCardReinsert(run, { itemId, ctx, versionId, values, columns }) {
  const boardItemId = Number(itemId);
  if (!Number.isInteger(boardItemId)) return false;
  const present = run({
    sql: "SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'board_mutations' LIMIT 1",
    args: [],
  });
  if (present.rows.length === 0) return false;
  const at = (name) => (columns.indexOf(name) >= 0 ? values[columns.indexOf(name)] : null);
  run({
    sql: "INSERT INTO board_mutations (item_id, verb, actor_kind, actor_id, job_id, detail_json) VALUES (?,?,?,?,?,?)",
    args: [
      boardItemId,
      "create",
      BOARD_MUTATION_ACTOR[ctx.authorKind] ?? "session",
      ctx.authorId ?? null,
      ctx.jobId ?? null,
      JSON.stringify({ restored_from_version: Number(versionId), status: at("status"), autonomy: at("autonomy") }),
    ],
  });
  return true;
}

/** The item's newest version id, when it is newer than `watermark`; else null. */
function versionIdAfter(run, watermark, itemType, itemId) {
  const { rows } = run({
    sql: "SELECT MAX(id) AS id FROM item_versions WHERE item_type = ? AND item_id = ?",
    args: [itemType, itemId],
  });
  const id = rows[0]?.id === null || rows[0]?.id === undefined ? 0 : Number(rows[0].id);
  return id > watermark ? id : null;
}

/**
 * Put one version's value back.
 *
 * The write is the ordinary INSERT / UPDATE on the covered table (inside
 * `withWriteContext(ctx)`), so the capture trigger records the restore as a new
 * version — stamped with the restorer — and every later version stays in the
 * list (review focus 3). item_versions is never written to directly.
 *
 * A REDACTED version is refused (code 'redacted'). Task 4's sweep replaces text
 * matching the public-hygiene secret patterns with "[redacted]" and sets
 * redacted = 1; such a version no longer holds the item's value, so writing it
 * back would paste the placeholder into live content and lose what is there. The
 * honest answer is "pick another version". Task 4 owns the wording a caller
 * shows for it (and what its Trash restore does when a delete version was
 * redacted).
 *
 * AN ERASED item is refused too (code 'erased', the operator's ruling of
 * 2026-11-10). An erase leaves a permanent tombstone in item_erasures — in the
 * same transaction that removed the versions — and a restore must not undo it:
 * that row exists precisely so an item the owner erased cannot come back, here
 * or (via sync) anywhere else. Normally an erased item has no versions left to
 * restore, but a version can outlive it (a filtered page, a stale reader, a
 * redaction pass) and "not found" would be the wrong answer for what was
 * deliberately forgotten.
 *
 * The refusal is VERSIONED: it applies to a version created at or before the
 * tombstone's `erased_at`, i.e. to the erased item's own values. A version
 * written after the erase is a new life of that id or name (the operator's
 * "a genuinely new item that reuses a name later is accepted") and the tombstone
 * has nothing to say about it.
 *
 * Four paths:
 *
 *   the row is live and differs     UPDATE the snapshotted columns that differ.
 *                                   The id is never in SET: an item's key is not
 *                                   content, and rewriting it would move the row
 *                                   rather than restore it. Nor is a memory's
 *                                   instance_id (a placement pointer, see
 *                                   KEEP_CURRENT): the row stays where it is now.
 *   the row is live and identical   nothing is written. `{ newVersionId: null,
 *                                   unchanged: true, synced: false }` — a restore
 *                                   of what is already there is not an edit.
 *   the row is gone                 INSERT with the SAME id, so the item comes
 *                                   back as itself: its id, and the project the
 *                                   snapshot names (resolved to a project that
 *                                   still exists — see resolveFiling). A new id
 *                                   would make a restored memory a different
 *                                   memory to every link, card and sync peer that
 *                                   held the old one. The usual way here is a
 *                                   `delete` version.
 *   the row is gone, id reused      a `delete` version whose id a row now
 *                                   occupies was not "restored" — the id belongs
 *                                   to something created since. Refused with
 *                                   code 'conflict' rather than overwriting it.
 *                                   The same goes for a live row whose CURRENT life
 *                                   began after the version being restored (a
 *                                   `delete` version newer than it): that row is a
 *                                   different item wearing the same id.
 *
 * `unchanged` is about the SNAPSHOT, not about the tracked subset: restoring a
 * version differing only in an untracked-but-snapshotted column (a blog post's
 * published_at) does write — and writes no version, because the trigger is about
 * content — so that call returns `{ newVersionId: null, unchanged: false }`. A
 * caller that needs a version id should treat null as "nothing was recorded".
 *
 * `synced` says whether the restore actually reached the sync layer (emitted to a
 * live manager, or durably queued): false for a test host, a host with sync off, a
 * blog post (not a synced table) and for a no-op. `unfiled` says the item came
 * back without its project filing: its project is gone, its id now names a
 * different project, or (a context section) the version predates the portable id.
 * A restore that succeeds partially is reported, never hidden.
 *
 * @param {object} db
 * @param {{versionId: number|string, itemType?: string, itemId?: string|number,
 *   syncManager?: object|null,
 *   artifacts?: {store?: object, blobs?: object, renderDeps?: object, db?: object}}} options
 *   `itemType` names the artifact path (`itemType: "artifact"`); an artifact
 *   version's id is the bundle's own version number, so the artifact has to be
 *   named too, and the bundle seams default to the installed bundle's own (see
 *   artifactSeams).
 * @param {{authorKind: string, authorId?: string, jobId?: string}} ctx who is restoring
 * @returns {Promise<{newVersionId: number|null, unchanged: boolean, synced: boolean,
 *   unfiled: boolean}>}
 */
export async function restoreVersion(
  db,
  { versionId, itemType = null, itemId = null, syncManager = null, artifacts = null } = {},
  ctx,
) {
  // An ARTIFACT does not restore through item_versions at all: its versions are
  // the artifacts bundle's own, and putting one back is a NEW version made by the
  // bundle's store (never a write into artifact_versions). It has its own owner
  // check and its own refusal rules — see restoreArtifactVersion.
  if (itemType === ARTIFACT_ITEM_TYPE) {
    return restoreArtifactVersion(db, { itemId, versionId, artifacts }, ctx);
  }
  if (!isObject(ctx) || !AUTHOR_KINDS.includes(ctx.authorKind)) {
    throw historyError(
      "invalid_context",
      "a restore must name who is restoring it (authorKind owner, bot, peer or system)",
    );
  }
  const id = normalizeVersionId(versionId);
  if (id === null) throw historyError("invalid_request", "restoreVersion needs a version id");

  // ONE synchronous transaction for read → compare → write → the new version id,
  // with the writer's context open so servers/db.js stamps the version the
  // trigger writes. Nothing in here may await: an await would hand the open
  // transaction to any other caller writing through this same client.
  const outcome = await withWriteContext(ctx, () =>
    runOneTransaction(db, (run) => {
      const version = readVersion(run, id);
      if (!version) throw historyError("not_found", `no version ${id}`);
      if (Number(version.redacted) === 1) {
        throw historyError(
          "redacted",
          `version ${id} was redacted and no longer holds the item's value; restore a different version`,
        );
      }
      const spec = specFor(version.item_type);
      const itemId = normalizeItemId(version.item_id);
      if (itemId === null) throw historyError("invalid_request", `version ${id} has no item id`);

      const snapshot = JSON.parse(version.snapshot_json);
      // An ERASED item is never restored (the tombstone is the operator's ruling
      // that it is gone for good) — but only while the version being restored is
      // the ERASED item's: a version created at or before `erased_at` is, and a
      // version written after the erase belongs to a new life of that id/name and
      // the tombstone has nothing to say about it (a genuinely new item that
      // reuses an id later must be restorable). Checked BEFORE anything is
      // written, and both key shapes: the section scope this snapshot describes,
      // and the row id the tombstone may have been recorded under.
      const erasedTombstone = findEraseRefusalSync(
        run,
        version.item_type,
        erasureKeys(version.item_type, { itemId, snapshot }),
        version.created_at,
      );
      if (erasedTombstone !== null) {
        throw historyError(
          "erased",
          `${version.item_type}/${itemId} was erased and cannot be restored`,
        );
      }
      // Only the columns this snapshot actually carries, and only the ones the
      // TABLE has: a version written from an older field list must not blank the
      // columns it never knew about, and a DERIVED field (a section's
      // project_uuid) is a filing, not a column to write.
      const columns = tableColumns(spec).filter(
        (column) => column !== spec.idColumn && Object.prototype.hasOwnProperty.call(snapshot, column),
      );
      const values = columns.map((column) => decodeValue(snapshot[column]));
      const row = readRow(run, spec, itemId);

      // A PROJECTED column is never written verbatim: the version holds a
      // projection of it (a bot definition's non-secret keys), so it is compared
      // by that projection and written as a MERGE into the live value — which is
      // what leaves the live credential keys alone.
      const unchangedProjections = new Set();
      const projections = RESTORE_PROJECTIONS[spec.table] || {};
      for (const column of columns) {
        if (!projections[column]) continue;
        const at = columns.indexOf(column);
        if (row) {
          const { rows: liveProjection } = run({
            sql: `SELECT ${columnValueExpr(spec, column)} AS p FROM ${quote(spec.table)} WHERE ${quote(spec.idColumn)} = ?`,
            args: [itemId],
          });
          if (sameJson(liveProjection[0]?.p ?? null, values[at])) {
            // The live row already says exactly what this version says: nothing to
            // write, and the column must not be part of the UPDATE either.
            unchangedProjections.add(column);
            continue;
          }
        }
        values[at] = projections[column].merge(row ? row[column] : null, values[at]);
      }

      // The filing is resolved against today's project table, never replayed: a
      // project's integer id can belong to a different project by now.
      const filing = resolveFiling(run, spec, snapshot, row);
      const setValue = (column, value) => {
        const at = columns.indexOf(column);
        if (at >= 0 && value !== undefined) values[at] = value;
      };
      setValue("project_id", filing.project_id);
      setValue("project_uuid", filing.project_uuid);

      // What the caller is told, once the transaction commits.
      const report = (result) => ({ ...result, unfiled: filing.unfiled, spec, itemType: version.item_type, itemId });

      if (row) {
        // A delete version's id being live again means the id was re-created since
        // the delete: not a restore, a collision between two different items.
        if (version.op === "delete") {
          throw historyError(
            "conflict",
            `${spec.table}/${itemId} exists again, so version ${id} (a deletion) cannot be restored over it`,
          );
        }
        // A delete NEWER than the version being restored says the same thing from
        // the other side: the live row was created after that deletion, so its
        // current life is not the life this version belongs to. (The conservative
        // consequence: once an item has been deleted, a version from before that
        // deletion is refused even if the item was later restored — the version
        // table cannot tell an un-delete from a stranger's re-create. Restore the
        // `delete` version itself, or a version from after the un-delete.)
        const laterDelete = deleteVersionAfter(run, version.item_type, itemId, id);
        if (laterDelete !== null) {
          throw historyError(
            "conflict",
            `${spec.table}/${itemId} was deleted again (version ${laterDelete}) after version ${id}: ` +
              `the row that exists now began a new life, so this version no longer describes it`,
          );
        }

        const keep = KEEP_CURRENT[spec.table] || [];
        const changed = columns.filter(
          (column, i) =>
            !keep.includes(column) &&
            !unchangedProjections.has(column) &&
            canonical(row[column]) !== canonical(values[i]),
        );
        if (changed.length === 0) return report({ newVersionId: null, unchanged: true, row: null, op: null });

        const watermark = maxVersionId(run);
        // The stamp is a raw SET expression (see RESTORE_STAMPS): a card's restore
        // has to move updated_at the way updateCard does, or every reader watching
        // that timestamp misses the change.
        const stamp = RESTORE_STAMPS[spec.table];
        const setClauses = [...changed.map((c) => `${quote(c)} = ?`), ...(stamp ? [stamp] : [])];
        const sql =
          `UPDATE ${quote(spec.table)} SET ${setClauses.join(", ")} ` +
          `WHERE ${quote(spec.idColumn)} = ?`;
        const args = [...changed.map((column) => values[columns.indexOf(column)]), itemId];
        const written = run({ sql, args });
        // The row was read inside this transaction, so nothing could have removed
        // it — but a restore that updates nothing must never look like success.
        if (Number(written.rowsAffected || 0) === 0) {
          throw historyError("conflict", `${spec.table}/${itemId} disappeared while version ${id} was being restored`);
        }
        // A CARD's restore is a card change, so it is recorded on the board exactly
        // as an ordinary edit is (one board_mutations row, in this same transaction).
        // A card re-created from nothing (the INSERT path below) records a `create`
        // row of its own, and comes back defanged.
        if (spec.table === "tasks_items") {
          recordCardRestore(run, { itemId, ctx, versionId: id, row, values, columns, changed });
        }
        const newVersionId = versionIdAfter(run, watermark, version.item_type, itemId);
        return report({ newVersionId, unchanged: false, row: readRow(run, spec, itemId), op: "update" });
      }

      // The row is gone: put it back as itself, id and filing included.
      // A CARD, though, comes back DEFANGED (the operator's ruling, same spirit as the
      // content-only UPDATE restore): its title, body and plan fields return, but it
      // is unassigned, gated and on the board's first status, so bringing a card back
      // can never start a bot on its own (an `auto` card for a bot, deleted by a job
      // undo, would otherwise be re-dispatched).
      if (spec.table === "tasks_items") neutraliseRestoredCard(run, columns, values);
      const insertColumns = [spec.idColumn, ...columns];
      const watermark = maxVersionId(run);
      const sql =
        `INSERT INTO ${quote(spec.table)} (${insertColumns.map(quote).join(", ")}) ` +
        `VALUES (${insertColumns.map(() => "?").join(", ")})`;
      run({ sql, args: [itemId, ...values] });
      // Recorded on the board like any other card change (one board_mutations row, in
      // this same transaction). NOT done here: the widgets "what needs me" push that
      // recordMutation fires. It lives in a gateway module, and importing gateway
      // wiring into shared history code would drag it into every importer; the
      // widgets pick the card up on their next refresh.
      if (spec.table === "tasks_items") {
        recordCardReinsert(run, { itemId, ctx, versionId: id, values, columns });
      }
      const newVersionId = versionIdAfter(run, watermark, version.item_type, itemId);
      return report({ newVersionId, unchanged: false, row: readRow(run, spec, itemId), op: "insert" });
    }).catch((err) => {
      throw asHistoryError(err);
    }),
  );

  // The write is committed and cannot be taken back by a sync problem, so the
  // emit is last and best effort. A no-op restore has nothing to send.
  const synced =
    outcome.unchanged || !outcome.row
      ? false
      : await emitRestored(db, syncManager, {
          spec: outcome.spec,
          itemType: outcome.itemType,
          op: outcome.op,
          row: outcome.row,
        });

  return { newVersionId: outcome.newVersionId, unchanged: outcome.unchanged, synced, unfiled: outcome.unfiled };
}