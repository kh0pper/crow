/**
 * make-api.js — the Make tab's own routes.
 *
 *   POST /dashboard/make-api/blank  { kind: "docx"|"xlsx"|"pptx", title, project_id?, card_id? }
 *     -> { ok: true, fileId, webUrl, filed }  (filed:false = created but left Unassigned or unlinked)
 *
 * Creates an empty Workspace file in Crow/<project slug or "Unassigned"> and files it under the
 * project (project_id absent or "unassigned" = Unassigned). With card_id (Make's This card), the
 * card must be a live top-level card in tasks.db (checked BEFORE anything is created; else
 * 400 bad_card); the file is then filed under the CARD's project (Unassigned when that project is
 * not live; project_id is ignored) and linked to the card by hand (shell_items.card_id), so it
 * lists in the card's This card view. Errors: 400 bad_request / bad_card,
 * 409 workspace_missing / workspace_not_ready, 502 workspace_unavailable.
 *
 * MOUNT: `/dashboard/make-api`, dashboardAuth first, mounted in dashboard/index.js AFTER
 * csrfMiddleware (the real CSRF rail), never public. Starting a chat from Make uses the existing
 * Perch interactive API from the client, so there is nothing else here.
 */
import express, { Router } from "express";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { homedir } from "node:os";
import { jsonError } from "./_error.js";
import { createDbClient } from "../../db.js";
import { assertLiveProject, setItemCard, setItemProject } from "../../shared/shell-items.js";
import { createBlankWorkspaceFile, BLANK_KIND_IDS } from "../make/sources.js";
import { getCard } from "../board/card-service.js";
import { tasksDbPath } from "../../../scripts/pi-bots/instance-paths.mjs";

/** A live (not archived) top-level card's project id (null = none), or undefined when there is no such card. */
async function liveCardProject(cardId) {
  if (!existsSync(tasksDbPath())) return undefined;
  const tdb = createDbClient(tasksDbPath());
  try {
    const card = await getCard(tdb, cardId);
    if (!card || card.archived_at != null) return undefined;
    return card.project_id == null ? null : Number(card.project_id);
  } finally {
    try { tdb.close(); } catch { /* already closed */ }
  }
}

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
    if (/[/\\]/.test(title)) return jsonError(res, 400, "bad_title");

    let projectId = null;
    const raw = body.project_id;
    if (raw !== undefined && raw !== null && raw !== "" && raw !== "unassigned") {
      const n = typeof raw === "number" ? raw : (typeof raw === "string" && /^[1-9]\d*$/.test(raw) ? Number(raw) : NaN);
      if (!Number.isInteger(n) || n < 1) return jsonError(res, 400, "bad_request");
      projectId = n;
    }
    let cardId = null;
    if (body.card_id !== undefined && body.card_id !== null) {
      if (!(typeof body.card_id === "number" && Number.isInteger(body.card_id) && body.card_id > 0 && body.card_id <= Number.MAX_SAFE_INTEGER)) return jsonError(res, 400, "bad_card");
      cardId = body.card_id;
    }

    const db = createDbClient();
    try {
      if (cardId !== null) {
        let cardProject;
        try { cardProject = await liveCardProject(cardId); } catch (err) {
          console.warn("[make-api] card lookup failed:", err?.message || err);
          return jsonError(res, 400, "bad_card");
        }
        if (cardProject === undefined) return jsonError(res, 400, "bad_card");
        projectId = null;
        if (cardProject !== null) {
          try { projectId = (await assertLiveProject(db, cardProject)).id; } catch (err) { if (!(err && err.name === "AclError")) throw err; }
        }
      }
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
        if (err?.code === "bad_path") return jsonError(res, 400, "bad_title");
        if (err?.code === "not_ready") return jsonError(res, 409, "workspace_not_ready");
        console.warn("[make-api] blank create failed:", err?.message || err);
        return jsonError(res, 502, "workspace_unavailable");
      }
      // The file exists; a filing failure leaves it Unassigned rather than failing the request.
      let filed = true;
      try { await setItemProject(db, "workspace_file", String(made.fileId), projectId, { setBy: "operator" }); }
      catch (err) { filed = false; console.warn("[make-api] could not file the new file:", err?.message || err); }
      if (cardId !== null) {
        try { await setItemCard(db, "workspace_file", String(made.fileId), cardId); }
        catch (err) { filed = false; console.warn("[make-api] could not link the new file to its card:", err?.message || err); }
      }
      res.json({ ok: true, fileId: made.fileId, webUrl: made.webUrl, filed });
    } catch (err) {
      console.warn("[make-api] blank failed:", err?.message || err);
      if (!res.headersSent) jsonError(res, 500, "error");
    } finally {
      try { db.close(); } catch { /* already closed */ }
    }
  });

  return router;
}
