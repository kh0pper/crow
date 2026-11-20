/**
 * The artifact bridge: a report run writes its document as an artifact version, as the OWNER.
 *
 * WHY A REPORT IS AN ARTIFACT: the report page, the recipient view and a comment thread all render one
 * artifact version, so a report gets versions, anchors, comments and retention for free. What a report
 * must NOT get is a bot identity: a report's bot wrote the recipe, not the document, so the bridge writes
 * as `{kind:"session"}` (the owner). `created_by_bot` therefore stays NULL and no `artifact_bot_access`
 * row is written, which means `store.canAccess` refuses the report's own bot (`store.js`: a bot sees what
 * it created or was granted, and `received` fails closed). The pickup turn reads the owner's comments
 * through its own MCP door, never through the artifact tools.
 *
 * THE RUN-TO-VERSION MAP: every version this module writes gets one `report_versions` row, in the SAME
 * batch as the version (the artifacts store's `addVersion` `extraStatements` seam). It cannot be written
 * from outside that batch: `withWriteLock` is a non-reentrant promise chain that `addVersion` already
 * takes, and writing after it returns leaves a window where a crash orphans the version. The row also
 * lets the dashboard say "Report run" for that version instead of "you" (see `isReportVersion`).
 *
 * ATTRIBUTION: `made_by` is left alone, so the artifact store resolves it to `'user'` for a session
 * actor, which every live CHECK already allows. Nothing here passes `madeBy`.
 *
 * RETENTION: a version that was sent to anyone is held (the artifacts store's `artifact_version_holds`),
 * so retention never deletes something a link in an old mail still points at. Before writing, the bridge
 * checks real storage usage (`instanceUsage`) against `LIMITS.instanceBytes`: at or above 90% the run
 * fails honestly with one sentence the owner can act on, instead of pruning past a hold. Nothing here
 * prunes or releases anything; PR 5/6a own the holds.
 *
 * THE LIVE SET: the artifact id is part of the go-live seal, so a live report's artifact id can never be
 * filled in silently by a run. `ensureReportArtifact` refuses that case with `artifact_unsealed` rather
 * than changing what the owner approved, and `makeWriteVersion` takes the artifact id from the VERIFIED
 * live set (`live.artifactId`), never from a fresh read of the row. The one trigger that never takes
 * that path is a preview, which is not an approved run (see PREVIEWS NEVER TOUCH THE SEAL).
 *
 * THE BUNDLE IS LOADED LAZILY: Crow Artifacts is a bundle installed at runtime, so its modules are
 * imported by PATH from the installed copy (the mcp-mounts precedent) and the runtime is cached per
 * process. `deps.artifacts` lets a test inject the same shape. A gateway with no artifacts bundle fails
 * a run honestly with `artifacts_missing` (the API maps it to 409 with `install: "artifacts"`) instead of
 * failing boot. An installed copy OLDER than this module is the other honest failure: a bundle whose
 * store has no `holdVersion`, or whose `addVersion` ignores `extraStatements`, cannot keep the run to
 * version map, so the write is refused up front (`artifacts_outdated`) or, when the version was written
 * but unmapped, reported as `artifacts_outdated` instead of pretending the run was recorded.
 *
 * PREVIEWS NEVER TOUCH THE SEAL: a preview is unapproved text, and a recipient never sees one. Once a
 * report carries a go-live seal (`live_rev` is non-null: live, or paused with the seal kept), a preview
 * writes into its OWN artifact (`<title> (preview)`, owner session actor, untrusted, no bot access),
 * named in `report_state` under `preview_artifact_id` and reused after that. The primary artifact's
 * `current_version` therefore stays on the last approved state, and `preview_into_live` is the backstop
 * that refuses a preview aimed at the sealed artifact itself. A report that was never live has no
 * seal and no recipients, so its preview keeps writing into the primary artifact, which is the one
 * go-live will seal.
 *
 * THE STORED PREVIEW ID IS NOT TRUSTED: `report_state` is a shared key/value store, and a recipe block's
 * `setState` (a bot-authored recipe) can write any key in it, `preview_artifact_id` included. A stored id
 * is therefore reused only after `reusableStoredPreview` clears every check (an owner-made, undeleted
 * artifact that no report claims as its primary one, titled as a preview, whose versions are all preview
 * runs of THIS report); anything else is ignored and replaced with a fresh artifact. The key is also
 * reserved (`RESERVED_STATE_KEYS`): a block's `setState` must refuse it, so the value the bridge reads is
 * one the bridge wrote.
 *
 * A PREVIEW RE-READS THE REPORT: the engine reads the report row once at run start, so a preview that
 * started before go-live would otherwise be aimed at the artifact the seal now covers. `writeRunVersion`
 * reads the row again for a preview and applies the seal decision (and the `preview_into_live` backstop)
 * to what it finds. A non-preview run keeps the row it was handed: the artifact it writes is the one the
 * verified live set names, never a fresh read.
 *
 * RECIPIENT RENDERS PIN A VERSION: `latestRecipientVersion` / `isRecipientSafeVersion` are the reads a
 * recipient-facing or default render has to use, never the artifact's `current_version`.
 *
 * PRIVACY: every version is written `untrusted: true`, because a report body carries text a source
 * wrote. Serving a preview outside the owner's dashboard is PR 5/6a's rule, not this module's; what this
 * module guarantees is that a preview is not sitting in the artifact a recipient is shown.
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { createDbClient, resolveDataDir } from "../../db.js";
import { resolveCrowHome } from "../../shared/crow-home.js";
import { REPORT_LIVE } from "./approvals.js";
import { getReport, getState, setState, updateReportColumns } from "./store.js";

/** The trigger words a run row may carry (the run engine's own closed set). */
const RUN_TRIGGERS = Object.freeze(["schedule", "manual", "preview"]);

