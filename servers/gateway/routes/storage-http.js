/**
 * Storage HTTP Routes — Binary file upload/download
 *
 * POST /storage/upload  — Multipart file upload (auth required; a BOT-BOUND caller
 *                         may not use `reference_type: blog_post`)
 * GET  /storage/file/:key — Presigned redirect or proxy download (auth required;
 *                         a browser <img> cannot send this bearer, so the owner's
 *                         own views use routes/owner-media.js instead)
 */

import { Router } from "express";
import multer from "multer";
import { createDbClient } from "../../db.js";
import {
  AclError,
  assertLocalCapability,
  appendAudit,
} from "../../shared/project-acl.js";
import {
  isAvailable,
  uploadObject,
  deleteObject,
  getPresignedUrl,
  isAllowedMimeType,
  getBucketStats,
} from "../../storage/s3-client.js";
import { resolveCallActor, UNKNOWN } from "../../research/actor.js";
import { botReadScope } from "../../shared/project-share-scope.js";
import { BLOG_POST_REFERENCE_TYPE, BLOG_POST_OWNER_ONLY_MESSAGE } from "../../blog/media-policy.js";

const MAX_UPLOAD_SIZE = parseInt(process.env.MAX_UPLOAD_SIZE || "104857600", 10);
const STORAGE_QUOTA_MB = parseInt(process.env.STORAGE_QUOTA_MB || "5120", 10);

// M2b: same reference-target consistency check as the MCP upload tool — if
// reference_id is set, the referenced row's project_id must match (or both
// be project-less). Prevents files belonging to project A from referencing
// content in project B.
const REFERENCE_PROJECT_LOOKUP = {
  research_source: "SELECT project_id FROM research_sources WHERE id = ?",
  research_note:   "SELECT project_id FROM research_notes   WHERE id = ?",
  blog_post:       null,
};

async function checkReferenceTarget(db, project_id, reference_type, reference_id) {
  if (!reference_type || reference_id == null) return;
  const sql = REFERENCE_PROJECT_LOOKUP[reference_type];
  if (sql === undefined || sql === null) return;
  const { rows } = await db.execute({ sql, args: [reference_id] });
  if (rows.length === 0) {
    throw new AclError(`Referenced ${reference_type}:${reference_id} does not exist`, "ref_not_found");
  }
  const refProjectId = rows[0].project_id;
  if (refProjectId != null && project_id != null && Number(refProjectId) !== Number(project_id)) {
    throw new AclError(
      `Referenced ${reference_type}:${reference_id} belongs to project #${refProjectId}, not #${project_id}`,
      "ref_project_mismatch"
    );
  }
  if (refProjectId != null && project_id == null) {
    throw new AclError(
      `Referenced ${reference_type}:${reference_id} belongs to project #${refProjectId} — set project_id to upload here`,
      "ref_project_required"
    );
  }
}

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: MAX_UPLOAD_SIZE },
});

/**
 * @param {Function|null} authMiddleware
 * @returns {Router}
 */
