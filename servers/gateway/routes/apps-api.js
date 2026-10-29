/**
 * apps-api.js — the apps launcher's one read (R1.2 PR 5).
 *
 *   GET /dashboard/shell-api/apps?project=<slug>|all
 *     -> { scope, projectSlug, apps: [{ id, label, kind, href, icon, directPort?, path? }], tiles: [{ id, label, icon, href }] }
 *        project=<slug>: the apps the project's enabled bots can use (a live
 *        project only; anything else is 404 not_found). project=all (or none):
 *        every installed app.
 *
 * Read-only. MOUNT: dashboard/index.js, beside the shell API, AFTER dashboardAuth
 * and csrfMiddleware; the router also installs dashboardAuth on its own path so
 * it is closed wherever it is mounted. Never public (no Funnel prefix).
 */
import { Router } from "express";
import { jsonError } from "./_error.js";
import { createDbClient } from "../../db.js";
import { ACTIVE_PROJECT_WHERE } from "../../shared/shell-items.js";
import { launcherFor } from "../apps/launcher.js";
import { SUPPORTED_LANGS } from "../dashboard/shared/i18n.js";
import { parseCookies } from "../dashboard/auth.js";

const P = "/dashboard/shell-api/apps";

function langOf(req) {
  const c = parseCookies(req).crow_lang;
  return SUPPORTED_LANGS.includes(c) ? c : "en";
}

export function appsApiRouter(dashboardAuth) {
  const router = Router();
  router.use(P, dashboardAuth);

  router.get(P, async (req, res) => {
    res.set("Cache-Control", "no-store");
    const q = typeof req.query.project === "string" ? req.query.project.trim() : "";
    const db = createDbClient();
    try {
      let scope = { all: true };
      if (q && q !== "all") {
        const { rows } = await db.execute({
          sql: `SELECT id, slug FROM project_spaces WHERE slug = ? AND ${ACTIVE_PROJECT_WHERE} LIMIT 1`,
          args: [q],
        });
        if (!rows[0]) return jsonError(res, 404, "not_found");
        scope = { projectId: Number(rows[0].id), slug: String(rows[0].slug) };
      }
      res.json(await launcherFor(db, scope, { lang: langOf(req) }));
    } catch (err) {
      console.warn("[apps-api] launcher read failed:", err.message);
      jsonError(res, 500, "apps failed");
    } finally {
      db.close();
    }
  });

  return router;
}
