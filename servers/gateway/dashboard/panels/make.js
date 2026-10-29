/**
 * Make panel: a gallery of what Crow made (Artifacts pages and diagrams, Workspace documents),
 * scoped by the shell's project chip, with filters and install offers for what is missing.
 *
 * Data: servers/gateway/make/sources.js. Tiles link to GET /dashboard/make/open/:kind/:ref
 * (openMakeItem below, mounted in dashboard/index.js after dashboardAuth), which marks the item
 * seen and redirects. The redirect target is built ONLY from two forms, never from the request:
 * /dashboard/artifacts/view/<id>?from=make, or the Workspace bundle's own web_url for that file.
 * The GET writes markSeen on purpose: idempotent, and it only clears the operator's own
 * "Just made" badge, so a forged cross-site GET is not a state change that matters.
 *
 * Hidden from the classic sidebar: classic keeps Artifacts as its own page; Make is a tab of the
 * new shell (shell/chrome.js points the tab here once this panel is registered).
 */
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { t } from "../shared/i18n.js";
import { cardSummary, documentsForCard } from "../../make/card-docs.js";
import { listMakeItems } from "../../make/sources.js";
import { itemPreview, previewDeps, previewLineKey, previewsEnabled } from "../../make/previews.js";
import { markSeen, getItem, activeProjects } from "../../../shared/shell-items.js";
import { renderMakePage } from "./make/html.js";
import { MAKE_CSS } from "./make/css.js";
import { makeClientJs } from "./make/client.js";

const ARTIFACT_ID_RE = /^art_[A-Za-z0-9_-]{6,40}$/; // same shape as the Artifacts bundle's ARTIFACT_ID_RE
const WS_REF_RE = /^[1-9]\d{0,15}$/;
const FILTER_IDS = ["all", "documents", "pages", "shared"];

/**
 * Which documents Make shows. ?scope=card:<id> (a valid card id) is one card, ?scope=all is every
 * project, anything else is the shell's project chip when it is a single project, else all. Reads
 * only the query and the shell's already-resolved scope: it never sets the project or a cookie.
 */
export function parseMakeScope(query, crowScope) {
  const raw = typeof query?.scope === "string" ? query.scope : "";
  const m = /^card:([1-9]\d{0,15})$/.exec(raw);
  if (m) return { kind: "card", cardId: m[1] };
  if (raw === "all") return { kind: "all" };
  if (crowScope?.projectId != null) return { kind: "project", scope: crowScope };
  return { kind: "all" };
}

let lister = listMakeItems;
let wsLookup = null;
/** Test seams: replace the data source / the Workspace file lookup; null restores each. */
export function _setMakeSeamsForTest({ list, workspaceUrl } = {}) { lister = list || listMakeItems; wsLookup = workspaceUrl || null; }

const crowHome = () => process.env.CROW_HOME || join(process.env.HOME || "", ".crow");

/** The Workspace web_url for a file id (via the bundle's own config + stat + toPublic), or null. */
async function workspaceUrl(fileId) {
  if (wsLookup) return wsLookup(fileId);
  const imp = (f) => import(pathToFileURL(join(crowHome(), "bundles", "workspace", "server", f)).href);
  const [{ getConfig }, { stat }, { toPublic }] = await Promise.all([imp("config.js"), imp("nc/dav.js"), imp("tools/common.js")]);
  const cfg = getConfig();
  const entry = await stat(cfg, { file_id: Number(fileId) });
  if (!entry || entry.isFolder) return null;
  const url = toPublic(entry, cfg).web_url;
  return /^https?:\/\//i.test(String(url)) ? url : null;
}

/**
 * Mark an opened item seen. An artifact with no shell_items row is skipped (markSeen would file it
 * as Unassigned before the listing files it under its origin); a missing table never blocks the open.
 */
async function seen(db, kind, ref, version, onlyIfRow) {
  try {
    if (onlyIfRow && !(await getItem(db, kind, ref))) return;
    await markSeen(db, kind, ref, version);
  } catch (err) {
    if (err?.code === "not_migrated") return;
    throw err;
  }
}

