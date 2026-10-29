/**
 * The project home (R1.2): /dashboard/project/<slug>, the page every project
 * in the drawer links to and Chat's tab inside a project. Start a session with
 * the project's lead (or another of its bots, for this session only), what
 * needs you, and the project's earlier sessions.
 *
 * The scope comes from the path (shell/request.js resolveShellPage: the slug
 * wins over the cookie, and nothing is written; the GET is read-only because
 * Turbo prefetches it). An unknown or archived slug is a 404 with a way back
 * to the projects. Classic mode has no shell: it goes to the Projects page.
 * Hidden from the classic sidebar; reached only through the route above.
 */

import { t } from "../shared/i18n.js";
import { ACTIVE_PROJECT_WHERE } from "../../../shared/shell-items.js";
import { getInteractiveEngine } from "../../perch-interactive.js";
import { canManageProject } from "../../apps/extra-tiles.js";
import { resolveCrowHome } from "../../../../scripts/pi-bots/ext_registry.mjs";
import { moveBotToProject } from "./bot-builder/move-bot.js";
import { loadProjectHome } from "./project-home/data.js";
import { projectHomeHtml, projectMissingHtml, projectForbiddenHtml } from "./project-home/html.js";
import { projectHomeCss } from "./project-home/css.js";
import { projectHomeClientJs } from "./project-home/client.js";

/** The live project the path names (the scope resolved from it), or null. */
async function projectFor(db, req) {
  const slug = req.params && typeof req.params.slug === "string" ? req.params.slug : null;
  const scope = req.crowScope;
  if (!slug || !scope || scope.projectId == null || scope.slug !== slug) return null;
  const { rows } = await db.execute({
    sql: `SELECT id, slug, name, tasks_db_uri, workspace_dir FROM project_spaces WHERE id = ? AND ${ACTIVE_PROJECT_WHERE}`,
    args: [Number(scope.projectId)],
  });
  const p = rows[0];
  return p ? { id: Number(p.id), slug: String(p.slug), name: String(p.name || p.slug), tasks_db_uri: p.tasks_db_uri ?? null, workspace_dir: p.workspace_dir ?? null } : null;
}

export default {
  id: "project-home",
  name: "Project",
  icon: "folder",
  route: "/dashboard/project-home",
  navOrder: 15.5,
  category: "tools",
  hidden: true, // the new shell's project home; the classic nav keeps Projects

  async handler(req, res, { db, layout, lang, engine = getInteractiveEngine({ createIfMissing: false }) }) {
    if (!req.crowMode || req.crowMode.mode !== "new") return res.redirect(302, "/dashboard/projects");
    const project = await projectFor(db, req);
    if (!project) {
      res.status(404);
      return layout({ title: t("shell.projectPage", lang), content: projectHomeCss() + projectMissingHtml(lang) });
    }
    const canManage = await canManageProject(db, { projectId: project.id });
    const home = `/dashboard/project/${encodeURIComponent(project.slug)}`;
    // Move a bot here (§14). The ownership check is here, not in the helper (which only needs a live target).
    if (req.method === "POST" && String((req.body || {}).action || "") === "move_bot") {
      if (!canManage) {
        res.status(403);
        return layout({ title: project.name, content: projectHomeCss() + projectForbiddenHtml(lang) });
      }
      const botId = String((req.body || {}).bot_id || "");
      const r = await moveBotToProject(db, botId, project.id, { crowHome: resolveCrowHome(), actor: "local" });
      if (r.ok) return res.redirectAfterPost(`${home}?moved=${encodeURIComponent(botId)}`);
      // A conflict names the bot, never a path: the GET rebuilds the path from this project's workspace.
      const who = r.code === "conflict" ? `&bot=${encodeURIComponent(botId)}` : "";
      return res.redirectAfterPost(`${home}?error=${encodeURIComponent(r.code)}${who}`);
    }
    const q = req.query || {};
    const one = (v) => (typeof v === "string" ? v : "");
    // The shell already counted every project for the drawer (resolveShellPage).
    const data = await loadProjectHome(db, project, { engine, counts: req.crowShellCounts || null,
      canManage, moveId: one(q.move) || null, movedId: one(q.moved) || null,
      conflictBotId: one(q.error) === "conflict" ? one(q.bot) || null : null, lang });
    data.notice = { error: one(q.error) || null };
    return layout({
      title: project.name,
      content: projectHomeCss() + projectHomeHtml(data, project, lang, { req }) + projectHomeClientJs(lang),
    });
  },
};
