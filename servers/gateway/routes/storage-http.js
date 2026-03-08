/**
 * Storage HTTP Routes — Binary file upload/download
 *
 * POST /storage/upload  — Multipart file upload (auth required)
 * GET  /storage/file/:key — Presigned redirect or proxy download (auth required)
 */

import { Router } from "express";
import multer from "multer";
import { createDbClient } from "../../db.js";
import {
  isAvailable,
  uploadObject,
  getPresignedUrl,
  isAllowedMimeType,
  getBucketStats,
} from "../../storage/s3-client.js";

const MAX_UPLOAD_SIZE = parseInt(process.env.MAX_UPLOAD_SIZE || "104857600", 10);
const STORAGE_QUOTA_MB = parseInt(process.env.STORAGE_QUOTA_MB || "5120", 10);

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
    try {
      if (!(await isAvailable())) {
        return res.status(503).json({ error: "Storage not configured" });
      }

      if (!req.file) {
        return res.status(400).json({ error: "No file provided. Use field name 'file'." });
      }

      const { originalname, mimetype, buffer, size } = req.file;

      if (!isAllowedMimeType(mimetype)) {
        return res.status(415).json({ error: `Blocked MIME type: ${mimetype}` });
      }

      // Check quota
      const stats = await getBucketStats();
      const quotaBytes = STORAGE_QUOTA_MB * 1024 * 1024;
      if (stats.totalSizeBytes + size > quotaBytes) {
        return res.status(507).json({ error: `Storage quota exceeded (${STORAGE_QUOTA_MB}MB)` });
      }

      const bucket = req.body?.bucket || "crow-files";
      const timestamp = Date.now();
      const s3Key = `${timestamp}-${originalname.replace(/[^a-zA-Z0-9._-]/g, "_")}`;

      await uploadObject(s3Key, buffer, { bucket, contentType: mimetype });

      const db = createDbClient();
      try {
        await db.execute({
          sql: `INSERT INTO storage_files (s3_key, original_name, mime_type, size_bytes, bucket, reference_type, reference_id)
                VALUES (?, ?, ?, ?, ?, ?, ?)`,
          args: [
            s3Key, originalname, mimetype, size, bucket,
            req.body?.reference_type || null,
            req.body?.reference_id ? parseInt(req.body.reference_id, 10) : null,
          ],
        });
      } finally {
        db.close();
      }

      const url = await getPresignedUrl(s3Key, { bucket });
      res.status(201).json({ key: s3Key, name: originalname, size, url });
    } catch (err) {
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
