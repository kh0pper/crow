/**
 * The dashboard's controls for archiving, restoring and permanently deleting a
 * project (R1.2 §15): the "Manage project" block, the delete confirm page, the
 * result lines and the POST handler. Shared by the project home
 * (/dashboard/project/<slug>) and the Projects panel (/dashboard/projects).
 *
 * The lifecycle functions are always handed NAMED options built here. Nothing
 * from req.body or req.query is ever spread into them: deleteProject takes
 * test-only hooks (_beforeTransaction, _beforeTombstone) that a spread would
 * expose to a request. CSRF comes from the dashboard router's csrfMiddleware.
 */

import { basename, join } from "node:path";
import { escapeHtml } from "./components.js";
import { t } from "./i18n.js";
import { csrfInput } from "./csrf.js";
import {
  canOwnProject, archiveProject, restoreProject, deleteSummary, deleteProject, deletedProjectsDir,
} from "../../../shared/project-lifecycle.js";

const fill = (key, lang, vals) => Object.entries(vals).reduce((out, [k, v]) => out.split("{" + k + "}").join(String(v ?? "")), t(key, lang));

const STEP_KEY = Object.freeze({ cards: "projLife.stepCards", board_defs: "projLife.stepBoard", files: "projLife.stepFiles", workspace: "projLife.stepWorkspace" });
const COUNT_ROWS = Object.freeze([
  ["cards", "projLife.cCards"], ["files", "projLife.cFiles"], ["notes", "projLife.cNotes"], ["sources", "projLife.cSources"],
  ["sessions", "projLife.cSessions"], ["connections", "projLife.cConnections"], ["backends", "projLife.cBackends"],
]);

/** Rules shared by both pages. No body.shell prefix: the Projects panel renders in classic mode too. */
export function lifecycleRules() {
  return `
  .pl { min-width: 0; max-width: 44rem; display: flex; flex-direction: column; gap: 12px; }
  .pl-title { margin: 0; font-size: 1.15rem; overflow-wrap: anywhere; }
  .pl p { margin: 0; overflow-wrap: anywhere; }
  .pl-warn { font-weight: 700; }
  .pl-counts { list-style: none; margin: 0; padding: 0; display: flex; flex-direction: column; gap: 4px; }
  .pl-counts li { display: flex; justify-content: space-between; gap: 12px; padding: 6px 12px; border: 1px solid var(--crow-border); border-radius: var(--crow-radius-card, 12px); background: var(--crow-bg-surface); }
  .pl-form { display: flex; flex-direction: column; gap: 8px; margin: 0; }
  .pl-form label { font-size: 0.9rem; color: var(--crow-text-secondary); }
  .pl-form input[type=text] { box-sizing: border-box; width: 100%; min-height: 44px; padding: 0 10px; font: inherit; font-size: 1rem; border: 1px solid var(--crow-border); border-radius: var(--crow-radius-control, 10px); background: var(--crow-bg-surface); color: var(--crow-text-primary); }
  .pl-actions { display: flex; flex-direction: column; gap: 8px; }
  .pl-btn, .pl-link {
    display: inline-flex; align-items: center; justify-content: center; box-sizing: border-box;
    min-height: 48px; min-width: 44px; padding: 0 20px; max-width: 100%; font: inherit; font-weight: 600;
    border: 1px solid var(--crow-border); border-radius: var(--crow-radius-control, 10px);
    background: var(--crow-bg-surface); color: var(--crow-text-primary); text-decoration: none; cursor: pointer;
  }
  .pl-btn--danger { background: var(--crow-error); border-color: var(--crow-error); color: var(--crow-accent-contrast); }
  .pl-link--quiet { border-color: transparent; background: none; color: var(--crow-accent); }
  .pl-btn:focus-visible, .pl-link:focus-visible, .pl-form input:focus-visible, .pl-manage summary:focus-visible { outline: 2px solid var(--crow-accent); outline-offset: 2px; }
  .pl-banner { padding: 10px 12px; border: 1px solid var(--crow-border); border-radius: var(--crow-radius-card, 12px); background: var(--crow-bg-surface); overflow-wrap: anywhere; }
  .pl-banner--err { border-color: var(--crow-error); }
  .pl-manage { margin-top: 8px; }
  .pl-manage summary { display: flex; align-items: center; min-height: 44px; cursor: pointer; color: var(--crow-accent); font-weight: 600; }
  .pl-manage[open] > .pl { padding-top: 8px; }
  .pl-row-actions { display: flex; flex-wrap: wrap; gap: 8px; margin: -0.25rem 0 0.75rem; }
  .pl-row-actions form { margin: 0; }
  /* The confirm's Cancel comes first in source, so on a phone the red button is never the first thing under the field. */
  @media (min-width: 600px) { .pl-actions { flex-direction: row; } .pl-actions--confirm { flex-direction: row-reverse; justify-content: flex-end; } }
  `;
}