/** How many allowed links one version may record. */
export const MAX_ALLOWED_LINKS = 2000;

/** The longest URL one version may record. A link longer than this is dropped rather than stored: the
 *  recorded set exists so a recipient render can decide what becomes clickable, and no real link needs
 *  the room. Nothing counts the drops. */
export const MAX_ALLOWED_LINK_CHARS = 2048;

/** The sentence a run is failed with when artifact storage is at or above 90% of its cap. */
export const STORAGE_NEARLY_FULL_TEXT =
  "Report storage is nearly full. Older report links will expire sooner.";

/** The sentence a run is failed with when the installed artifacts bundle is older than this module. */
export const ARTIFACTS_OUTDATED_TEXT =
  "The artifacts add-on needs to be updated before reports can run.";

/** The `report_state` key a report's own preview artifact id lives under. */
export const PREVIEW_ARTIFACT_STATE_KEY = "preview_artifact_id";

/**
 * The `report_state` keys the bridge owns and writes itself.
 *
 * A recipe block's `setState` (a bot-authored recipe) MUST refuse every key in this list: the bridge
 * trusts what it finds under them to decide where a run writes, so a bot must not be able to name it.
 * The block write path arriving in PR 4 reads this list; a new bridge key is added here, once.
 */
export const RESERVED_STATE_KEYS = Object.freeze([PREVIEW_ARTIFACT_STATE_KEY]);

/**
 * Is this `report_state` key one the bridge owns?
 *
 * A block's `setState` must refuse a key this answers true for; nothing else may write it.
 *
 * @param {*} key
 * @returns {boolean}
 */
export function isReservedStateKey(key) {
  return typeof key === "string" && RESERVED_STATE_KEYS.includes(key);
}

/** The suffix that makes a preview artifact recognisable in the artifacts list. */
const PREVIEW_TITLE_SUFFIX = " (preview)";

/** The fraction of `LIMITS.instanceBytes` above which the bridge refuses to write a version. */
const STORAGE_LIMIT_FRACTION = 0.9;

