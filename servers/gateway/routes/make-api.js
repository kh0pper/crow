/**
 * make-api.js — the Make tab's own routes.
 *
 *   POST /dashboard/make-api/blank  { kind: "docx"|"xlsx"|"pptx", title, project_id? }
 *     -> { ok: true, fileId, webUrl }
 *
 * Creates an empty Workspace file in Crow/<project slug or "Unassigned"> and files it under the
 * project (project_id absent or "unassigned" = Unassigned). Errors: 400 bad_request,
 * 409 workspace_missing / workspace_not_ready, 502 workspace_unavailable.
 *
 * MOUNT: `/dashboard/make-api`, dashboardAuth first, mounted in dashboard/index.js AFTER
 * csrfMiddleware (the real CSRF rail), never public. Starting a chat from Make uses the existing
 * Perch interactive API from the client, so there is nothing else here.
 */
import express, { Router } from "express";
import { join } from "node:path";
import { homedir } from "node:os";
import { jsonError } from "./_error.js";
import { createDbClient } from "../../db.js";
import { assertLiveProject, setItemProject } from "../../shared/shell-items.js";
import { createBlankWorkspaceFile, BLANK_KIND_IDS } from "../make/sources.js";

export function makeApiRouter(dashboardAuth) {
  const router = Router();
  const P = "/dashboard/make-api";
  router.use(P, dashboardAuth);
  router.use(P, express.json({ limit: "16kb" }));

  router.post(P + "/blank", async (req, res) => {
    const body = req.body && typeof req.body === "object" ? req.body : {};
    const kind = typeof body.kind === "string" ? body.kind : "";
    const title = typeof body.title === "string" ? body.title.trim() : "";
    if (!BLANK_KIND_IDS.includes(kind) || title.length < 1 || title.length > 200) return jsonError(res, 400, "bad_request");

    let projectId = null;
    const raw = body.project_id;
    if (raw !== undefined && raw !== null && raw !== "" && raw !== "unassigned") {
      const n = typeof raw === "number" ? raw : (typeof raw === "string" && /^[1-9]\d*$/.test(raw) ? Number(raw) : NaN);
      if (!Number.isInteger(n) || n < 1) return jsonError(res, 400, "bad_request");
      projectId = n;
    }

    const db = createDbClient();
    try {
      let slug = null;
      if (projectId !== null) {
        try { slug = (await assertLiveProject(db, projectId)).slug; } catch (err) {
          if (err && err.name === "AclError") return jsonError(res, 400, "bad_request");
          throw err;
        }
      }
      const crowHome = process.env.CROW_HOME || join(homedir(), ".crow");
      let made;
      try {
        made = await createBlankWorkspaceFile({ crowHome, kind, title, projectSlug: slug });
      } catch (err) {
        if (err?.code === "workspace_missing") return jsonError(res, 409, "workspace_missing");
        if (err?.code === "not_ready") return jsonError(res, 409, "workspace_not_ready");
        console.warn("[make-api] blank create failed:", err?.message || err);
        return jsonError(res, 502, "workspace_unavailable");
      }
      // The file exists; a filing failure leaves it Unassigned rather than failing the request.
      try { await setItemProject(db, "workspace_file", String(made.fileId), projectId, { setBy: "operator" }); }
      catch (err) { console.warn("[make-api] could not file the new file:", err?.message || err); }
      res.json({ ok: true, fileId: made.fileId, webUrl: made.webUrl });
    } catch (err) {
      console.warn("[make-api] blank failed:", err?.message || err);
      if (!res.headersSent) jsonError(res, 500, "error");
    } finally {
      try { db.close(); } catch { /* already closed */ }
    }
  });

  return router;
}