const post = (req, action, url, label, { cls = "pl-btn", id = null, extra = "" } = {}) =>
  `<form method="POST" action="${escapeHtml(url)}" class="pl-form">${csrfInput(req)}<input type="hidden" name="action" value="${action}">${id != null ? `<input type="hidden" name="id" value="${Number(id)}">` : ""}${extra}<button type="submit" class="${cls}" data-pl-${action.replace(/_/g, "-")}>${escapeHtml(label)}</button></form>`;

/** The project home's "Manage project" block (owner only; the caller decides). */
export function manageProjectHtml(req, project, lang) {
  const home = `/dashboard/project/${encodeURIComponent(project.slug)}`;
  return `<details class="pl-manage" data-pl-manage><summary>${escapeHtml(t("projLife.manage", lang))}</summary>
    <div class="pl">
      <p class="ph-sub">${escapeHtml(t("projLife.archiveNote", lang))}</p>
      ${post(req, "archive_project", home, t("projLife.archive", lang))}
      <a class="pl-link" href="${home}?delete=1" data-pl-delete-link>${escapeHtml(t("projLife.deleteLink", lang))}</a>
    </div></details>`;
}

/** The Projects panel's detail-view controls: Archive or Restore, and Delete. */
export function detailControlsHtml(req, project, lang) {
  const url = "/dashboard/projects";
  const first = project.status === "archived"
    ? post(req, "restore_project", url, t("projLife.restore", lang), { id: project.id })
    : post(req, "archive_project", url, t("projLife.archive", lang), { id: project.id });
  return `<div class="pl-row-actions" data-pl-detail>${first}<a class="pl-link" href="${url}?delete=${Number(project.id)}" data-pl-delete-link>${escapeHtml(t("projLife.deleteLink", lang))}</a></div>`;
}

/** An archived row's actions in the Projects list: Restore and Delete. */
export function archivedRowActionsHtml(req, project, lang) {
  const url = "/dashboard/projects";
  return `<div class="pl-row-actions" data-pl-row="${Number(project.id)}">${post(req, "restore_project", url, t("projLife.restore", lang), { id: project.id })}<a class="pl-link" href="${url}?delete=${Number(project.id)}" data-pl-delete-link>${escapeHtml(t("projLife.deleteRow", lang))}</a></div>`;
}

const whoText = (detail, lang) => {
  const parts = [...(detail?.members || [])];
  const n = Number(detail?.shares || 0);
  if (n === 1) parts.push(t("projLife.sharedItemOne", lang));
  else if (n > 1) parts.push(fill("projLife.sharedItems", lang, { n }));
  return parts.join(", ");
};

const ERROR_KEY = Object.freeze({ name_mismatch: "projLife.nameMismatch", failed: "projLife.failed" });

/**
 * The delete confirm page body. `urls`: { post, cancel }.
 * @returns {Promise<{ forbidden?: true, html?: string }>}
 */
