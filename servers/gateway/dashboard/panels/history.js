/**
 * History — the Crow's Nest panel behind `/dashboard/history/*` (the version
 * history design §3; implementation plan Task 5).
 *
 * Three pages, all of them the owner's own:
 *
 *   /dashboard/history/:itemType/:itemId   one item's versions, newest first,
 *                                          with what each one changed and a
 *                                          Restore button per version;
 *   /dashboard/history/jobs                recent jobs, each with its items and
 *                                          Undo this job;
 *   /dashboard/history/trash                deleted items, Restore per item, and
 *                                          Empty Trash behind an in-page confirm.
 *
 * RAILS, all four load-bearing:
 *
 *   1. OWNER ONLY, GET AND POST. `isLocalPasswordSessionOn` is the one owner
 *      rule (the same check the phone's call approvals and the staged-draft page
 *      use): a local password sign-in on this instance, from a client that is not
 *      this machine. A session a paired peer minted through SSO, a session minted
 *      by a login ON this machine, and a signed peer call are all refused — even
 *      for a GET, because an item's history IS its content (a memory's old text,
 *      a draft post's first paragraph). The refusal page carries no row data at
 *      all: the check runs before anything is read.
 *
 *   2. EVERY MUTATION IS A POST, CSRF-CHECKED. The pages are plain forms with the
 *      `_csrf` field; the gateway's csrfMiddleware (mounted on /dashboard, ahead
 *      of this panel's routes) validates it, exactly as it does for every other
 *      dashboard form. There is no fetch/JSON path here to bypass it.
 *
 *   3. EVERY MUTATION RUNS IN THE OWNER'S WRITE CONTEXT, so the version it writes
 *      is stamped with the owner (author_kind owner, the session hash as the
 *      author, `session:<hash8>` as the job) and shows up in History as "You"
 *      rather than "Unattributed". owners only reach this code, so the context is
 *      always the owner's; a request without one is refused, never run unstamped.
 *
 *   4. A POST ANSWERS WITH THE PAGE, NOT A REDIRECT WITH THE ANSWER IN THE URL. An
 *      undo's result is a LIST (what was put back, what was skipped and why) and
 *      a Trash item's id has no business in a URL bar; so the handler renders the
 *      same page with the result at the top. Re-submitting is harmless: a restore
 *      of what is already there is reported as "nothing to restore" and writes
 *      nothing (api.js's unchanged path).
 *
 * NOTHING HERE RE-IMPLEMENTS HISTORY. The reads are the panel's data queries; the
 * writes are servers/shared/history/{api,jobs,trash}.js — the same functions the
 * MCP tools and the sweep use. The UI is a face on them, not a second engine.
 */
import { SUPPORTED_LANGS, fill, t } from "../shared/i18n.js";
import { COVERED } from "../../../shared/history/covered.js";
import { listVersions, restoreVersion } from "../../../shared/history/api.js";
import { undoJob } from "../../../shared/history/jobs.js";
import { emptyTrash, listTrash, normalizeTrashDays, restoreFromTrash, DEFAULT_TRASH_DAYS } from "../../../shared/history/trash.js";
import { withWriteContext } from "../../../shared/history/write-context.js";
import { isLocalPasswordSessionOn } from "../local-session.js";
import { ownerRequestWriteContext } from "../auth.js";
import { readSetting } from "../settings/registry.js";
import { getInstanceSyncManager } from "../../../sharing/server.js";
import {
  JOBS_PATH,
  TRASH_PATH,
  renderHistoryIndex,
  renderItemPage,
  renderJobsPage,
  renderNotFound,
  renderRefusal,
  renderTrashPage,
  reasonText,
  typeWord,
} from "../shared/history-view.js";
import { authorMaps, botContainmentGapOpen, HISTORY_PAGE_SIZE, listJobs } from "./history/data.js";

/** The page's own paths. The item page is `/dashboard/history/<type>/<id>`. */
export const HISTORY_ROOT = "/dashboard/history";