/** GET /dashboard/make/open/:kind/:ref. Strict on :ref; 404 for anything unknown. */
export async function openMakeItem(req, res, db) {
  const { kind, ref } = req.params;
  const notFound = () => res.status(404).type("text/plain").send("not found");
  try {
    if (kind === "artifact") {
      if (typeof ref !== "string" || !ARTIFACT_ID_RE.test(ref)) return notFound();
      const { rows } = await db.execute({ sql: "SELECT id, current_version FROM artifacts WHERE id = ? AND deleted_at IS NULL", args: [ref] });
      if (!rows[0]) return notFound();
      await seen(db, "artifact", rows[0].id, Number(rows[0].current_version), true);
      return res.redirect(303, `/dashboard/artifacts/view/${rows[0].id}?from=make`);
    }
    if (kind === "workspace_file") {
      if (typeof ref !== "string" || !WS_REF_RE.test(ref)) return notFound();
      let url = null;
      try { url = await workspaceUrl(ref); } catch (err) { console.warn(`[make] Workspace open failed: ${err?.message || err}`); }
      if (!url) return notFound();
      await seen(db, "workspace_file", ref, null, false);
      return res.redirect(303, url);
    }
    return notFound();
  } catch (err) {
    console.warn(`[make] open failed: ${err?.message || err}`);
    if (!res.headersSent) res.status(500).type("text/plain").send("error");
  }
}

export default {
  id: "make",
  name: "Make",
  icon: "sparkles",
  route: "/dashboard/make",
  navOrder: 15.6,
  category: "ai",
  hidden: true, // a tab of the new shell; the classic sidebar keeps Artifacts

  async handler(req, res, { db, layout, lang }) {
    const filter = FILTER_IDS.includes(req.query.filter) ? req.query.filter : "all";
    const shellScope = req.crowScope || { all: true };
    const parsed = parseMakeScope(req.query, shellScope);
    const scope = parsed.kind === "project" ? parsed.scope : { all: true };
    const cardQ = typeof req.query.card === "string" && /^[1-9]\d{0,15}$/.test(req.query.card) ? req.query.card : null;
    const cardId = parsed.kind === "card" ? parsed.cardId : cardQ;
    // Previews (Task 4.5): off until the switch is on, and then only for trusted artifacts.
    let enabled = false;
    try { enabled = await previewsEnabled(db); } catch (err) { console.warn(`[make] previews switch unreadable: ${err.message}`); }
    // Workspace files always get Nextcloud's own preview (R-P4-11): that path reads no renderer
    // deps, so the renderer is never created while the switch is off. Artifacts only when on.
    const deps = enabled ? previewDeps() : null;
    const previews = async (item) => {
      if (item.kind === "workspace_file") return itemPreview(db, item, null);
      return enabled ? itemPreview(db, item, deps) : { previewState: "off", previewUrl: null, previewReason: "not_enabled" };
    };
    let cardRefs = null;
    let cardTitle = "";
    if (parsed.kind === "card") {
      const docs = await documentsForCard(db, parsed.cardId, { lang });
      cardRefs = new Set(docs.map((d) => `${d.kind}:${d.ref}`));
      cardTitle = (await cardSummary(db, parsed.cardId))?.title || "";
    }
    const model = await lister(db, scope, { crowHome: crowHome(), filter, previews, ...(cardRefs ? { cardRefs } : {}) });
    // One line under the chips for a renderer reason (the first one any tile met).
    const reason = enabled ? (model.items || []).map((i) => i.previewReason).find((r) => previewLineKey(r)) || null : null;
    const explicit = typeof req.query.scope === "string" && (parsed.kind === "card" || req.query.scope === "all") ? req.query.scope : null;
    const backQs = [explicit && `scope=${encodeURIComponent(explicit)}`, filter !== "all" && `filter=${filter}`].filter(Boolean).join("&");
    const back = backQs ? `/dashboard/make?${backQs}` : "/dashboard/make";
    // The project a new thing starts in: the shell's chip, else Unassigned.
    let project = { id: "unassigned", name: t("shell.unassigned", lang) };
    if (shellScope.projectId != null) {
      try {
        const { rows } = await db.execute({ sql: "SELECT name FROM project_spaces WHERE id = ?", args: [Number(shellScope.projectId)] });
        if (rows[0]) project = { id: Number(shellScope.projectId), name: String(rows[0].name || shellScope.slug || "") };
      } catch (err) { console.warn(`[make] project name lookup failed: ${err.message}`); }
    }
    let projects = [];
    try { projects = await activeProjects(db); } catch (err) { console.warn(`[make] project list failed: ${err.message}`); }
    return layout({
      title: t("shell.tabMake", lang),
      content: MAKE_CSS + renderMakePage({ model, filter, lang, project, projects, scope: { mode: parsed.kind, cardId, cardTitle, explicit, projectName: shellScope.projectId != null ? project.name : null }, previews: { enabled, lineKey: reason ? previewLineKey(reason) : null, csrf: req.csrfToken || "", back } }) + makeClientJs(lang),
    });
  },
};
