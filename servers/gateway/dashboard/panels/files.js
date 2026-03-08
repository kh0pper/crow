/**
 * Files Panel — File browser, upload, delete, copy URL
 */

import { escapeHtml, statCard, statGrid, dataTable, section, formatDate, formatBytes, badge, actionBar } from "../shared/components.js";

export default {
  id: "files",
  name: "Files",
  icon: "files",
  route: "/dashboard/files",
  navOrder: 30,

  async handler(req, res, { db, layout }) {
    // Handle POST actions
    if (req.method === "POST") {
      const { action } = req.body;

      if (action === "delete") {
        const { s3_key } = req.body;
        // Delete from DB (S3 deletion handled via MCP tool or direct S3 call)
        await db.execute({ sql: "DELETE FROM storage_files WHERE s3_key = ?", args: [s3_key] });
        try {
          const { deleteObject } = await import("../../../storage/s3-client.js");
          await deleteObject(s3_key);
        } catch {
          // S3 might not be available
        }
        res.redirect("/dashboard/files");
        return;
      }
    }

    // Get file stats
    const totalResult = await db.execute("SELECT COUNT(*) as c, COALESCE(SUM(size_bytes), 0) as total_size FROM storage_files");
    const total = totalResult.rows[0]?.c || 0;
    const totalSize = totalResult.rows[0]?.total_size || 0;

    // Check S3 availability
    let storageOnline = false;
    try {
      const { isAvailable } = await import("../../../storage/s3-client.js");
      storageOnline = await isAvailable();
    } catch {}

    const quotaMb = parseInt(process.env.STORAGE_QUOTA_MB || "5120", 10);
    const usedPct = quotaMb > 0 ? ((totalSize / (quotaMb * 1024 * 1024)) * 100).toFixed(1) : 0;

    const stats = statGrid([
      statCard("Files", total, { delay: 0 }),
      statCard("Used", formatBytes(totalSize), { delay: 50 }),
      statCard("Quota", `${usedPct}%`, { delay: 100 }),
      statCard("Storage", storageOnline ? "Online" : "Offline", { delay: 150 }),
    ]);

    // File list
    const files = await db.execute({
      sql: "SELECT s3_key, original_name, mime_type, size_bytes, bucket, reference_type, created_at FROM storage_files ORDER BY created_at DESC LIMIT 100",
      args: [],
    });

    let fileTable;
    if (files.rows.length === 0) {
      const msg = storageOnline
        ? "No files uploaded yet. Use <code>crow_upload_file</code> or <code>POST /storage/upload</code>."
        : "Storage is not configured. Set <code>MINIO_ENDPOINT</code> in your <code>.env</code> to enable file storage.";
      fileTable = `<div class="empty-state"><h3>No files</h3><p>${msg}</p></div>`;
    } else {
      const rows = files.rows.map((f) => {
        const size = formatBytes(f.size_bytes);
        const ref = f.reference_type ? badge(f.reference_type, "connected") : "";
        const deleteBtn = `<form method="POST" style="display:inline" onsubmit="return confirm('Delete ${escapeHtml(f.original_name)}?')">
          <input type="hidden" name="action" value="delete">
          <input type="hidden" name="s3_key" value="${escapeHtml(f.s3_key)}">
          <button class="btn btn-sm btn-danger" type="submit">Delete</button>
        </form>`;
        const copyBtn = `<button class="btn btn-sm btn-secondary" onclick="navigator.clipboard.writeText('/storage/file/${escapeHtml(f.s3_key)}').then(()=>this.textContent='Copied!')">Copy URL</button>`;

        return [
          escapeHtml(f.original_name),
          `<span class="mono">${escapeHtml(f.mime_type || "unknown")}</span>`,
          `<span class="mono">${size}</span>`,
          ref,
          `<span class="mono">${formatDate(f.created_at)}</span>`,
          `${copyBtn} ${deleteBtn}`,
        ];
      });
      fileTable = dataTable(["Name", "Type", "Size", "Ref", "Date", "Actions"], rows);
    }

    // Upload form (only if storage is online)
    let uploadForm = "";
    if (storageOnline) {
      uploadForm = `<form method="POST" action="/storage/upload" enctype="multipart/form-data">
        <div style="display:flex;gap:1rem;align-items:end">
          <div style="flex:1">
            <label style="display:block;font-size:0.8rem;color:var(--crow-text-muted);margin-bottom:0.35rem;text-transform:uppercase;letter-spacing:0.05em">File</label>
            <input type="file" name="file" required style="padding:0.4rem">
          </div>
          <button type="submit" class="btn btn-primary">Upload</button>
        </div>
      </form>`;
    }

    const content = `
      ${stats}
      ${uploadForm ? section("Upload", uploadForm, { delay: 150 }) : ""}
      ${section("Files", fileTable, { delay: 200 })}
    `;

    return layout({ title: "Files", content });
  },
};