/** A version id, a job id or an item id that may ride in a form field. */
const ITEM_ID_RE = /^[A-Za-z0-9_.:-]{1,120}$/;

/** Which page a request path asks for. */
export function viewOf(path) {
  const p = String(path == null ? "" : path).replace(/\/+$/, "");
  if (p === JOBS_PATH) return "jobs";
  if (p === TRASH_PATH) return "trash";
  if (p === HISTORY_ROOT) return "index";
  if (p.startsWith(`${HISTORY_ROOT}/`)) {
    const rest = p.slice(HISTORY_ROOT.length + 1).split("/");
    if (rest.length === 2 && rest[0] && rest[1]) return "item";
  }
  return null;
}

/**
 * Mount the nested History paths on the dashboard router.
 *
 * They are registered BEFORE the single-segment `/dashboard/:panelId` route, and
 * dispatch to the same panel entry, so every History page gets the dashboard's
 * normal chrome (nav, header, shell-or-classic) without a second copy of that
 * wiring. Exported so a test can mount the very same routes behind the real
 * auth + CSRF middleware.
 *
 * @param {import("express").Router} router
 * @param {(req, res, next) => void} dispatch dispatches to this panel's handler
 */
export function mountHistoryRoutes(router, dispatch) {
  // The bare path as well: in the gateway the generic `/dashboard/:panelId` route
  // would also reach it, but mounting it here keeps the whole feature's routing
  // in one place (and lets a test mount exactly what production mounts).
  router.all(`${HISTORY_ROOT}`, dispatch);
  router.all(`${JOBS_PATH}`, dispatch);
  router.all(`${TRASH_PATH}`, dispatch);
  // An item's page. Item types and ids are validated by the handler (a shape that
  // is not one of COVERED's or an id that cannot be stored is a 404).
  router.all(`${HISTORY_ROOT}/:itemType/:itemId`, dispatch);
}

/** The owner's context, or null. The same rule the restore itself needs. */
function ownerContext(req) {
  const ctx = ownerRequestWriteContext(req);
  return ctx && ctx.authorKind === "owner" ? ctx : null;
}

/** A short message object the views render. */
function notice(tone, sentence) {
  return sentence ? { tone, lines: [sentence] } : null;
}

/** Map a refusal from the History API to the sentence the page shows. */
function refusalNotice(err, lang) {
  const code = err && typeof err.code === "string" ? err.code : null;
  if (code === "erased") return notice("error", t("history.result.erased", lang));
  if (code === "conflict") return notice("error", t("history.result.conflict", lang));
  if (code === "redacted") return notice("error", t("history.result.redacted", lang));
  if (code === "not_found") return notice("error", t("history.result.notFound", lang));
  if (code === "not_in_trash") return notice("error", t("history.result.notInTrash", lang));
  if (code === "invalid_context" || code === "not_owner") return notice("error", t("history.result.notOwner", lang));
  return notice("error", t("history.result.failed", lang));
}

/** The sync manager this process has, if any (a restore is an ordinary write). */
function syncManagerOrNull() {
  try {
    return getInstanceSyncManager?.() ?? null;
  } catch {
    return null;
  }
}

/**
 * One POST.
 *
 * @returns {Promise<{notice: object|null, confirming?: boolean}>} what the page
 *   should say on top (an undo's result is a list, so it cannot be a URL).
 */
