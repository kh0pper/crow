/**
 * Files Panel — Card-based file manager with drag-and-drop upload
 */

import { escapeHtml, section, formatDate, formatBytes, badge } from "../shared/components.js";
import { ICON_INTEGRATIONS } from "../shared/empty-state-icons.js";
import { t, tJs } from "../shared/i18n.js";

function mimeIcon(mime) {
  if (!mime) return "\u{1F4C1}";
  if (mime.startsWith("image/")) return "\u{1F5BC}\uFE0F";
  if (mime === "application/pdf") return "\u{1F4C4}";
  if (mime.startsWith("video/")) return "\u{1F3AC}";
  if (mime.startsWith("audio/")) return "\u{1F3B5}";
  return "\u{1F4C1}";
}

function mimeCategory(mime) {
  if (!mime) return "other";
  if (mime.startsWith("image/")) return "image";
  if (mime.startsWith("video/")) return "document";
  if (mime.startsWith("audio/")) return "document";
  if (mime === "application/pdf") return "document";
  if (mime.startsWith("text/")) return "document";
  if (mime.includes("spreadsheet") || mime.includes("document") || mime.includes("presentation")) return "document";
  return "other";
}

function fileUrl(file) {
  return file.reference_type === "blog_post"
    ? `/blog/media/${file.s3_key}`
    : `/storage/file/${file.s3_key}`;
}