function fail(code, message) {
  const err = new Error(message || code);
  err.code = code;
  return err;
}

function text(value) {
  if (value == null) return "";
  return typeof value === "string" ? value : String(value);
}

/** Epoch ms from the injected clock (`deps.now`), so a test's fake clock moves the row's time too. */
function clockOf(deps) {
  const value = Number(deps == null || deps.now == null ? NaN : deps.now());
  return Number.isFinite(value) ? value : Date.now();
}

/** A report's title as a one-line label: never empty, so an artifact always has one. */
function titleOf(report) {
  const flat = text(report?.title).replace(/\s+/g, " ").trim();
  return flat || "Report";
}

/**
 * The preview artifact's title: the report's own title plus ` (preview)`, so a preview is never mistaken
 * for the report in the artifacts list. A title that already ends that way is left alone.
 */
function previewTitleOf(report) {
  const title = titleOf(report);
  return title.endsWith(PREVIEW_TITLE_SUFFIX) ? title : title + PREVIEW_TITLE_SUFFIX;
}

/**
 * Does this report carry a go-live seal? `live_rev` is set by go-live and is kept through a pause (the
 * seal stays so a resume can prove nothing moved), and it is null on a report nobody ever took live.
 * A value the module cannot read as a revision still counts as a seal: the preview is routed away from
 * the primary artifact, which is the safe side to be wrong on.
 */
function hasSeal(report) {
  const rev = report == null ? null : report.live_rev;
  if (rev == null) return false;
  return !(typeof rev === "string" && rev.trim() === "");
}

/* ---------------------------------------------------------------- the bundle runtime */

/** The runtime this process loaded from the installed bundle, or null. */
let cachedRuntime = null;

/**
 * The artifacts runtime the bridge writes through.
 *
 * `deps.artifacts` (a test, or a caller that already mounted the bundle) wins and is used as given. Else
 * the bundle's own modules are imported by PATH from the installed copy, exactly as the artifacts mount
 * does, and the result is cached for the life of the process: the blob store is a per-process backend
 * decision (the bundle pins it in `artifact_store_meta`), so a second instance would only re-resolve it.
 *
 * A bundle that is not installed throws `code: "artifacts_missing"` and nothing is cached: a later run
 * after the owner installs the bundle must be able to succeed in the same process.
 *
 * @param {{artifacts?: object, db?: object}} [deps]
 * @returns {Promise<{store: object, initArtifactsTables: Function, blobs: object,
 *   markdownBlocks: Function, limits: object}>}
 * @throws {Error} `artifacts_missing` when the installed bundle has no `store.js`
 */
export async function loadArtifactsRuntime(deps = {}) {
  const injected = deps == null ? null : deps.artifacts;
  if (injected) return injected;
  if (cachedRuntime) return cachedRuntime;
  const dir = join(resolveCrowHome(), "bundles", "artifacts", "server");
  if (!existsSync(join(dir, "store.js"))) {
    throw fail("artifacts_missing", "The Artifacts bundle is not installed.");
  }
  const imp = (f) => import(pathToFileURL(join(dir, f)).href);
  const [{ initArtifactsTables }, { createBlobStore }, store, limits, { markdownBlocks }] =
    await Promise.all([
      imp("init-tables.js"), imp("blob-store-minio.js"), imp("store.js"), imp("limits.js"),
      import("../../blog/renderer.js"),
    ]);
  // The bundle's tables are created by its mount, but reports may run before (or without) that mount
  // having touched this database, and the blob store refuses to resolve a kind without a store_id.
  const client = (deps && deps.db) || createDbClient();
  await initArtifactsTables(client);
  const blobs = await createBlobStore(client, resolveDataDir());
  cachedRuntime = { store, initArtifactsTables, blobs, markdownBlocks, limits: limits.LIMITS };
  return cachedRuntime;
}