async function handlePost({ req, db, ctx, lang }) {
  const action = String(req.body?.action || "");
  const syncManager = syncManagerOrNull();

  if (action === "restore") {
    const versionId = Number(req.body?.version_id);
    if (!Number.isInteger(versionId) || versionId <= 0) return { notice: notice("error", t("history.result.notFound", lang)) };
    // A version is restored only from its own item's page.
    const pathType = req.params?.itemType;
    const pathId = req.params?.itemId;
    if (pathType && pathId) {
      const own = await db.execute({
        sql: "SELECT 1 FROM item_versions WHERE id = ? AND item_type = ? AND item_id = ?",
        args: [versionId, String(pathType), String(pathId)],
      });
      if (own.rows.length === 0) return { notice: notice("error", t("history.result.notFound", lang)) };
    }
    try {
      const result = await withWriteContext(ctx, () =>
        restoreVersion(db, { versionId, syncManager }, ctx),
      );
      if (result.unchanged) return { notice: notice("info", t("history.result.unchanged", lang)) };
      // An item that came back without its project is reported, never hidden.
      const unfiled = result.unfiled ? t("history.result.unfiled", lang) : null;
      const restored = t("history.result.restored", lang);
      return { notice: { tone: "ok", lines: unfiled ? [restored, unfiled] : [restored] } };
    } catch (err) {
      return { notice: refusalNotice(err, lang) };
    }
  }

  if (action === "undo_job") {
    const jobId = String(req.body?.job_id || "").trim();
    if (!jobId) return { notice: notice("error", t("history.result.failed", lang)) };
    // An undo of a job is itself a job (`undo:<id>`), and undoing it would
    // re-apply the work it removed. Refused by name rather than silently offered.
    if (jobId.startsWith("undo:")) return { notice: notice("error", t("history.result.undoOfUndo", lang)) };
    try {
      const result = await withWriteContext(ctx, () => undoJob(db, { jobId, syncManager }, ctx));
      const lines = [];
      for (const item of result.restored) {
        const label = `${typeWord(item.itemType, lang)} #${item.itemId}`;
        if (item.action === "deleted") lines.push(`${label} — ${t("history.result.undoDeleted", lang)}`);
        else if (item.action === "unchanged") lines.push(`${label} — ${t("history.result.undoUnchanged", lang)}`);
        else lines.push(`${label} — ${t("history.result.undoRestored", lang)}`);
      }
      for (const item of result.skipped) {
        lines.push(`${typeWord(item.itemType, lang)} #${item.itemId} — ${reasonText(item.reason, lang)}`);
      }
      if (lines.length === 0) return { notice: notice("info", t("history.result.undoNone", lang)) };
      return {
        notice: {
          tone: result.skipped.length === 0 ? "ok" : "info",
          heading: t("history.result.undoHeading", lang),
          lines,
        },
      };
    } catch (err) {
      return { notice: refusalNotice(err, lang) };
    }
  }

  if (action === "trash_restore") {
    const itemType = String(req.body?.item_type || "");
    const itemId = String(req.body?.item_id || "");
    if (!Object.hasOwn(COVERED, itemType) || !ITEM_ID_RE.test(itemId)) return { notice: notice("error", t("history.result.notFound", lang)) };
    try {
      await withWriteContext(ctx, () => restoreFromTrash(db, { itemType, itemId }, ctx, { syncManager }));
      return { notice: notice("ok", t("history.result.trashRestored", lang)) };
    } catch (err) {
      return { notice: refusalNotice(err, lang) };
    }
  }

  if (action === "empty_trash") {
    // The confirm step lives on the page, not in a script dialog: the first POST
    // answers with the question, and only a second one (confirm=1) erases.
    if (String(req.body?.confirm || "") !== "1") return { notice: null, confirming: true };
    try {
      const result = await withWriteContext(ctx, () => emptyTrash(db, { olderThanDays: 0, syncManager }, ctx));
      return { notice: notice("ok", fill(t("history.result.trashEmptied", lang), { n: result.count })) };
    } catch (err) {
      return { notice: refusalNotice(err, lang) };
    }
  }

  return { notice: notice("error", t("history.result.failed", lang)) };
}

/**
 * The panel handler. `viewOf(req.path)` decides the page; everything else is the
 * owner check, the optional POST, and one render.
 */