export default function storageHttpRouter(authMiddleware) {
  const router = Router();

  const auth = authMiddleware ? [authMiddleware] : [];

  // POST /storage/upload — Multipart file upload
  router.post("/storage/upload", ...auth, upload.single("file"), async (req, res) => {
    let db = null;
    /** Close the request's db client whatever path the handler takes from here. */
    const closeDb = () => { if (db) { try { db.close(); } catch {} db = null; } };
    try {
      if (!req.file) {
        return res.status(400).json({ error: "No file provided. Use field name 'file'." });
      }

      const { originalname, mimetype, buffer, size } = req.file;

      if (!isAllowedMimeType(mimetype)) {
        return res.status(415).json({ error: `Blocked MIME type: ${mimetype}` });
      }

      const bucket = req.body?.bucket || "crow-files";
      const referenceType = req.body?.reference_type || null;
      const referenceId = req.body?.reference_id ? parseInt(req.body.reference_id, 10) : null;
      const projectId = req.body?.project_id ? parseInt(req.body.project_id, 10) : null;

      db = createDbClient();

      // The bot-bound rule, as the MCP upload tool determines it: a bot actor
      // (the `x-crow-actor-kind: bot` header the engine's clients send) whose
      // share scope binds it. A bot may not attach a file to a blog post —
      // /blog/media serves what a published public post uses, and the reference
      // is the uploader's claim — so this is refused before the storage probe,
      // exactly as crow_upload_file does. Owner/unknown callers unchanged.
      const actor = resolveCallActor(UNKNOWN, { requestInfo: { headers: req.headers } });
      const botBound = (await botReadScope(db, actor)) != null;
      if (botBound && referenceType === BLOG_POST_REFERENCE_TYPE) {
        closeDb();
        return res.status(403).json({ error: BLOG_POST_OWNER_ONLY_MESSAGE });
      }

      if (!(await isAvailable())) {
        closeDb();
        return res.status(503).json({ error: "Storage not configured" });
      }

      // M2b ACL: when uploading to a project, gate on write_files capability.
      // Reference target must belong to the same project (no cross-project leaks).
      let storagePrefix = null;
      try {
        if (projectId != null) {
          await assertLocalCapability(db, projectId, "write_files");
          const r = (await db.execute({
            sql: "SELECT storage_prefix FROM project_spaces WHERE id = ?",
            args: [projectId],
          })).rows[0];
          storagePrefix = r?.storage_prefix || null;
        }
        await checkReferenceTarget(db, projectId, referenceType, referenceId);
      } catch (err) {
        if (err instanceof AclError) {
          closeDb();
          return res.status(403).json({ error: err.message, code: err.code });
        }
        throw err;
      }

      // Check quota
      const stats = await getBucketStats();
      const quotaBytes = STORAGE_QUOTA_MB * 1024 * 1024;
      if (stats.totalSizeBytes + size > quotaBytes) {
        closeDb();
        return res.status(507).json({ error: `Storage quota exceeded (${STORAGE_QUOTA_MB}MB)` });
      }

      const timestamp = Date.now();
      const sanitizedName = originalname.replace(/[^a-zA-Z0-9._-]/g, "_");
      const s3Key = storagePrefix
        ? `${storagePrefix}${timestamp}-${sanitizedName}`
        : `${timestamp}-${sanitizedName}`;

      await uploadObject(s3Key, buffer, { bucket, contentType: mimetype });

      let inserted = false;
      try {
        await db.execute({
          sql: `INSERT INTO storage_files (s3_key, original_name, mime_type, size_bytes, bucket, reference_type, reference_id, project_id)
                VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
          args: [
            s3Key, originalname, mimetype, size, bucket,
            referenceType,
            referenceId,
            projectId,
          ],
        });
        inserted = true;
        if (projectId != null) {
          await appendAudit(db, {
            project_id: projectId, actor_type: "local", action: "file.upload",
            target: `file:${s3Key}`,
            payload: { file_name: originalname, size_bytes: size, mime_type: mimetype },
          });
        }
      } catch (err) {
        // Only remove the object if the file was never recorded — deleting it
        // after a successful insert would orphan the DB row instead.
        if (!inserted) {
          try { await deleteObject(s3Key, bucket); } catch {}
        }
        throw err;
      } finally {
        closeDb();
      }

      const url = await getPresignedUrl(s3Key, { bucket });
      res.status(201).json({ key: s3Key, name: originalname, size, url, project_id: projectId });
    } catch (err) {
      closeDb();
      console.error("[storage] Upload error:", err);
      res.status(500).json({ error: "Upload failed" });
    }
  });

  // GET /storage/file/:key — Presigned redirect
  router.get("/storage/file/:key(*)", ...auth, async (req, res) => {
    try {
      if (!(await isAvailable())) {
        return res.status(503).json({ error: "Storage not configured" });
      }

      const s3Key = req.params.key;
      const bucket = req.query.bucket || "crow-files";
      const expiry = parseInt(req.query.expiry || "3600", 10);

      const url = await getPresignedUrl(s3Key, { bucket, expiry: Math.min(expiry, 86400) });
      res.redirect(302, url);
    } catch (err) {
      console.error("[storage] Download error:", err);
      res.status(404).json({ error: "File not found" });
    }
  });

  return router;
}