export async function deleteConfirmHtml(db, req, project, lang, { urls, error = "", disconnected = "" }) {
  const sum = await deleteSummary(db, project.id, {});
  if (sum.blocked && sum.blocked.code === "not_owner") return { forbidden: true };
  const title = `<h2 class="pl-title">${escapeHtml(fill("projLife.confirmTitle", lang, { name: project.name }))}</h2>`;
  const err = (ERROR_KEY[error] ? `<p class="pl-banner pl-banner--err" role="alert" data-pl-error="${escapeHtml(error)}">${escapeHtml(t(ERROR_KEY[error], lang))}</p>` : "")
    // A refusal found after the disconnects ran (deleteProject's detail.disconnected).
    + (/^[1-9][0-9]{0,5}$/.test(String(disconnected)) ? `<p class="pl-banner pl-banner--err" role="alert" data-pl-disconnected>${escapeHtml(t("projLife.disconnected", lang))}</p>` : "");
  const cancel = `<a class="pl-link pl-link--quiet" href="${escapeHtml(urls.cancel)}">${escapeHtml(t("common.cancel", lang))}</a>`;
  if (sum.blocked) {
    const b = sum.blocked;
    let msg; let fix;
    if (b.code === "shared") {
      msg = fill("projLife.blockedShared", lang, { who: whoText(b.detail, lang) });
      fix = `<a class="pl-link" href="/dashboard/projects?view=${Number(project.id)}&amp;tab=members" data-pl-fix="sharing">${escapeHtml(t("projLife.goSharing", lang))}</a>`;
    } else {
      msg = fill("projLife.blockedBots", lang, { bots: (b.detail?.bots || []).join(", ") });
      // The Bots section (and Move) lives on the project home, which only serves a live project.
      fix = project.status === "archived"
        ? `<p data-pl-fix="restore">${escapeHtml(t("projLife.restoreFirst", lang))}</p>${post(req, "restore_project", urls.post, t("projLife.restore", lang), { id: project.id })}`
        : `<a class="pl-link" href="/dashboard/project/${encodeURIComponent(project.slug)}#ph-bots-h" data-pl-fix="bots">${escapeHtml(t("projLife.goBots", lang))}</a>`;
    }
    return { html: `<div class="pl" data-pl-confirm data-pl-blocked="${escapeHtml(b.code)}">${title}${err}<p class="pl-banner pl-banner--err" role="alert">${escapeHtml(msg)}</p><div class="pl-actions">${fix}${cancel}</div></div>` };
  }
  const c = sum.counts;
  const rows = COUNT_ROWS.map(([k, key]) => `<li data-pl-count="${k}"><span>${escapeHtml(t(key, lang))}</span><strong>${Number(c[k] || 0)}</strong></li>`).join("");
  const ws = c.workspace ? `<p data-pl-workspace>${escapeHtml(fill("projLife.workspaceNote", lang, { path: deletedProjectsDir() }))}</p>` : "";
  const clone = c.everCloneShared ? `<p data-pl-clone>${escapeHtml(t("projLife.cloneNote", lang))}</p>` : "";
  return { html: `<div class="pl" data-pl-confirm>${title}${err}
    <p>${escapeHtml(t("projLife.deletes", lang))}</p>
    <ul class="pl-counts">${rows}</ul>
    <p class="pl-warn" data-pl-warn>${escapeHtml(t("projLife.warn", lang))}</p>${ws}${clone}
    <form method="POST" action="${escapeHtml(urls.post)}" class="pl-form" autocomplete="off">${csrfInput(req)}
      <input type="hidden" name="action" value="delete_project"><input type="hidden" name="id" value="${Number(project.id)}">
      <label for="pl-confirm-name">${escapeHtml(t("projLife.nameLabel", lang))}</label>
      <input type="text" id="pl-confirm-name" name="confirm_name" required autocomplete="off" autocapitalize="off" spellcheck="false" data-pl-name>
      <div class="pl-actions pl-actions--confirm">${cancel}<button type="submit" class="pl-btn pl-btn--danger" data-pl-delete-go>${escapeHtml(t("projLife.deleteGo", lang))}</button></div>
    </form></div>` };
}