/** Test seam: forget the runtime this process cached. */
export function _resetArtifactsRuntimeForTest() {
  cachedRuntime = null;
}

/* --------------------------------------------------------------- the report's artifact */

/**
 * The artifact a report renders into, created once.
 *
 * The stored id is reused whenever the artifact still exists. A live report is the case that must not
 * move silently: its `artifact_id` is part of the go-live seal (`approvals.js`), so a live report with
 * no artifact id - or one whose artifact is gone - throws `code: "artifact_unsealed"` instead of
 * exchanging the approved artifact for a new one. Go live again to approve a different artifact.
 *
 * @param {object} db the run's libsql-shaped client
 * @param {object} deps
 * @param {object} report a report row (the caller may pin `artifact_id` from the verified live set)
 * @returns {Promise<string>} the artifact id
 * @throws {Error} `artifacts_missing`, `artifact_unsealed`, or whatever the artifact store refuses
 */
export async function ensureReportArtifact(db, deps, report) {
  if (!report || typeof report !== "object") throw fail("bad_input", "report");
  const rt = await loadArtifactsRuntime(deps);
  const stored = text(report.artifact_id).trim();
  if (stored) {
    const art = await rt.store.getArtifact(db, stored);
    if (art) return art.id;
    if (report.status === REPORT_LIVE) {
      throw fail("artifact_unsealed", "This report was approved with an artifact that is gone. Go live again.");
    }
  } else if (report.status === REPORT_LIVE) {
    throw fail("artifact_unsealed", "This report is live without an artifact. Go live again.");
  }
  const title = titleOf(report);
  const { id } = await rt.store.createArtifact(db, rt.blobs, {
    title,
    type: "document",
    source: { markdown: `# ${title}\n\nNo run yet.`, title },
    actor: { kind: "session" },
    untrusted: true,
  }, { markdownBlocks: rt.markdownBlocks });
  // The report points at the artifact from now on. On a draft or paused report that is a settings write
  // the owner has not sealed yet; the live case was refused above.
  await updateReportColumns(db, report.id, { artifact_id: id });
  return id;
}

/**
 * May a stored preview artifact id be reused?
 *
 * `report_state` is shared with recipe blocks (a bot-authored recipe can write it through a block's
 * `setState`), so an id found under `preview_artifact_id` is UNTRUSTED input. Writing a preview into the
 * wrong artifact is the one thing that would show unapproved text where an approved version is rendered,
 * so every check below has to pass, and a single failure means the id is ignored:
 *
 *   1. it names an artifact that exists, is not deleted, and was not created by a bot
 *      (`created_by_bot IS NULL`: the owner's session made it, so the report's bot neither made it nor
 *      can reach it);
 *   2. no report claims it as its primary artifact (`reports.artifact_id`), so it can never be an
 *      artifact a go-live seal or a recipient render covers;
 *   3. every `report_versions` row for it names THIS report and the `preview` trigger;
 *   4. its versions are only its seed version 1 plus versions that have such a `report_versions` row, so
 *      a version someone added by hand (or for another purpose) makes the artifact unusable as a preview;
 *   5. its title ends with ` (preview)`, the shape `previewTitleOf` gives it.
 *
 * @param {object} db
 * @param {object} rt the artifacts runtime
 * @param {object} report the report the preview is for
 * @param {string} artifactId the stored id
 * @returns {Promise<boolean>} true only when the id may be written to
 */
