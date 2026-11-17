/**
 * Crow Storage MCP Server
 *
 * S3-compatible file storage (Garage, or any S3 endpoint). Provides tools for uploading,
 * listing, downloading (presigned URLs), and deleting files.
 *
 * Factory function: createStorageServer(dbPath?)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createDbClient } from "../db.js";
import { generateToken, validateToken, shouldSkipGates } from "../shared/confirm.js";
import {
  AclError,
  assertLocalCapability,
  assertProjectExists,
  appendAudit,
} from "../shared/project-acl.js";
import {
  isAvailable,
  uploadObject,
  getPresignedUrl,
  getPresignedUploadUrl,
  deleteObject,
  getBucketStats,
  isAllowedMimeType,
} from "./s3-client.js";
import { actorFromEnv, resolveCallActor, auditActor } from "../research/actor.js";
import {
  makeShareGate,
  scopePredicate,
  refusalResult,
  notFoundResult,
  NOT_FOUND_MESSAGE,
} from "../shared/project-share-scope.js";

// M2b: when an upload claims a reference_id (e.g., source/note/blog_post), the
// referenced row must belong to the same project_id (or both be project-less).
// Otherwise file ACL and content ACL silently disagree.
//
// Public serving: a `blog_post` reference no longer makes a file public by
// itself. GET /blog/media/<key> serves a key only when it is attached to a
// blog post that is BOTH published and public (by reference_id), is such a
// post's cover image, or is linked from such a post's content — so storing
// reference_type='blog_post' here, with or without a reference_id, publishes
// nothing until a post actually uses the file.
const REFERENCE_PROJECT_LOOKUP = {
  research_source: "SELECT project_id FROM research_sources WHERE id = ?",
  research_note:   "SELECT project_id FROM research_notes   WHERE id = ?",
  // blog_posts has no project_id today (kept user-global); accept any.
  blog_post:       null,
};

/**
 * `botBound`: the caller is a bot the share rules bind. Its reference failures all read as the
 * not-found text — a reference it may not see is indistinguishable from one that does not exist,
 * and the target must belong to the project the file is uploaded to (a project-less target is not
 * that project) — so no answer names another project. The owner's messages are unchanged.
 */