/** The banner on /dashboard/projects after an archive or delete (query: archived, deleted, ws, partial). */
export function resultBannerHtml(query, lang) {
  const q = query || {};
  const one = (v) => (typeof v === "string" ? v : "");
  if (one(q.deleted) === "1") {
    const lines = [t("projLife.deleted", lang)];
    const ws = one(q.ws);
    // The folder name is rebuilt under the server's own deleted-projects directory; only a plain name is accepted.
    const folder = /^[A-Za-z0-9][A-Za-z0-9-]{5,100}$/.test(ws) && ws !== "none";
    if (folder) {
      lines.push(fill("projLife.movedTo", lang, { path: join(deletedProjectsDir(), ws) }), t("projLife.removeLater", lang));
    } else if (ws === "left") lines.push(t("projLife.notMoved", lang));
    const steps = one(q.partial).split(",").filter((s) => STEP_KEY[s] && !(ws === "left" && s === "workspace")).map((s) => t(STEP_KEY[s], lang));
    if (steps.length) lines.push(fill("projLife.partial", lang, { steps: steps.join(", ") }));
    // Only the redirect a real delete builds shows the banner: a valid ws, or a partial list. A bare ?deleted=1 shows nothing.
    if (!folder && ws !== "left" && ws !== "none" && !steps.length) return "";
    return `<p class="pl-banner" role="status" data-pl-deleted>${lines.map(escapeHtml).join(" ")}</p>`;
  }
  if (one(q.archived)) return `<p class="pl-banner" role="status" data-pl-archived>${escapeHtml(t("projLife.archived", lang))}</p>`;
  return "";
}

async function slugOf(db, id) {
  const { rows } = await db.execute({ sql: "SELECT slug FROM project_spaces WHERE id = ?", args: [Number(id)] });
  return rows[0] ? String(rows[0].slug) : null;
}

/**
 * Handle archive_project, restore_project and delete_project. Returns false when the action is not
 * one of ours, else { page? }: a refusal page for the caller to return, or {} after a redirect. Ownership is re-checked here with canOwnProject; the lifecycle
 * functions check it again. `urls.confirm(extraQuery)` is the confirm page to return to on a refusal.
 */
export async function handleLifecyclePost(req, res, { db, lang, layout, projectId, urls, forbiddenHtml }) {
  const body = req.body || {};
  const action = String(body.action || "");
  if (!["archive_project", "restore_project", "delete_project"].includes(action)) return false;
  const id = Number(projectId);
  if (!Number.isInteger(id) || !(await canOwnProject(db, id))) {
    res.status(403);
    return { page: layout({ title: t("projectHome.forbidden", lang), content: `<style>${lifecycleRules()}</style>${forbiddenHtml}` }) };
  }
  if (action === "archive_project") {
    await archiveProject(db, id, { actor: "local" });
    res.redirectAfterPost(`/dashboard/projects?status=archived&archived=${id}`);
    return {};
  }
  if (action === "restore_project") {
    const r = await restoreProject(db, id, { actor: "local" });
    const slug = r.ok ? await slugOf(db, id) : null;
    res.redirectAfterPost(slug ? `/dashboard/project/${encodeURIComponent(slug)}` : "/dashboard/projects");
    return {};
  }
  const r = await deleteProject(db, id, { confirmName: typeof body.confirm_name === "string" ? body.confirm_name : "", actor: "local" });
  if (!r.ok) {
    const n = Number(r.detail?.disconnected || 0);
    res.redirectAfterPost(urls.confirm(`error=${encodeURIComponent(r.code)}${n > 0 ? `&disconnected=${n}` : ""}`));
    return {};
  }
  const ws = r.movedTo ? basename(r.movedTo) : (r.counts.workspace ? "left" : "none");
  const partial = (r.partial || []).filter((s) => STEP_KEY[s]).join(",");
  res.redirectAfterPost(`/dashboard/projects?deleted=1&ws=${encodeURIComponent(ws)}${partial ? `&partial=${encodeURIComponent(partial)}` : ""}`);
  return {};
}