async function reusableStoredPreview(db, rt, report, artifactId) {
  const art = await rt.store.getArtifact(db, artifactId);
  if (!art) return false;
  if (art.created_by_bot != null) return false;
  const claimed = await db.execute({
    sql: "SELECT 1 FROM reports WHERE artifact_id = ? LIMIT 1",
    args: [artifactId],
  });
  if (claimed.rows.length) return false;
  if (!text(art.title).trimEnd().endsWith(PREVIEW_TITLE_SUFFIX)) return false;
  const mapped = await db.execute({
    sql: `SELECT COUNT(*) AS total,
                 SUM(CASE WHEN report_id = ? AND "trigger" = 'preview' THEN 1 ELSE 0 END) AS ours
            FROM report_versions WHERE artifact_id = ?`,
    args: [report.id, artifactId],
  });
  const total = Number(mapped.rows[0]?.total ?? 0);
  const ours = Number(mapped.rows[0]?.ours ?? 0);
  if (total !== ours) return false;
  const strays = await db.execute({
    sql: `SELECT COUNT(*) AS n FROM artifact_versions av
           WHERE av.artifact_id = ? AND av.n > 1
             AND NOT EXISTS (SELECT 1 FROM report_versions rv
                              WHERE rv.artifact_id = av.artifact_id AND rv.n = av.n)`,
    args: [artifactId],
  });
  return Number(strays.rows[0]?.n ?? 0) === 0;
}

/**
 * The artifact a SEALED report's previews render into, created once and reused after that.
 *
 * A preview is unapproved text written before the owner looks at it, so it must not be a version of the
 * artifact the go-live seal covers: `addVersion` moves `current_version`, and anything that renders the
 * sealed artifact from its current version would then show the preview. This artifact is a plain
 * `document`, owned by the owner's session (so `created_by_bot` stays NULL and the report's bot has no
 * access), marked untrusted because a report body carries text a source wrote, and titled
 * `<report title> (preview)` so it is recognisable in the artifacts list.
 *
 * The id lives in `report_state` under `preview_artifact_id` as `{artifactId}`, and that value is NOT
 * trusted: any writer of `report_state` (a recipe block's `setState`, a stale or hand-edited row) can put
 * anything there. A stored id is reused only when `reusableStoredPreview` clears every one of its checks;
 * a failed check means the stored id is ignored, a fresh preview artifact is made and the key is
 * overwritten.
 *
 * @param {object} db
 * @param {object} deps
 * @param {object} report a report row
 * @returns {Promise<string>} the preview artifact id
 */
async function ensurePreviewArtifact(db, deps, report) {
  const rt = await loadArtifactsRuntime(deps);
  const state = await getState(db, report.id, PREVIEW_ARTIFACT_STATE_KEY);
  const stored = text(state == null ? "" : state.artifactId).trim();
  if (stored && (await reusableStoredPreview(db, rt, report, stored))) return stored;
  const title = previewTitleOf(report);
  const { id } = await rt.store.createArtifact(db, rt.blobs, {
    title,
    type: "document",
    source: { markdown: `# ${title}\n\nNo preview yet.`, title },
    actor: { kind: "session" },
    untrusted: true,
  }, { markdownBlocks: rt.markdownBlocks });
  await setState(db, report.id, PREVIEW_ARTIFACT_STATE_KEY, { artifactId: id });
  return id;
}

/* --------------------------------------------------------------------- the run's version */

/** The run's own day, as the change note spells it (UTC, so the note never depends on the host zone). */
function runDay(run) {
  const at = Number(run?.startedAt ?? run?.createdAt);
  const ms = Number.isFinite(at) ? at : Date.now();
  return new Date(ms).toISOString().slice(0, 10);
}

/** `Run <date>`, plus ` (late)` and ` (preview)` the way the run itself knows them. */
function changeNoteFor(run) {
  let note = `Run ${runDay(run)}`;
  if (run?.late === true || Number(run?.late) === 1) note += " (late)";
  if (run?.trigger === "preview") note += " (preview)";
  return note;
}

/**
 * The links a version may show: http(s) only, de-duplicated, capped.
 *
 * This is the recorded copy of the run's link set, so the recipient view can decide which links become
 * clickable without trusting the rendered document. Anything that is not an http or https URL, anything
 * that is not a string, and any URL longer than `MAX_ALLOWED_LINK_CHARS` is dropped rather than repaired
 * (and dropped silently: nothing counts or reports the ones left out).
 *
 * @param {*} links
 * @returns {string[]}
 */