async function assertReferenceTargetProjectMatches(db, project_id, reference_type, reference_id, { botBound = false } = {}) {
  if (!reference_type || reference_id == null) return;
  const sql = REFERENCE_PROJECT_LOOKUP[reference_type];
  if (sql === undefined) return;  // unknown reference_type — no check (forward compat)
  if (sql === null) return;        // explicit "no project on this target" pass-through
  const { rows } = await db.execute({ sql, args: [reference_id] });
  if (botBound) {
    if (rows.length === 0 || project_id == null || Number(rows[0].project_id) !== Number(project_id)) {
      throw new AclError(NOT_FOUND_MESSAGE, rows.length === 0 ? "ref_not_found" : "ref_project_mismatch");
    }
    return;
  }
  if (rows.length === 0) {
    throw new AclError(
      `Referenced ${reference_type}:${reference_id} does not exist`,
      "ref_not_found"
    );
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

const MAX_BASE64_SIZE = 1 * 1024 * 1024; // 1MB for base64 uploads
const MAX_UPLOAD_SIZE = parseInt(process.env.MAX_UPLOAD_SIZE || "104857600", 10); // 100MB
const STORAGE_QUOTA_MB = parseInt(process.env.STORAGE_QUOTA_MB || "5120", 10); // 5GB

// A bot's presigned URL (download or upload) lasts at most this long: the shortest window the
// expiry schema allows, so a revoked share stops working quickly.
const BOT_URL_TTL_SECONDS = 300;
const BUCKET_OVERRIDE_MESSAGE = "A bot cannot choose a storage bucket.";

function notConfiguredError() {
  return {
    content: [{
      type: "text",
      text: "Storage is not configured. To set it up, either:\n\n1. Install File Storage (Garage) from Extensions in the Crow's Nest, or\n2. Connect S3-compatible storage you already run in Settings → Shared Storage.\n\nThen restart your MCP client.",
    }],
    isError: true,
  };
}

export function createStorageServer(dbPath, options = {}) {
  const server = new McpServer(
    { name: "crow-storage", version: "0.1.0" },
    options.instructions ? { instructions: options.instructions } : undefined
  );

  const db = createDbClient(dbPath);

  // Who is calling, exactly as the projects and memory servers resolve it: the construction-time
  // base actor (a stdio server's process env, or the actor the gateway built the server with) is
  // fixed here, and each call may only narrow it. The share gate below decides with it per call.
  const baseActor = options.baseActor || actorFromEnv(process.env);
  const callActor = (extra) => resolveCallActor(baseActor, extra);
  // Read by tests (and the callers that build this server): who is calling.
  server.storage = { actor: baseActor, callActor };
  // Resolves one call's actor. `options.onCallActor` is a test seam that sees every resolution —
  // the handler's own answer is otherwise not observable until the share gate decides with it.
  const actorFor = (tool, extra) => {
    const actor = callActor(extra);
    if (typeof options.onCallActor === "function") options.onCallActor(actor, tool);
    return actor;
  };

  // --- Project shares (Phase 1) ---
  // One gate per call (servers/shared/project-share-scope.js) holds every decision about what a
  // bot may reach: its home project, the projects it holds a live share of, and nothing else. The
  // owner, an unidentified caller and the operator's own voice bot are untouched by it.
  const shareGate = (tool, extra) => {
    actorFor(tool, extra);
    return makeShareGate(db, tool, { baseActor, extra });
  };

  /** Is this caller bound by the bot rules? (Not the owner, not the operator's voice bot.) */
  const boundByShares = async (gate) => (await gate.readScope()) != null;

  // The S3 calls this server makes, with a test seam: `options.s3` overrides any of them, so a test
  // drives a fake backend and never touches the network. Everything else is the real client.
  const s3 = {
    isAvailable, uploadObject, getPresignedUrl, getPresignedUploadUrl, deleteObject, getBucketStats,
    ...Object.fromEntries(
      Object.entries(options.s3 || {}).filter(([, fn]) => typeof fn === "function")
    ),
  };

  /**
   * The by-id check file tools make for a caller the bot rules bind: the key's own `storage_files`
   * row decides. Every refusal — an unknown key, a project-less row, a project the bot cannot
   * reach, or a bucket argument that is not the row's — is exactly what a missing key gets, so a
   * hidden key and a missing one read the same.
   * @returns {Promise<{refusal: object|null, row: object|null}>} `row` is the key's own row for a
   *   caller the rules bind and allow (its bucket is the one the S3 call must use); null for an
   *   owner/unknown caller, who passes no bucket argument through to the row.
   */
  async function fileRowGate(gate, bound, s3_key, bucketArg) {
    if (!bound) return { refusal: null, row: null };
    const { rows } = await db.execute({
      sql: "SELECT project_id, bucket FROM storage_files WHERE s3_key = ?",
      args: [s3_key],
    });
    const row = rows[0] || null;
    const refusal = await gate.checkRow(row ? row.project_id : null, {});
    if (refusal) return { refusal, row: null };
    if (row && bucketArg && bucketArg !== row.bucket) return { refusal: notFoundResult(), row: null };
    return { refusal: null, row };
  }

  // --- crow_upload_file ---
  server.tool(
    "crow_upload_file",
    "Upload a small file (base64, <1MB) or get an HTTP upload URL for larger files. When project_id is set, the upload is gated on write_files capability and the s3 key is scoped under the project's storage_prefix. A bot's download URL and upload URL both expire in 5 minutes.",
    {
      file_name: z.string().max(500).describe("Original file name"),
      mime_type: z.string().max(200).optional().describe("MIME type (e.g. image/png)"),
      data_base64: z.string().max(1500000).optional().describe("Base64-encoded file data (for files <1MB)"),
      bucket: z.string().max(100).optional().describe("Target bucket (default: crow-files)"),
      reference_type: z.string().max(100).optional().describe("What this file is attached to (e.g. blog_post, research_source, research_note)"),
      reference_id: z.number().optional().describe("ID of the referenced item"),
      project_id: z.number().optional().describe("Associate with a project space (M2). Caller must have write_files capability."),
    },
    async ({ file_name, mime_type, data_base64, bucket, reference_type, reference_id, project_id }, extra) => {
      // The share gate comes before the storage probe: a refusal needs no backend at all.
      const gate = shareGate("crow_upload_file", extra);
      const pass = await gate.check(project_id, {});
      if (pass.isError) return pass;
      // The project this upload lands in: the project the gate resolved (a bot's home project when
      // it named none), or null for a caller the bot rules do not bind — today's project-less file.
      const targetProjectId = pass.projectId;
      const bound = await boundByShares(gate);
      if (bound && bucket) return refusalResult(BUCKET_OVERRIDE_MESSAGE);

      if (!(await s3.isAvailable())) return notConfiguredError();

      if (mime_type && !isAllowedMimeType(mime_type)) {
        return {
          content: [{ type: "text", text: `Blocked: executable MIME type "${mime_type}" is not allowed.` }],
          isError: true,
        };
      }

      // M2b ACL: when uploading to a project, gate on write_files capability.
      // Reference target must belong to the same project (no cross-project leaks).
      let storagePrefix = null;
      if (targetProjectId != null) {
        try {
          await assertLocalCapability(db, targetProjectId, "write_files");
          await assertReferenceTargetProjectMatches(db, targetProjectId, reference_type, reference_id, { botBound: bound });
          const r = (await db.execute({
            sql: "SELECT storage_prefix FROM project_spaces WHERE id = ?",
            args: [targetProjectId],
          })).rows[0];
          storagePrefix = r?.storage_prefix || null;
        } catch (err) {
          if (err instanceof AclError) return refusalResult(err.message);
          throw err;
        }
      } else {
        // No project but a reference is given — still verify the target isn't
        // pinned to a project we'd be silently bypassing.
        try {
          await assertReferenceTargetProjectMatches(db, null, reference_type, reference_id, { botBound: bound });
        } catch (err) {
          if (err instanceof AclError) return refusalResult(err.message);
          throw err;
        }
      }

      // Check quota
      const stats = await s3.getBucketStats(bucket);
      const quotaBytes = STORAGE_QUOTA_MB * 1024 * 1024;
      if (stats.totalSizeBytes >= quotaBytes) {
        return {
          content: [{ type: "text", text: `Storage quota exceeded (${STORAGE_QUOTA_MB}MB). Delete files to free space.` }],
          isError: true,
        };
      }

      const timestamp = Date.now();
      const sanitizedName = file_name.replace(/[^a-zA-Z0-9._-]/g, "_");
      const s3Key = storagePrefix
        ? `${storagePrefix}${timestamp}-${sanitizedName}`
        : `${timestamp}-${sanitizedName}`;

      if (data_base64) {
        // Direct base64 upload (small files only)
        const buffer = Buffer.from(data_base64, "base64");
        if (buffer.length > MAX_BASE64_SIZE) {
          return {
            content: [{ type: "text", text: `File too large for base64 upload (${(buffer.length / 1024 / 1024).toFixed(1)}MB). Use the HTTP upload endpoint POST /storage/upload for files >1MB.` }],
            isError: true,
          };
        }

        await s3.uploadObject(s3Key, buffer, { bucket, contentType: mime_type });

        try {
          // Record in database
          await db.execute({
            sql: `INSERT INTO storage_files (s3_key, original_name, mime_type, size_bytes, bucket, reference_type, reference_id, project_id)
                  VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
            args: [s3Key, file_name, mime_type || null, buffer.length, bucket || "crow-files", reference_type || null, reference_id || null, targetProjectId ?? null],
          });
        } catch (err) {
          // Don't leave an untracked orphan object behind
          try { await s3.deleteObject(s3Key, bucket || "crow-files"); } catch {}
          throw err;
        }

        if (targetProjectId != null) {
          await appendAudit(db, {
            project_id: targetProjectId, ...auditActor(gate.actor), action: "file.upload",
            target: `file:${s3Key}`,
            payload: { file_name, size_bytes: buffer.length, mime_type: mime_type || null },
          });
        }

        const url = await s3.getPresignedUrl(s3Key, bound ? { bucket, expiry: BOT_URL_TTL_SECONDS } : { bucket });
        return {
          content: [{ type: "text", text: `Uploaded "${file_name}" (${(buffer.length / 1024).toFixed(1)}KB)${targetProjectId != null ? ` to project #${targetProjectId}` : ""}\nKey: ${s3Key}\nDownload URL (${bound ? "5 min" : "1hr"}): ${url}` }],
        };
      } else {
        // Return presigned upload URL for larger files
        const uploadUrl = await s3.getPresignedUploadUrl(s3Key, bound ? { bucket, expiry: BOT_URL_TTL_SECONDS } : { bucket });

        // Pre-register in database (size will be updated after upload)
        await db.execute({
          sql: `INSERT INTO storage_files (s3_key, original_name, mime_type, size_bytes, bucket, reference_type, reference_id, project_id)
                VALUES (?, ?, ?, 0, ?, ?, ?, ?)`,
          args: [s3Key, file_name, mime_type || null, bucket || "crow-files", reference_type || null, reference_id || null, targetProjectId ?? null],
        });

        if (targetProjectId != null) {
          await appendAudit(db, {
            project_id: targetProjectId, ...auditActor(gate.actor), action: "file.upload.presign",
            target: `file:${s3Key}`,
            payload: { file_name, mime_type: mime_type || null },
          });
        }

        return {
          content: [{ type: "text", text: `Upload URL generated for "${file_name}"${targetProjectId != null ? ` (project #${targetProjectId})` : ""}:\n\nPUT ${uploadUrl}\n\nContent-Type: ${mime_type || "application/octet-stream"}\nMax size: ${(MAX_UPLOAD_SIZE / 1024 / 1024).toFixed(0)}MB\nExpires in ${bound ? "5 minutes" : "1 hour"}.\n\nAlternatively, use POST /storage/upload with multipart form data.` }],
        };
      }
    }
  );

  // --- crow_list_files ---
  server.tool(
    "crow_list_files",
    "List stored files with optional filtering. A bot sees its own project's files unless it names a project it holds a share of.",
    {
      bucket: z.string().max(100).optional().describe("Filter by bucket"),
      mime_type: z.string().max(200).optional().describe("Filter by MIME type prefix (e.g. image/)"),
      reference_type: z.string().max(100).optional().describe("Filter by reference type"),
      reference_id: z.number().optional().describe("Filter by reference ID"),
      project_id: z.number().optional().describe("Filter to one project space"),
      limit: z.number().min(1).max(100).optional().describe("Max results (default 50)"),
    },
    async ({ bucket, mime_type, reference_type, reference_id, project_id, limit }, extra) => {
      const gate = shareGate("crow_list_files", extra);
      const pass = await gate.check(project_id, {});
      if (pass.isError) return pass;
      if (!(await s3.isAvailable())) return notConfiguredError();

      let sql = "SELECT id, s3_key, original_name, mime_type, size_bytes, bucket, reference_type, reference_id, created_at FROM storage_files WHERE 1=1";
      const args = [];

      // The project this call may list: the one the gate resolved, or — when it resolved none —
      // the bot's read scope (a bot with no home project matches nothing).
      const projected = pass.projectId != null
        ? { sql: " AND project_id = ?", args: [Number(pass.projectId)] }
        : scopePredicate(await gate.readScope(), { column: "project_id" });
      sql += projected.sql;
      args.push(...projected.args);

      if (bucket) { sql += " AND bucket = ?"; args.push(bucket); }
      if (mime_type) { sql += " AND mime_type LIKE ?"; args.push(`${mime_type}%`); }
      if (reference_type) { sql += " AND reference_type = ?"; args.push(reference_type); }
      if (reference_id !== undefined) { sql += " AND reference_id = ?"; args.push(reference_id); }

      sql += ` ORDER BY created_at DESC LIMIT ?`;
      args.push(limit || 50);

      const result = await db.execute({ sql, args });

      if (result.rows.length === 0) {
        return { content: [{ type: "text", text: "No files found." }] };
      }

      const lines = result.rows.map((r) => {
        const size = r.size_bytes ? `${(r.size_bytes / 1024).toFixed(1)}KB` : "unknown size";
        const ref = r.reference_type ? ` [${r.reference_type}:${r.reference_id}]` : "";
        return `- ${r.original_name} (${size}, ${r.mime_type || "unknown type"})${ref}\n  Key: ${r.s3_key} | ${r.created_at}`;
      });

      return { content: [{ type: "text", text: `${result.rows.length} file(s):\n\n${lines.join("\n")}` }] };
    }
  );

  // --- crow_get_file_url ---
  server.tool(
    "crow_get_file_url",
    "Get a presigned download URL for a file. A bot's URL expires in at most 5 minutes.",
    {
      s3_key: z.string().max(500).describe("S3 object key"),
      expiry: z.number().min(60).max(86400).optional().describe("URL expiry in seconds (default 3600 = 1 hour; a bot's URL is capped at 300 = 5 minutes)"),
      bucket: z.string().max(100).optional().describe("Bucket name (default: crow-files)"),
    },
    async ({ s3_key, expiry, bucket }, extra) => {
      const gate = shareGate("crow_get_file_url", extra);
      const bound = await boundByShares(gate);
      // A bot reaches only a key whose own row sits in a project it may read; an owner/unknown
      // caller resolves no row check at all and keeps today's behaviour.
      const { refusal, row } = await fileRowGate(gate, bound, s3_key, bucket);
      if (refusal) return refusal;
      if (!(await s3.isAvailable())) return notConfiguredError();

      // A bot gets the URL of the ROW's object: the bucket a row was stored in, not the default
      // one, or the presigned URL would point at a different (or missing) object.
      const targetBucket = bound && row ? row.bucket : bucket;
      const expiresIn = bound ? Math.min(expiry ?? 3600, BOT_URL_TTL_SECONDS) : expiry;
      const url = await s3.getPresignedUrl(s3_key, { bucket: targetBucket, expiry: expiresIn });
      const expiryMin = Math.round((expiresIn ?? 3600) / 60);
      return {
        content: [{ type: "text", text: `Download URL (expires in ${expiryMin} min):\n${url}` }],
      };
    }
  );

  // --- crow_delete_file ---
  server.tool(
    "crow_delete_file",
    "Permanently delete a file from storage. This cannot be undone. Returns a preview and confirmation token on first call; pass the token back to execute.",
    {
      s3_key: z.string().max(500).describe("S3 object key to delete"),
      bucket: z.string().max(100).optional().describe("Bucket name (default: crow-files)"),
      confirm_token: z.string().max(100).describe('Confirmation token — pass "" on first call to get a preview, then pass the returned token to execute'),
    },
    async ({ s3_key, bucket, confirm_token }, extra) => {
      // The gate runs on BOTH calls, and before the confirmation-gate skip: a share revoked between
      // the preview and the confirm finds nothing to delete.
      const gate = shareGate("crow_delete_file", extra);
      const bound = await boundByShares(gate);
      const { refusal, row } = await fileRowGate(gate, bound, s3_key, bucket);
      if (refusal) return refusal;
      if (!(await s3.isAvailable())) return notConfiguredError();

      if (!shouldSkipGates()) {
        if (confirm_token) {
          if (!validateToken(confirm_token, "delete_file", s3_key)) {
            return { content: [{ type: "text", text: "Invalid or expired confirmation token. Pass confirm_token: \"\" to get a new preview." }], isError: true };
          }
        } else {
          // Try to get metadata from DB
          const meta = await db.execute({ sql: "SELECT original_name, mime_type, size_bytes FROM storage_files WHERE s3_key = ?", args: [s3_key] });
          const token = generateToken("delete_file", s3_key);
          let preview;
          if (meta.rows.length > 0) {
            const f = meta.rows[0];
            const size = f.size_bytes ? `${(f.size_bytes / 1024).toFixed(1)}KB` : "unknown size";
            preview = `⚠️ This will permanently delete:\n  ${f.original_name} (${f.mime_type || "unknown type"}, ${size})\n  Key: ${s3_key}`;
          } else {
            preview = `⚠️ This will permanently delete:\n  Key: ${s3_key}\n  (No metadata available for this key)`;
          }
          return {
            content: [{
              type: "text",
              text: `${preview}\n\nThis cannot be undone.\nTo proceed, call again with confirm_token: "${token}"`,
            }],
          };
        }
      }

      // The row's own bucket (a bot never names one: the gate above refuses a bucket that is not
      // the row's, so `bucket` is either that value or absent).
      await s3.deleteObject(s3_key, (bound && row ? row.bucket : bucket) || "crow-files");
      await db.execute({ sql: "DELETE FROM storage_files WHERE s3_key = ?", args: [s3_key] });

      return { content: [{ type: "text", text: `Deleted: ${s3_key}` }] };
    }
  );

  // --- crow_storage_stats ---
  server.tool(
    "crow_storage_stats",
    "Get storage usage statistics. A bot's numbers cover its own project only.",
    {},
    async (_args, extra) => {
      const gate = shareGate("crow_storage_stats", extra);
      const pass = await gate.check(null, {});
      if (pass.isError) return pass;
      const bound = await boundByShares(gate);
      if (!(await s3.isAvailable())) return notConfiguredError();

      // A bot counts only its own project's tracked rows: the bucket-wide numbers cover every
      // project's files and are the owner's.
      if (bound) {
        const projected = scopePredicate(await gate.readScope(), { column: "project_id" });
        const totals = (await db.execute({
          sql: `SELECT COUNT(*) AS count, COALESCE(SUM(size_bytes), 0) AS total FROM storage_files WHERE 1=1${projected.sql}`,
          args: projected.args,
        })).rows[0];
        const files = Number(totals?.count || 0);
        const bytes = Number(totals?.total || 0);
        const usedMB = (bytes / 1024 / 1024).toFixed(1);
        const pct = ((bytes / (STORAGE_QUOTA_MB * 1024 * 1024)) * 100).toFixed(1);
        return {
          content: [{
            type: "text",
            text: `Storage Statistics:\n  Files: ${files}\n  Used: ${usedMB}MB / ${STORAGE_QUOTA_MB}MB (${pct}%)\n  Max upload size: ${(MAX_UPLOAD_SIZE / 1024 / 1024).toFixed(0)}MB`,
          }],
        };
      }

      const stats = await s3.getBucketStats();
      const dbResult = await db.execute("SELECT COUNT(*) as count FROM storage_files");
      const trackedFiles = dbResult.rows[0]?.count || 0;
      const usedMB = (stats.totalSizeBytes / 1024 / 1024).toFixed(1);
      const pct = ((stats.totalSizeBytes / (STORAGE_QUOTA_MB * 1024 * 1024)) * 100).toFixed(1);

      return {
        content: [{
          type: "text",
          text: `Storage Statistics:\n  Files in bucket: ${stats.fileCount}\n  Tracked in DB: ${trackedFiles}\n  Used: ${usedMB}MB / ${STORAGE_QUOTA_MB}MB (${pct}%)\n  Max upload size: ${(MAX_UPLOAD_SIZE / 1024 / 1024).toFixed(0)}MB`,
        }],
      };
    }
  );

  // --- crow_generate_background ---
  const SDXL_SERVICE_URL = process.env.SDXL_SERVICE_URL || "http://127.0.0.1:3005";

  server.tool(
    "crow_generate_background",
    "Generate a new AI background image via SDXL Turbo. The image is set as the companion's current background automatically. IMPORTANT: First generation after cold start takes 15-20s for model loading. If you get a 'loading' response, wait 30 seconds and try ONE more time. Never retry in a loop.",
    {
      prompt: z.string().max(500).describe("Description of the background scene to generate (e.g. 'cozy library at night with warm lighting')"),
      negative_prompt: z.string().max(500).optional().describe("What to avoid in the image"),
      width: z.number().min(256).max(1536).optional().describe("Image width in pixels (default 1024)"),
      height: z.number().min(256).max(1536).optional().describe("Image height in pixels (default 576)"),
    },
    async ({ prompt, negative_prompt, width, height }, extra) => {
      // Project-neutral: a bot keeps the tool, an unverified bot is refused.
      const pass = await shareGate("crow_generate_background", extra).check(null, {});
      if (pass.isError) return pass;
      try {
        // Pre-check: is the model currently loading?
        try {
          const healthResp = await fetch(`${SDXL_SERVICE_URL}/health`, { signal: AbortSignal.timeout(3000) });
          if (healthResp.ok) {
            const health = await healthResp.json();
            if (health.loading) {
              return { content: [{ type: "text", text: `The SDXL model is currently loading. Please wait 20-30 seconds and try again once. Do not retry in a loop.` }] };
            }
          }
        } catch { /* health check failed, proceed anyway */ }

        const body = { prompt };
        if (negative_prompt) body.negative_prompt = negative_prompt;
        if (width) body.width = width;
        if (height) body.height = height;

        const resp = await fetch(`${SDXL_SERVICE_URL}/generate`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(60000),
        });

        if (resp.status === 503) {
          return { content: [{ type: "text", text: "The SDXL model is loading. Please wait 20-30 seconds and try once more." }] };
        }

        if (!resp.ok) {
          const err = await resp.text();
          return { content: [{ type: "text", text: `SDXL generation failed (${resp.status}): ${err}` }], isError: true };
        }

        const result = await resp.json();
        const bgUrl = `${SDXL_SERVICE_URL}${result.url}`;

        return {
          content: [{
            type: "text",
            text: `Background generated in ${result.elapsed_seconds}s.\nPrompt: ${result.prompt}\nSize: ${result.width}x${result.height}\nURL: ${bgUrl}${result.gallery_name ? `\nSaved to gallery: ${result.gallery_name}` : ""}`,
          }],
        };
      } catch (err) {
        if (err.name === "TimeoutError" || err.name === "AbortError") {
          return { content: [{ type: "text", text: "Background generation is taking longer than expected (model may be loading for first use). Please wait 30 seconds and try once more." }] };
        }
        const msg = err.code === "ECONNREFUSED"
          ? "SDXL extension is not installed. Install it from Extensions to enable background generation."
          : `SDXL error: ${err.message}`;
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    }
  );

  // --- crow_list_backgrounds ---
  server.tool(
    "crow_list_backgrounds",
    "List previously generated background images in the gallery",
    {},
    async (_args, extra) => {
      // Project-neutral: a bot keeps the tool, an unverified bot is refused.
      const pass = await shareGate("crow_list_backgrounds", extra).check(null, {});
      if (pass.isError) return pass;
      try {
        const resp = await fetch(`${SDXL_SERVICE_URL}/gallery`);
        if (!resp.ok) {
          return { content: [{ type: "text", text: `Failed to list backgrounds: ${resp.status}` }], isError: true };
        }
        const result = await resp.json();
        if (result.backgrounds.length === 0) {
          return { content: [{ type: "text", text: "No backgrounds generated yet." }] };
        }
        const list = result.backgrounds.map(bg =>
          `- ${bg.name} (${bg.size_kb}KB, ${bg.created})`
        ).join("\n");
        return { content: [{ type: "text", text: `Generated backgrounds:\n${list}` }] };
      } catch (err) {
        const msg = err.code === "ECONNREFUSED"
          ? "SDXL service is not running."
          : `Error: ${err.message}`;
        return { content: [{ type: "text", text: msg }], isError: true };
      }
    }
  );

  // --- crow_set_background ---
  server.tool(
    "crow_set_background",
    "Set a previously generated gallery image as the current companion background",
    {
      name: z.string().max(200).describe("Gallery filename to set as current background"),
    },
    async ({ name }, extra) => {
      // Project-neutral: a bot keeps the tool, an unverified bot is refused.
      const pass = await shareGate("crow_set_background", extra).check(null, {});
      if (pass.isError) return pass;
      try {
        const resp = await fetch(`${SDXL_SERVICE_URL}/set/${encodeURIComponent(name)}`, { method: "POST" });
        if (!resp.ok) {
          const err = await resp.text();
          return { content: [{ type: "text", text: `Failed to set background: ${err}` }], isError: true };
        }
        const result = await resp.json();
        return {
          content: [{ type: "text", text: `Background set to ${result.set_from} (${result.type}).\nURL: ${SDXL_SERVICE_URL}${result.url}` }],
        };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // Note: crow_animate_background (SVD video) removed — static SDXL images
  // make better backgrounds than short looping videos. The SVD model and
  // /generate-video endpoint still exist on the SDXL service for manual use.
  //
  // Note: crow_unload_background_models removed — keeping SDXL loaded avoids
  // cold start delays (~25s). The /unload endpoint still exists on the SDXL
  // service for manual use via curl if needed.

  return server;
}
