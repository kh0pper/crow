/**
 * Crow Storage MCP Server
 *
 * S3-compatible file storage with MinIO. Provides tools for uploading,
 * listing, downloading (presigned URLs), and deleting files.
 *
 * Factory function: createStorageServer(dbPath?)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createDbClient } from "../db.js";
import {
  isAvailable,
  uploadObject,
  getPresignedUrl,
  getPresignedUploadUrl,
  deleteObject,
  getBucketStats,
  isAllowedMimeType,
} from "./s3-client.js";

const MAX_BASE64_SIZE = 1 * 1024 * 1024; // 1MB for base64 uploads
const MAX_UPLOAD_SIZE = parseInt(process.env.MAX_UPLOAD_SIZE || "104857600", 10); // 100MB
const STORAGE_QUOTA_MB = parseInt(process.env.STORAGE_QUOTA_MB || "5120", 10); // 5GB

function notConfiguredError() {
  return {
    content: [{
      type: "text",
      text: "Storage is not configured. To set up MinIO storage:\n\n1. Add to your .env:\n   MINIO_ENDPOINT=localhost\n   MINIO_ROOT_PASSWORD=your-secure-password\n\n2. Start MinIO:\n   docker compose --profile storage up -d\n\n3. Restart your MCP client.",
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

  // --- crow_upload_file ---
  server.tool(
    "crow_upload_file",
    "Upload a small file (base64, <1MB) or get an HTTP upload URL for larger files",
    {
      file_name: z.string().max(500).describe("Original file name"),
      mime_type: z.string().max(200).optional().describe("MIME type (e.g. image/png)"),
      data_base64: z.string().max(1500000).optional().describe("Base64-encoded file data (for files <1MB)"),
      bucket: z.string().max(100).optional().describe("Target bucket (default: crow-files)"),
      reference_type: z.string().max(100).optional().describe("What this file is attached to (e.g. blog_post, research_source)"),
      reference_id: z.number().optional().describe("ID of the referenced item"),
    },
    async ({ file_name, mime_type, data_base64, bucket, reference_type, reference_id }) => {
      if (!(await isAvailable())) return notConfiguredError();

      if (mime_type && !isAllowedMimeType(mime_type)) {
        return {
          content: [{ type: "text", text: `Blocked: executable MIME type "${mime_type}" is not allowed.` }],
          isError: true,
        };
      }

      // Check quota
      const stats = await getBucketStats(bucket);
      const quotaBytes = STORAGE_QUOTA_MB * 1024 * 1024;
      if (stats.totalSizeBytes >= quotaBytes) {
        return {
          content: [{ type: "text", text: `Storage quota exceeded (${STORAGE_QUOTA_MB}MB). Delete files to free space.` }],
          isError: true,
        };
      }

      const timestamp = Date.now();
      const s3Key = `${timestamp}-${file_name.replace(/[^a-zA-Z0-9._-]/g, "_")}`;

      if (data_base64) {
        // Direct base64 upload (small files only)
        const buffer = Buffer.from(data_base64, "base64");
        if (buffer.length > MAX_BASE64_SIZE) {
          return {
            content: [{ type: "text", text: `File too large for base64 upload (${(buffer.length / 1024 / 1024).toFixed(1)}MB). Use the HTTP upload endpoint POST /storage/upload for files >1MB.` }],
            isError: true,
          };
        }

        await uploadObject(s3Key, buffer, { bucket, contentType: mime_type });

        // Record in database
        await db.execute({
          sql: `INSERT INTO storage_files (s3_key, original_name, mime_type, size_bytes, bucket, reference_type, reference_id)
                VALUES (?, ?, ?, ?, ?, ?, ?)`,
          args: [s3Key, file_name, mime_type || null, buffer.length, bucket || "crow-files", reference_type || null, reference_id || null],
        });

        const url = await getPresignedUrl(s3Key, { bucket });
        return {
          content: [{ type: "text", text: `Uploaded "${file_name}" (${(buffer.length / 1024).toFixed(1)}KB)\nKey: ${s3Key}\nDownload URL (1hr): ${url}` }],
        };
      } else {
        // Return presigned upload URL for larger files
        const uploadUrl = await getPresignedUploadUrl(s3Key, { bucket });

        // Pre-register in database (size will be updated after upload)
        await db.execute({
          sql: `INSERT INTO storage_files (s3_key, original_name, mime_type, size_bytes, bucket, reference_type, reference_id)
                VALUES (?, ?, ?, 0, ?, ?, ?)`,
          args: [s3Key, file_name, mime_type || null, bucket || "crow-files", reference_type || null, reference_id || null],
        });

        return {
          content: [{ type: "text", text: `Upload URL generated for "${file_name}":\n\nPUT ${uploadUrl}\n\nContent-Type: ${mime_type || "application/octet-stream"}\nMax size: ${(MAX_UPLOAD_SIZE / 1024 / 1024).toFixed(0)}MB\nExpires in 1 hour.\n\nAlternatively, use POST /storage/upload with multipart form data.` }],
        };
      }
    }
  );

  // --- crow_list_files ---
  server.tool(
    "crow_list_files",
    "List stored files with optional filtering",
    {
      bucket: z.string().max(100).optional().describe("Filter by bucket"),
      mime_type: z.string().max(200).optional().describe("Filter by MIME type prefix (e.g. image/)"),
      reference_type: z.string().max(100).optional().describe("Filter by reference type"),
      reference_id: z.number().optional().describe("Filter by reference ID"),
      limit: z.number().min(1).max(100).optional().describe("Max results (default 50)"),
    },
    async ({ bucket, mime_type, reference_type, reference_id, limit }) => {
      if (!(await isAvailable())) return notConfiguredError();

      let sql = "SELECT id, s3_key, original_name, mime_type, size_bytes, bucket, reference_type, reference_id, created_at FROM storage_files WHERE 1=1";
      const args = [];

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
    "Get a presigned download URL for a file",
    {
      s3_key: z.string().max(500).describe("S3 object key"),
      expiry: z.number().min(60).max(86400).optional().describe("URL expiry in seconds (default 3600 = 1 hour)"),
      bucket: z.string().max(100).optional().describe("Bucket name (default: crow-files)"),
    },
    async ({ s3_key, expiry, bucket }) => {
      if (!(await isAvailable())) return notConfiguredError();

      const url = await getPresignedUrl(s3_key, { bucket, expiry });
      const expiryMin = Math.round((expiry || 3600) / 60);
      return {
        content: [{ type: "text", text: `Download URL (expires in ${expiryMin} min):\n${url}` }],
      };
    }
  );

  // --- crow_delete_file ---
  server.tool(
    "crow_delete_file",
    "Delete a file from storage",
    {
      s3_key: z.string().max(500).describe("S3 object key to delete"),
      bucket: z.string().max(100).optional().describe("Bucket name (default: crow-files)"),
    },
    async ({ s3_key, bucket }) => {
      if (!(await isAvailable())) return notConfiguredError();

      await deleteObject(s3_key, bucket || "crow-files");
      await db.execute({ sql: "DELETE FROM storage_files WHERE s3_key = ?", args: [s3_key] });

      return { content: [{ type: "text", text: `Deleted: ${s3_key}` }] };
    }
  );

  // --- crow_storage_stats ---
  server.tool(
    "crow_storage_stats",
    "Get storage usage statistics",
    {},
    async () => {
      if (!(await isAvailable())) return notConfiguredError();

      const stats = await getBucketStats();
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

  return server;
}