export function normalizeAllowedLinks(links) {
  const out = [];
  if (!Array.isArray(links)) return out;
  const seen = new Set();
  for (const raw of links) {
    if (typeof raw !== "string") continue;
    if (raw.length > MAX_ALLOWED_LINK_CHARS) continue;
    let url;
    try {
      url = new URL(raw);
    } catch {
      continue;
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") continue;
    if (seen.has(raw)) continue;
    seen.add(raw);
    out.push(raw);
    if (out.length >= MAX_ALLOWED_LINKS) break;
  }
  return out;
}

/**
 * Write one artifact version for one run, as the owner, and record the run-to-version row with it.
 *
 * The storage check runs FIRST and writes nothing when it refuses: the run is failed with
 * `storage_nearly_full` and the owner's sentence, and no version, no artifact and no report row moves.
 * The cap is the runtime's own `limits` (the installed bundle's `limits.js`), the same numbers the store
 * enforces; a hand-built runtime that carries none skips the pre-check and only the store's own quota
 * applies.
 *
 * WHERE A PREVIEW WRITES: a preview of a report that carries a seal goes to the report's own preview
 * artifact (`ensurePreviewArtifact`), so the sealed artifact's `current_version` never moves for a run
 * the owner has not approved and no recipient has received. A preview of a report that was never live
 * keeps writing into the primary artifact, which is the one go-live will seal. The `preview_into_live`
 * backstop refuses a preview whose target is the sealed artifact itself and writes nothing.
 *
 * WHICH DECISION IS TAKEN: for a preview, the report row is read AGAIN here, just before the target is
 * chosen, because the run engine read the row once at run start. A preview that started before go-live
 * would otherwise be aimed at the artifact the seal now covers; the seal, the primary artifact id and the
 * backstop are all applied to the fresh row instead. A non-preview run keeps the row it was handed: its
 * artifact is the one the verified live set names (`makeWriteVersion`), never a fresh read of the row.
 *
 * AN OLD BUNDLE IS AN HONEST FAILURE: the run to version map rides `addVersion`'s `extraStatements`
 * batch, and that seam arrives with `holdVersion` in the same store release. A store without
 * `holdVersion` is refused before anything is written (`artifacts_outdated`), and a write whose map row
 * did not appear afterwards is reported as `artifacts_outdated` too: the version exists but no run
 * claims it, which a reader must be told rather than be shown a run with an unrecorded version.
 *
 * @param {object} db
 * @param {object} deps
 * @param {{report: object, run: object, source: object, allowedLinks?: string[]}} input
 * @returns {Promise<number>} the version number
 * @throws {Error} `artifacts_missing`, `artifacts_outdated`, `artifact_unsealed`, `preview_into_live`,
 *   `storage_nearly_full`, `bad_input`
 */
export async function writeRunVersion(db, deps, { report, run, source, allowedLinks = [] } = {}) {
  if (!report || typeof report !== "object" || !report.id) throw fail("bad_input", "report");
  if (!run || typeof run !== "object" || !run.id) throw fail("bad_input", "run");
  const trigger = text(run.trigger);
  if (!RUN_TRIGGERS.includes(trigger)) throw fail("bad_input", "trigger");
  const rt = await loadArtifactsRuntime(deps);
  // The seam this module needs: a version and the report_versions row that names its run go in ONE
  // batch, and that batch seam and `holdVersion` ship together. Runs before anything is written, so an
  // outdated installed bundle cannot leave a version (or an artifact) behind.
  if (typeof rt.store?.holdVersion !== "function") {
    throw fail("artifacts_outdated", ARTIFACTS_OUTDATED_TEXT);
  }

  const cap = Number(rt.limits?.instanceBytes);
  if (Number.isFinite(cap) && cap > 0) {
    const used = Number(await rt.store.instanceUsage(db, rt.blobs));
    if (used >= cap * STORAGE_LIMIT_FRACTION) {
      throw fail("storage_nearly_full", STORAGE_NEARLY_FULL_TEXT);
    }
  }

  // The seal that decides where a preview writes is read from the ROW, not from the caller's snapshot
  // (the engine read it at run start, and a report can go live between then and now). A non-preview run
  // keeps its row: its artifact comes from the verified live set, never from a fresh read.
  const target = trigger === "preview" ? ((await getReport(db, report.id)) ?? report) : report;
  const sealed = hasSeal(target);
  const artifactId = trigger === "preview" && sealed
    ? await ensurePreviewArtifact(db, deps, target)
    : await ensureReportArtifact(db, deps, target);
  // The backstop: a preview is never a version of the sealed artifact, whatever named that target.
  if (trigger === "preview" && sealed && artifactId === text(target.artifact_id).trim()) {
    throw fail("preview_into_live", "A preview never writes into the report's sealed artifact.");
  }
  const links = normalizeAllowedLinks(allowedLinks);
  const written = await rt.store.addVersion(db, rt.blobs, {
    artifactId,
    source,
    actor: { kind: "session" },
    untrusted: true,
    changeNote: changeNoteFor(run),
    extraStatements: (n) => [{
      sql: `INSERT INTO report_versions
              (artifact_id, n, report_id, run_id, "trigger", allowed_links_json, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?)`,
      args: [artifactId, n, report.id, run.id, trigger, JSON.stringify(links), clockOf(deps)],
    }],
  }, { markdownBlocks: rt.markdownBlocks });
  const n = Number(written.n);
  // The map row is written by the batch; a store that ignored `extraStatements` wrote the version
  // without it, and a run whose version no row claims is reported instead of silently recorded.
  if (!(await reportVersionFor(db, artifactId, n))) {
    throw fail("artifacts_outdated", ARTIFACTS_OUTDATED_TEXT);
  }
  return n;
}

/* ------------------------------------------------------------------------ the seam */

/** The document a run's result carries: `{markdown, title}`, a markdown string, or nothing. */
function sourceFromResult(report, result) {
  const fallbackTitle = titleOf(report);
  const doc = result == null ? null : result.document;
  const titleOfDoc = (value) => text(value).replace(/\s+/g, " ").trim();
  if (typeof doc === "string" && doc.trim()) return { markdown: doc, title: fallbackTitle };
  if (doc && typeof doc === "object" && typeof doc.markdown === "string" && doc.markdown.trim()) {
    return { markdown: doc.markdown, title: titleOfDoc(doc.title) || fallbackTitle };
  }
  return { markdown: `# ${fallbackTitle}\n\nNo new items this run.`, title: fallbackTitle };
}

/**
 * The `writeVersion` seam the run engine takes (`servers/gateway/reports/run.js` step 5).
 *
 * It answers `{artifactVersion: n}`, which the run row stores, and it takes the artifact from the
 * VERIFIED live set when there is one: a scheduled or manual run executes what the owner approved, so its
 * version belongs to the approved artifact. A live set with no artifact id is `artifact_unsealed`, never
 * a fresh artifact. A PREVIEW never takes the live set's artifact, even when a caller hands one in: the
 * bridge routes it to the report's preview artifact (`ensurePreviewArtifact`), and the row's own
 * primary artifact when nothing is sealed.
 *
 * @param {object} [deps] the bridge deps (`artifacts` in a test, `db` for the loader's own client)
 * @returns {Function} `(db, {report, run, live, result}) => Promise<{artifactVersion: number}>`
 */
export function makeWriteVersion(deps = {}) {
  return async function writeVersion(db, { report, run, live, result } = {}) {
    const preview = text(run == null ? "" : run.trigger) === "preview";
    let target = report;
    if (live && !preview) {
      const liveArtifactId = text(live.artifactId).trim();
      if (!liveArtifactId) {
        throw fail("artifact_unsealed", "This report is live without an artifact. Go live again.");
      }
      target = { ...report, artifact_id: liveArtifactId };
    }
    const n = await writeRunVersion(db, deps, {
      report: target,
      run,
      source: sourceFromResult(report, result),
      allowedLinks: result == null ? [] : result.allowedLinks,
    });
    return { artifactVersion: n };
  };
}

/* -------------------------------------------------------------------- attribution reads */

/**
 * The `report_versions` row for one artifact version, or null when the owner made that version.
 *
 * The dashboard and the report page show "Report run" for a version this answers for, never "you".
 *
 * @param {object} db
 * @param {string} artifactId
 * @param {number} n
 * @returns {Promise<object|null>}
 */
export async function reportVersionFor(db, artifactId, n) {
  if (typeof artifactId !== "string" || !artifactId) return null;
  const version = Number(n);
  if (!Number.isInteger(version)) return null;
  const { rows } = await db.execute({
    sql: `SELECT artifact_id, n, report_id, run_id, "trigger", allowed_links_json, created_at
            FROM report_versions WHERE artifact_id = ? AND n = ?`,
    args: [artifactId, version],
  });
  return rows[0] ?? null;
}

/**
 * Whether a version was written by a report run.
 *
 * A read that fails answers false: attribution falls back to the artifact store's own answer, and a
 * caller rendering a page is never taken down by this lookup.
 *
 * @param {object} db
 * @param {string} artifactId
 * @param {number} n
 * @returns {Promise<boolean>}
 */
export async function isReportVersion(db, artifactId, n) {
  try {
    return (await reportVersionFor(db, artifactId, n)) !== null;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------ recipient version pinning */

/**
 * The newest version of a report artifact that a recipient may be shown, or null.
 *
 * It is the highest `report_versions` row for the artifact whose trigger is not `preview` AND whose
 * version still exists in `artifact_versions`: a preview must never be handed to a recipient, and a real
 * run whose version retention has since pruned is skipped rather than named.
 *
 * THE PINNING RULE: every recipient-facing or default render of a report artifact (PR 5/6a: the
 * recipient view, the daily link, a link in a mail) MUST pin `latestRecipientVersion` or the exact
 * version that was sent, and NEVER the artifact's `current_version`. On a report that was live before a
 * preview ran, the primary artifact can hold a draft-time preview at current (a preview written before
 * the report was ever sealed), and `current_version` is also not a promise: retention, a proposed
 * version or an owner edit can move it. A read that fails throws rather than answering null-as-current;
 * a caller with nothing to pin shows no report instead of guessing.
 *
 * @param {object} db
 * @param {string} artifactId
 * @returns {Promise<number|null>}
 */
export async function latestRecipientVersion(db, artifactId) {
  if (typeof artifactId !== "string" || !artifactId) return null;
  const { rows } = await db.execute({
    sql: `SELECT MAX(rv.n) AS n
            FROM report_versions rv
            JOIN artifact_versions av ON av.artifact_id = rv.artifact_id AND av.n = rv.n
           WHERE rv.artifact_id = ? AND rv."trigger" <> 'preview'`,
    args: [artifactId],
  });
  const n = rows[0] == null ? null : rows[0].n;
  return n == null ? null : Number(n);
}

/**
 * May a recipient be shown this version of this report artifact?
 *
 * True only for a version a report run wrote under a trigger that is not `preview`. A version the owner
 * made, a version with no `report_versions` row, and a preview all answer false: the first two were
 * never run content a report sent, and a preview was never sent at all. The pinning rule in
 * `latestRecipientVersion` says which version to render; this is the check that the version a caller
 * already holds is one a recipient may see.
 *
 * @param {object} db
 * @param {string} artifactId
 * @param {number} n
 * @returns {Promise<boolean>}
 */
export async function isRecipientSafeVersion(db, artifactId, n) {
  const mapped = await reportVersionFor(db, artifactId, n);
  if (!mapped) return false;
  return text(mapped.trigger) !== "preview";
}