async function handler(req, res, { db, layout, lang: rawLang }) {
  const lang = SUPPORTED_LANGS.includes(rawLang) ? rawLang : "en";
  const title = t("history.pageTitle", lang);
  const view = viewOf(req.path);
  if (!view) {
    res.status(404);
    return layout({ title, content: renderNotFound(lang) });
  }

  // OWNER FIRST — before a version, a job or a Trash row is read. The refusal
  // page carries no data, only the sentence saying why.
  let owner = false;
  try {
    owner = (await isLocalPasswordSessionOn(db, req)) === true;
  } catch {
    owner = false;
  }
  const ctx = owner ? ownerContext(req) : null;
  if (!owner || !ctx) {
    res.status(403);
    return layout({ title, content: renderRefusal(t("history.onlyOwner", lang), lang) });
  }

  const banner = await botContainmentGapOpen(db);

  // The item page's path is validated BEFORE a POST runs: a page that does not
  // exist must not be able to carry out a restore on its way to a 404.
  const itemType = view === "item" ? String(req.params?.itemType || "") : null;
  const itemId = view === "item" ? String(req.params?.itemId || "") : null;
  if (view === "item" && (!Object.hasOwn(COVERED, itemType) || !ITEM_ID_RE.test(itemId))) {
    res.status(404);
    return layout({ title, content: renderNotFound(lang) });
  }

  let result = { notice: null, confirming: false };
  if (req.method === "POST") result = await handlePost({ req, db, ctx, lang });

  const csrf = req.csrfToken || "";
  const who = await authorMaps(db);
  // The page cursor is a version id. Anything else is ignored rather than passed
  // to the reader (listVersions refuses a malformed cursor, and a page must not
  // be able to turn a bad link into a 500).
  const rawBefore = typeof req.query?.before === "string" ? req.query.before.trim() : "";
  const before = /^\d{1,18}$/.test(rawBefore) ? rawBefore : null;

  if (view === "index") {
    return layout({ title, content: renderHistoryIndex({ banner, lang }) });
  }

  if (view === "jobs") {
    const { jobs, hasMore } = await listJobs(db, { before, limit: HISTORY_PAGE_SIZE });
    return layout({
      title,
      content: renderJobsPage({ jobs, hasMore, before, who, csrf, notice: result.notice, banner, lang }),
    });
  }

  if (view === "trash") {
    let trashDays = DEFAULT_TRASH_DAYS;
    try {
      const raw = await readSetting(db, "history.trash_days");
      trashDays = raw === null || raw === undefined || raw === "" ? DEFAULT_TRASH_DAYS : normalizeTrashDays(Number(raw));
    } catch {
      trashDays = DEFAULT_TRASH_DAYS;
    }
    const items = await listTrash(db, { limit: 200 });
    return layout({
      title,
      content: renderTrashPage({
        items: items.map((item) => ({ ...item, who })),
        trashDays,
        csrf,
        notice: result.notice,
        banner,
        confirming: result.confirming === true,
        lang,
      }),
    });
  }

  // The item page.
  // One extra row: each version's change is computed against the next-older one,
  // so the last version on the page needs its own neighbour to compare with.
  const versions = await listVersions(db, { itemType, itemId, limit: HISTORY_PAGE_SIZE + 1, before });
  const hasMore = versions.length > HISTORY_PAGE_SIZE;
  const shown = Math.min(versions.length, HISTORY_PAGE_SIZE);
  return layout({
    title,
    content: renderItemPage({
      itemType,
      itemId,
      versions,
      shown,
      hasMore,
      before,
      who,
      csrf,
      notice: result.notice,
      banner,
      lang,
    }),
  });
}

export default {
  id: "history",
  name: "History",
  icon: "clock",
  route: HISTORY_ROOT,
  navOrder: 0,
  // Hidden: History is reached from the item it belongs to (a memory, a blog
  // post, a context section) and from the Trash/Jobs links on those pages, not
  // from the sidebar.
  hidden: true,
  handler,
};