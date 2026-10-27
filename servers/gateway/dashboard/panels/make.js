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
import { listMakeItems } from "../../make/sources.js";
import { itemPreview, previewDeps, previewLineKey, previewsEnabled } from "../../make/previews.js";
import { markSeen, activeProjects } from "../../../shared/shell-items.js";
import { renderMakePage } from "./make/html.js";
import { MAKE_CSS } from "./make/css.js";
import { makeClientJs } from "./make/client.js";

const ARTIFACT_ID_RE = /^art_[A-Za-z0-9_-]{6,40}$/; // same shape as the Artifacts bundle's ARTIFACT_ID_RE
const WS_REF_RE = /^[1-9]\d{0,15}$/;
const FILTER_IDS = ["all", "documents", "pages", "shared"];

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

/** GET /dashboard/make/open/:kind/:ref. Strict on :ref; 404 for anything unknown. */
export async function openMakeItem(req, res, db) {
  const { kind, ref } = req.params;
  const notFound = () => res.status(404).type("text/plain").send("not found");
  try {
    if (kind === "artifact") {
      if (typeof ref !== "string" || !ARTIFACT_ID_RE.test(ref)) return notFound();
      const { rows } = await db.execute({ sql: "SELECT id, current_version FROM artifacts WHERE id = ? AND deleted_at IS NULL", args: [ref] });
      if (!rows[0]) return notFound();
      await markSeen(db, "artifact", rows[0].id, Number(rows[0].current_version));
      return res.redirect(303, `/dashboard/artifacts/view/${rows[0].id}?from=make`);
    }
    if (kind === "workspace_file") {
      if (typeof ref !== "string" || !WS_REF_RE.test(ref)) return notFound();
      let url = null;
      try { url = await workspaceUrl(ref); } catch (err) { console.warn(`[make] Workspace open failed: ${err?.message || err}`); }
      if (!url) return notFound();
      await markSeen(db, "workspace_file", ref, null);
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
    const scope = req.crowScope || { all: true };
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
    const model = await lister(db, scope, { crowHome: crowHome(), filter, previews });
    // One line under the chips for a renderer reason (the first one any tile met).
    const reason = enabled ? (model.items || []).map((i) => i.previewReason).find((r) => previewLineKey(r)) || null : null;
    const back = filter === "all" ? "/dashboard/make" : `/dashboard/make?filter=${filter}`;
    // The project a new thing starts in: the shell's chip, else Unassigned.
    let project = { id: "unassigned", name: t("shell.unassigned", lang) };
    if (scope.projectId != null) {
      try {
        const { rows } = await db.execute({ sql: "SELECT name FROM project_spaces WHERE id = ?", args: [Number(scope.projectId)] });
        if (rows[0]) project = { id: Number(scope.projectId), name: String(rows[0].name || scope.slug || "") };
      } catch (err) { console.warn(`[make] project name lookup failed: ${err.message}`); }
    }
    let projects = [];
    try { projects = await activeProjects(db); } catch (err) { console.warn(`[make] project list failed: ${err.message}`); }
    return layout({
      title: t("shell.tabMake", lang),
      content: MAKE_CSS + renderMakePage({ model, filter, lang, project, projects, previews: { enabled, lineKey: reason ? previewLineKey(reason) : null, csrf: req.csrfToken || "", back } }) + makeClientJs(lang),
    });
  },
};
