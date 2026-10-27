/**
 * shell-api.js — the shell's own routes. Today: move an item between projects.
 *
 *   POST /dashboard/shell-api/items/:kind/:ref/project  { project_id: number | "unassigned" }
 *     -> { ok: true, project_id: number | null }
 *
 * MOUNT: `/dashboard/shell-api`, `router.use(P, dashboardAuth)` as the first
 * statement, mounted in dashboard/index.js AFTER csrfMiddleware (the real CSRF
 * rail) and never public. All SQL on shell_items lives in shared/shell-items.js.
 *
 * The item must exist, so a typo never leaves a phantom row: a thread needs a
 * perch-live bot_sessions row, an artifact a live artifacts row. A Workspace file is only
 * checked for the bundle being installed and the id being a positive integer;
 * the core cannot reach the bundle's own store, so the real existence check
 * lands with the Workspace work in P4.
 */
import { Router } from "express";
import { join } from "node:path";
import { homedir } from "node:os";
import { jsonError } from "./_error.js";
import { createDbClient } from "../../db.js";
import { ITEM_KINDS, setItemProject } from "../../shared/shell-items.js";
import { installedBundleIds } from "../skills-catalog.js";

const REF_RE = /^[A-Za-z0-9_.:-]{1,128}$/;
const noTable = (err) => /no such table/i.test(String(err?.message || err));

async function exists(db, sql, args) {
  try {
    const { rows } = await db.execute({ sql, args });
    return rows.length > 0;
  } catch (err) {
    if (noTable(err)) return false;
    throw err;
  }
}

async function itemExists(db, kind, ref) {
  if (kind === "perch_thread") {
    return exists(db, "SELECT 1 FROM bot_sessions WHERE gateway_thread_id = ? AND kind = 'perch-live' LIMIT 1", [ref]);
  }
  if (kind === "artifact") {
    return exists(db, "SELECT 1 FROM artifacts WHERE id = ? AND deleted_at IS NULL LIMIT 1", [ref]);
  }
  // workspace_file: installed bundle only (existence check moves to P4).
  const crowHome = process.env.CROW_HOME || join(homedir(), ".crow");
  return installedBundleIds(crowHome).includes("workspace");
}

export function shellApiRouter(dashboardAuth) {
  const router = Router();
  const P = "/dashboard/shell-api";
  router.use(P, dashboardAuth);

  router.post(P + "/items/:kind/:ref/project", async (req, res) => {
    const kind = String(req.params.kind);
    const ref = String(req.params.ref);
    if (!ITEM_KINDS.includes(kind) || !REF_RE.test(ref)) return jsonError(res, 400, "bad_request");
    if (kind === "workspace_file" && !/^[1-9]\d*$/.test(ref)) return jsonError(res, 400, "bad_request");

    const raw = req.body && typeof req.body === "object" ? req.body.project_id : undefined;
    let projectId;
    if (raw === "unassigned") projectId = null;
    else if (typeof raw === "number" && Number.isInteger(raw) && raw > 0) projectId = raw;
    else if (typeof raw === "string" && /^[1-9]\d*$/.test(raw)) projectId = Number(raw);
    else return jsonError(res, 400, "bad_request");

    const db = createDbClient();
    try {
      if (!(await itemExists(db, kind, ref))) return jsonError(res, 404, "not_found");
      await setItemProject(db, kind, ref, projectId, { setBy: "operator" });
      res.json({ ok: true, project_id: projectId });
    } catch (err) {
      if (err && err.name === "AclError") {
        if (err.code === "not_found") return jsonError(res, 404, "not_found");
        if (err.code === "archived") return jsonError(res, 409, "archived");
      }
      if (err && err.code === "not_migrated") return jsonError(res, 503, "not_migrated");
      if (err && err.code === "bad_kind") return jsonError(res, 400, "bad_request");
      console.warn("[shell-api] move failed:", err.message);
      jsonError(res, 500, "move failed");
    } finally {
      try { db.close(); } catch { /* already closed */ }
    }
  });

  return router;
}
