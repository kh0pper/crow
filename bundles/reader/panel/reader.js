/**
 * Crow's Nest Panel — Reader
 *
 * Library view: an import card (file upload / URL) and a table of
 * imported documents linking into the Read view (/reader-app/:id, served
 * by panel/routes.js). Import + Read-view HTTP surface live in that
 * companion routes file per the STRICT_PANEL_MOUNT contract; this
 * handler only renders inside the gateway's dashboard `layout()`.
 *
 * Bundle-compatible: dynamic imports resolved from $CROW_HOME/bundles/
 * reader inside try/catch — the panel renders (degraded) even if the
 * bundle modules can't load.
 */

export default {
  id: "reader",
  name: "Reader",
  icon: "book-open",
  route: "/dashboard/reader",
  navOrder: 45,
  category: "productivity",

  async handler(req, res, { db, layout, appRoot }) {
    const { pathToFileURL } = await import("node:url");
    const { join } = await import("node:path");
    const { homedir } = await import("node:os");

    const bundleDir = join(process.env.CROW_HOME || join(homedir(), ".crow"), "bundles", "reader");
    async function bundleImport(rel) {
      try {
        return await import(pathToFileURL(join(bundleDir, rel)).href);
      } catch {
        return null;
      }
    }

    const renderMod = await bundleImport("server/render.js");
    if (!renderMod) {
      const content = `
        <div class="pm-card">
          <strong>Reader bundle unavailable</strong>
          <p class="pm-muted">The reader bundle's server modules could not be loaded. Check the gateway logs and confirm ${escapeFallback(bundleDir)} is installed.</p>
        </div>`;
      res.send(layout({ title: "Reader", content }));
      return;
    }
    const { escapeHtml } = renderMod;

    // Ensure reader_* tables exist even if the MCP server hasn't started yet.
    let queriesMod = null;
    try {
      const initMod = await bundleImport("server/init-tables.js");
      if (initMod) await initMod.initReaderTables(db);
      queriesMod = await bundleImport("server/queries.js");
    } catch { /* degraded render below */ }

    let rowsHtml = "";
    if (!queriesMod) {
      rowsHtml = `<tr><td colspan="6" class="pm-muted">queries module unavailable</td></tr>`;
    } else {
      try {
        const docs = await queriesMod.listDocuments(db, {});
        rowsHtml = docs.map((d) => {
          const progress = d.progress_paragraph != null && d.total_paragraphs
            ? `${escapeHtml(String(d.progress_paragraph))}/${escapeHtml(String(d.total_paragraphs))}`
            : "&mdash;";
          const statusClass = d.extraction_status === "ok" ? "" : " pm-urgent";
          return `
            <tr>
              <td><a href="/reader-app/${Number(d.id)}" data-turbo="false">${escapeHtml(d.title || "Untitled")}</a></td>
              <td><span class="er-badge">${escapeHtml(d.source_type || "")}</span></td>
              <td class="${statusClass}"><span class="er-badge er-badge-${escapeHtml(d.extraction_status || "")}">${escapeHtml(d.extraction_status || "")}</span></td>
              <td>${progress}</td>
              <td class="pm-muted">${escapeHtml(d.tags || "")}</td>
              <td class="pm-muted">${escapeHtml((d.updated_at || "").slice(0, 16))}</td>
            </tr>`;
        }).join("");
      } catch (err) {
        rowsHtml = `<tr><td colspan="6" class="pm-muted">documents unavailable: ${escapeHtml(err.message)}</td></tr>`;
      }
    }

    const content = `
      <style>
        .er-import-card { background:var(--crow-bg-surface); border:1px solid var(--crow-border);
          border-radius:8px; padding:1rem; margin-bottom:1.5rem; }
        .er-import-forms { display:flex; flex-wrap:wrap; gap:1.5rem; }
        .er-import-form { display:flex; flex-direction:column; gap:0.5rem; min-width:260px; flex:1; }
        .er-import-form input[type="text"], .er-import-form input[type="url"], .er-import-form input[type="file"] {
          padding:0.4rem 0.6rem; border:1px solid var(--crow-border); border-radius:6px;
          background:var(--crow-bg); color:var(--crow-text); }
        .er-badge { display:inline-block; padding:0.1rem 0.5rem; border-radius:0.5rem;
          background:var(--crow-bg); border:1px solid var(--crow-border); font-size:0.75rem; }
        .er-badge-ok { background:#15803d; color:#fff; border-color:transparent; }
        .er-badge-partial { background:#b45309; color:#fff; border-color:transparent; }
        .er-badge-failed { background:#b91c1c; color:#fff; border-color:transparent; }
        .er-badge-pending { background:var(--crow-text-muted); color:#fff; border-color:transparent; }
        .pm-table { width:100%; border-collapse:collapse; margin-bottom:1.5rem; }
        .pm-table th { text-align:left; padding:0.5rem 0.75rem; border-bottom:1px solid var(--crow-border); }
        .pm-table td { padding:0.5rem 0.75rem; border-bottom:1px solid var(--crow-border); }
        .pm-muted { color:var(--crow-text-muted); font-size:0.85rem; }
        .pm-card { background:var(--crow-bg-surface); border:1px solid var(--crow-border); border-radius:8px; padding:0.75rem 1rem; margin-bottom:0.5rem; }
        .pm-btn { display:inline-block; padding:0.4rem 0.9rem; background:var(--crow-accent); color:#fff; border:none; border-radius:6px; cursor:pointer; font-size:0.85rem; text-decoration:none; }
        h3 { margin:1.25rem 0 0.5rem; }
      </style>

      <div class="er-import-card">
        <h3 style="margin-top:0">Import</h3>
        <div class="er-import-forms">
          <form class="er-import-form" id="er-file-form">
            <label for="er-file-input">File (PDF, HTML, TXT, MD)</label>
            <input type="file" id="er-file-input" name="file" required>
            <input type="text" name="title" placeholder="Title (optional)">
            <input type="text" name="tags" placeholder="Tags, comma-separated (optional)">
            <button class="pm-btn" type="submit">Import file</button>
          </form>
          <form class="er-import-form" id="er-url-form">
            <label for="er-url-input">Web page URL</label>
            <input type="url" id="er-url-input" name="url" placeholder="https://…" required>
            <input type="text" name="title" placeholder="Title (optional)">
            <input type="text" name="tags" placeholder="Tags, comma-separated (optional)">
            <button class="pm-btn" type="submit">Import URL</button>
          </form>
        </div>
        <p id="er-import-status" class="pm-muted"></p>
      </div>

      <h3>Library</h3>
      <table class="pm-table">
        <thead><tr><th>Title</th><th>Source</th><th>Status</th><th>Progress</th><th>Tags</th><th>Updated</th></tr></thead>
        <tbody>${rowsHtml || '<tr><td colspan="6" class="pm-muted" style="text-align:center;padding:2rem">No documents yet. Import a file or URL above.</td></tr>'}</tbody>
      </table>

      <script>
        (function () {
          const statusEl = document.getElementById('er-import-status');

          async function submitImport(body, isMultipart) {
            statusEl.textContent = 'Importing…';
            try {
              const res = await fetch('/api/reader/import', {
                method: 'POST',
                headers: isMultipart ? undefined : { 'Content-Type': 'application/json' },
                body,
              });
              const data = await res.json();
              if (!res.ok) {
                statusEl.textContent = 'Failed: ' + (data.error || res.status);
                return;
              }
              statusEl.textContent = 'Imported (status: ' + data.extraction_status + ')';
              setTimeout(() => location.reload(), 800);
            } catch (e) {
              statusEl.textContent = 'Error: ' + e.message;
            }
          }

          const fileForm = document.getElementById('er-file-form');
          fileForm.addEventListener('submit', (ev) => {
            ev.preventDefault();
            submitImport(new FormData(fileForm), true);
          });

          const urlForm = document.getElementById('er-url-form');
          urlForm.addEventListener('submit', (ev) => {
            ev.preventDefault();
            const fd = new FormData(urlForm);
            submitImport(JSON.stringify({
              url: fd.get('url'), title: fd.get('title') || null, tags: fd.get('tags') || null,
            }), false);
          });
        })();
      </script>`;

    res.send(layout({ title: "Reader", content }));
  },
};

function escapeFallback(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