export default {
  id: "files",
  name: "Files",
  icon: "files",
  route: "/dashboard/files",
  navOrder: 30,
  category: "tools",

  async handler(req, res, { db, layout, lang }) {
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
        res.redirectAfterPost("/dashboard/files");
        return;
      }
    }

    // Get file stats
    const totalResult = await db.execute("SELECT COUNT(*) as c, COALESCE(SUM(size_bytes), 0) as total_size FROM storage_files");
    const total = totalResult.rows[0]?.c || 0;
    const totalSize = totalResult.rows[0]?.total_size || 0;

    const imageResult = await db.execute("SELECT COUNT(*) as c FROM storage_files WHERE mime_type LIKE 'image/%'");
    const imageCount = imageResult.rows[0]?.c || 0;

    // Check S3 availability
    let storageOnline = false;
    try {
      const { isAvailable } = await import("../../../storage/s3-client.js");
      storageOnline = await isAvailable();
    } catch {}

    const quotaMb = parseInt(process.env.STORAGE_QUOTA_MB || "5120", 10);
    const usedPct = quotaMb > 0 ? parseFloat(((totalSize / (quotaMb * 1024 * 1024)) * 100).toFixed(1)) : 0;

    // Color-coded quota bar
    const quotaColor = usedPct >= 95 ? "#e74c3c" : usedPct >= 80 ? "#f39c12" : "linear-gradient(90deg, #10b981, #22c55e)";
    const quotaWarning = usedPct >= 95
      ? `<div style="color:#e74c3c;font-size:0.85rem;margin-top:0.5rem;font-weight:500">${t("files.storageCriticallyFull", lang)}</div>`
      : usedPct >= 80
        ? `<div style="color:#f39c12;font-size:0.85rem;margin-top:0.5rem">${t("files.storageUsageHigh", lang)}</div>`
        : "";
    const quotaBar = quotaMb > 0 ? `<div style="margin-top:0.75rem">
      <div style="display:flex;justify-content:space-between;font-size:0.8rem;color:var(--crow-text-muted);margin-bottom:0.35rem">
        <span>${t("files.storageQuota", lang)}</span>
        <span>${formatBytes(totalSize)} / ${quotaMb >= 1024 ? (quotaMb / 1024).toFixed(1) + " GB" : quotaMb + " MB"} (${usedPct}%)</span>
      </div>
      <div style="background:var(--crow-border);border-radius:4px;height:8px;overflow:hidden">
        <div style="width:${Math.min(usedPct, 100)}%;height:100%;background:${quotaColor};border-radius:4px;transition:width 0.3s"></div>
      </div>
      ${quotaWarning}
    </div>` : "";

    // Filter by type
    const typeFilter = req.query?.type || "";
    let whereClause = "";
    if (typeFilter === "image") {
      whereClause = "WHERE mime_type LIKE 'image/%'";
    } else if (typeFilter === "document") {
      whereClause = "WHERE (mime_type LIKE 'text/%' OR mime_type LIKE 'application/pdf' OR mime_type LIKE '%document%' OR mime_type LIKE '%spreadsheet%' OR mime_type LIKE '%presentation%' OR mime_type LIKE 'video/%' OR mime_type LIKE 'audio/%')";
    } else if (typeFilter === "other") {
      whereClause = "WHERE mime_type NOT LIKE 'image/%' AND mime_type NOT LIKE 'text/%' AND mime_type NOT LIKE 'application/pdf' AND mime_type NOT LIKE '%document%' AND mime_type NOT LIKE '%spreadsheet%' AND mime_type NOT LIKE '%presentation%' AND mime_type NOT LIKE 'video/%' AND mime_type NOT LIKE 'audio/%'";
    }

    const files = await db.execute({
      sql: `SELECT s3_key, original_name, mime_type, size_bytes, bucket, reference_type, created_at FROM storage_files ${whereClause} ORDER BY created_at DESC LIMIT 100`,
      args: [],
    });

    // Filter tabs
    const filterStyle = (active) => active
      ? "color:var(--crow-accent);font-weight:600;text-decoration:none;padding:0.25rem 0.5rem;border-bottom:2px solid var(--crow-accent)"
      : "color:var(--crow-text-muted);text-decoration:none;padding:0.25rem 0.5rem;border-bottom:2px solid transparent";

    const filterTabs = `<div style="display:flex;gap:1rem;margin-bottom:1rem;font-size:0.85rem;border-bottom:1px solid var(--crow-border);padding-bottom:0">
      <a href="/dashboard/files" style="${filterStyle(typeFilter === "")}">${t("files.all", lang)}</a>
      <a href="/dashboard/files?type=image" style="${filterStyle(typeFilter === "image")}">${t("files.images", lang)}</a>
      <a href="/dashboard/files?type=document" style="${filterStyle(typeFilter === "document")}">${t("files.documents", lang)}</a>
      <a href="/dashboard/files?type=other" style="${filterStyle(typeFilter === "other")}">${t("files.other", lang)}</a>
    </div>`;

    // File grid
    let fileGrid;
    if (files.rows.length === 0) {
      if (storageOnline) {
        fileGrid = `<div class="empty-state">
          <div style="margin-bottom:1rem">${ICON_INTEGRATIONS}</div>
          <h3>${t("files.noFilesYet", lang)}</h3>
          <p>${t("files.uploadHint", lang)}</p>
        </div>`;
      } else {
        fileGrid = `<div class="empty-state">
          <div style="margin-bottom:1rem">${ICON_INTEGRATIONS}</div>
          <h3>${t("files.storageNotConfigured", lang)}</h3>
          <p>Set up MinIO to start storing files. Add <code>MINIO_ENDPOINT</code> to your <code>.env</code> to get started.</p>
        </div>`;
      }
    } else {
      const cards = files.rows.map((f) => {
        const url = fileUrl(f);
        const isImage = f.mime_type && f.mime_type.startsWith("image/");
        const icon = mimeIcon(f.mime_type);
        const size = formatBytes(f.size_bytes);
        const cat = mimeCategory(f.mime_type);
        const catLabel = cat === "image" ? t("files.imageCategory", lang) : cat === "document" ? t("files.docCategory", lang) : t("files.fileCategory", lang);

        const thumb = isImage
          ? `<img src="${escapeHtml(url)}" alt="${escapeHtml(f.original_name)}" loading="lazy">`
          : `<span class="icon">${icon}</span>`;

        const refBadge = f.reference_type === "blog_post"
          ? `<span style="display:inline-block;font-size:0.65rem;padding:0.1rem 0.4rem;border-radius:4px;background:var(--crow-accent);color:#fff;margin-left:0.25rem">${t("files.blogBadge", lang)}</span>`
          : f.reference_type === "shared"
            ? `<span style="display:inline-block;font-size:0.65rem;padding:0.1rem 0.4rem;border-radius:4px;background:#6366f1;color:#fff;margin-left:0.25rem">${t("files.sharedBadge", lang)}</span>`
            : f.reference_type
              ? `<span style="display:inline-block;font-size:0.65rem;padding:0.1rem 0.4rem;border-radius:4px;background:var(--crow-text-muted);color:#fff;margin-left:0.25rem">${escapeHtml(f.reference_type)}</span>`
              : "";

        const typeBadge = `<span style="display:inline-block;font-size:0.65rem;padding:0.1rem 0.4rem;border-radius:4px;background:var(--crow-border);color:var(--crow-text-muted)">${escapeHtml(catLabel)}</span>`;

        const escapedUrl = escapeHtml(url);
        const escapedName = escapeHtml(f.original_name || f.s3_key);
        const escapedKey = escapeHtml(f.s3_key);

        return `<div class="file-card">
          <div class="file-thumb">${thumb}</div>
          <div class="file-info">
            <div class="file-name" title="${escapedName}">${escapedName}</div>
            <div class="file-meta">
              ${typeBadge}${refBadge}
              <span style="margin-left:0.25rem">${escapeHtml(size)}</span>
            </div>
            <div class="file-meta" style="margin-top:0.25rem">${escapeHtml(formatDate(f.created_at, lang))}</div>
          </div>
          <div class="file-actions">
            <button class="btn btn-sm btn-secondary" onclick="navigator.clipboard.writeText('${escapedUrl}').then(function(){this.textContent='${tJs("files.copied", lang)}'}.bind(this))" title="${t("files.copyUrl", lang)}">${t("files.copyUrl", lang)}</button>
            <form method="POST" style="display:inline" onsubmit="return confirm('${tJs("common.delete", lang)} ${escapedName}?')">
              <input type="hidden" name="action" value="delete">
              <input type="hidden" name="s3_key" value="${escapedKey}">
              <button class="btn btn-sm btn-danger" type="submit">${t("files.deleteFile", lang)}</button>
            </form>
          </div>
        </div>`;
      });

      fileGrid = `<div class="file-grid">${cards.join("")}</div>`;
    }

    // Upload zone (only if storage is online)
    let uploadZone = "";
    if (storageOnline) {
      uploadZone = `<div id="upload-zone" style="border:2px dashed var(--crow-border);border-radius:12px;padding:2rem;text-align:center;cursor:pointer;transition:border-color 0.2s,background 0.2s">
  <div style="font-size:1.5rem;margin-bottom:0.5rem">${t("files.dropFilesHere", lang)}</div>
  <div style="color:var(--crow-text-muted);font-size:0.9rem;margin-bottom:1rem">${t("files.orClickBrowse", lang)}</div>
  <input type="file" id="file-input" multiple style="display:none">
  <div style="display:flex;gap:0.75rem;justify-content:center;align-items:center;flex-wrap:wrap">
    <select id="upload-ref-type" style="padding:0.4rem 0.75rem;border:1px solid var(--crow-border);border-radius:6px;background:var(--crow-bg);color:var(--crow-text);font-size:0.85rem">
      <option value="">${t("files.general", lang)}</option>
      <option value="blog_post">${t("files.blogMedia", lang)}</option>
      <option value="shared">${t("files.sharedFile", lang)}</option>
    </select>
  </div>
  <div id="upload-progress" style="margin-top:1rem;display:none"></div>
</div>`;
    }

    const gridStyles = `<style>
.file-grid { display:grid; grid-template-columns:repeat(auto-fill, minmax(200px, 1fr)); gap:1rem; }
.file-card { background:var(--crow-bg-card,var(--crow-surface)); border:1px solid var(--crow-border); border-radius:8px; overflow:hidden; transition:transform 0.15s; }
.file-card:hover { transform:translateY(-2px); }
.file-thumb { height:120px; background:var(--crow-bg-elevated,#1a1a2e); display:flex; align-items:center; justify-content:center; overflow:hidden; }
.file-thumb img { width:100%; height:100%; object-fit:cover; }
.file-thumb .icon { font-size:2.5rem; opacity:0.4; }
.file-info { padding:0.75rem; }
.file-name { font-size:0.85rem; font-weight:500; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; margin-bottom:0.25rem; }
.file-meta { font-size:0.75rem; color:var(--crow-text-muted); font-family:'JetBrains Mono',monospace; }
.file-actions { display:flex; gap:0.25rem; padding:0 0.75rem 0.75rem; }
</style>`;

    const uploadScript = storageOnline ? `<script>
(function() {
  var zone = document.getElementById('upload-zone');
  var input = document.getElementById('file-input');
  var progress = document.getElementById('upload-progress');
  var refType = document.getElementById('upload-ref-type');

  zone.addEventListener('click', function(e) { if (e.target.tagName !== 'SELECT' && e.target.tagName !== 'OPTION') input.click(); });
  zone.addEventListener('dragover', function(e) { e.preventDefault(); zone.style.borderColor = 'var(--crow-accent)'; zone.style.background = 'var(--crow-accent-muted,rgba(255,255,255,0.03))'; });
  zone.addEventListener('dragleave', function() { zone.style.borderColor = ''; zone.style.background = ''; });
  zone.addEventListener('drop', function(e) {
    e.preventDefault();
    zone.style.borderColor = '';
    zone.style.background = '';
    uploadFiles(e.dataTransfer.files);
  });
  input.addEventListener('change', function() { uploadFiles(this.files); });

  function uploadFiles(files) {
    if (!files || files.length === 0) return;
    progress.style.display = 'block';
    progress.style.color = '';
    progress.textContent = 'Uploading ' + files.length + ' file(s)...';

    var promises = Array.from(files).map(function(file) {
      var fd = new FormData();
      fd.append('file', file);
      if (refType.value) fd.append('reference_type', refType.value);
      return fetch('/storage/upload', { method: 'POST', body: fd })
        .then(function(r) { return r.json(); })
        .then(function(d) { return d.error ? Promise.reject(d.error) : d; });
    });

    Promise.all(promises).then(function() {
      progress.style.color = 'var(--crow-success,#22c55e)';
      progress.textContent = 'Uploaded! Refreshing...';
      setTimeout(function() { location.reload(); }, 1000);
    }).catch(function(err) {
      progress.style.color = 'var(--crow-error,#ef4444)';
      progress.textContent = 'Upload failed: ' + (err.message || err);
    });
  }
})();
<\/script>` : "";

    const content = `
      ${gridStyles}
      ${quotaBar}
      ${uploadZone ? section(t("files.upload", lang), uploadZone, { delay: 150 }) : ""}
      ${section(t("files.filesSection", lang), filterTabs + fileGrid, { delay: 200 })}
      ${uploadScript}
    `;

    return layout({ title: t("files.pageTitle", lang), content });
  },
};
