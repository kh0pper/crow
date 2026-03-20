/**
 * Crow Tax — Dashboard Panel
 *
 * Shows tax return status, document uploads, and calculation summaries.
 * Documents tab allows uploading W-2, 1099, 1098 PDFs for ingestion.
 */

export default function taxPanel(api) {
  return {
    id: "tax",
    title: "Tax Filing",
    icon: "file-text",

    async render() {
      try {
        const returns = await api.db.execute({
          sql: "SELECT id, tax_year, filing_status, status, result, updated_at FROM tax_returns WHERE status != 'purged' ORDER BY updated_at DESC LIMIT 5",
          args: [],
        });

        // Load uploaded documents
        let documents = [];
        try {
          const docs = await api.db.execute({
            sql: "SELECT * FROM tax_documents ORDER BY uploaded_at DESC LIMIT 20",
            args: [],
          });
          documents = docs.rows;
        } catch {
          // Table may not exist yet
        }

        const activeTab = "returns"; // default tab

        // --- Returns tab ---
        let returnsHtml;
        if (returns.rows.length === 0) {
          returnsHtml = `
            <div class="panel-empty">
              <p>No tax returns found.</p>
              <p class="muted">Use <code>crow_tax_new_return</code> to start a return, or upload documents below.</p>
            </div>
          `;
        } else {
          const rows = returns.rows.map((r) => {
            const result = r.result ? JSON.parse(r.result) : null;
            const statusBadge = {
              draft: '<span class="badge badge-warning">Draft</span>',
              calculated: '<span class="badge badge-info">Calculated</span>',
              filed: '<span class="badge badge-success">Filed</span>',
            }[r.status] || `<span class="badge">${r.status}</span>`;

            const summary = result
              ? `AGI: $${result.agi.toFixed(2)} | Tax: $${result.result.totalTax.toFixed(2)} | ${result.result.refundOrOwed >= 0 ? `Refund: $${result.result.refundOrOwed.toFixed(2)}` : `Owed: $${Math.abs(result.result.refundOrOwed).toFixed(2)}`}`
              : "Not yet calculated";

            return `
              <tr>
                <td><code>${r.id}</code></td>
                <td>${r.tax_year}</td>
                <td>${r.filing_status.toUpperCase()}</td>
                <td>${statusBadge}</td>
                <td>${summary}</td>
                <td>${r.updated_at}</td>
              </tr>
            `;
          });

          returnsHtml = `
            <table class="table">
              <thead>
                <tr>
                  <th>ID</th>
                  <th>Year</th>
                  <th>Status</th>
                  <th>Filing</th>
                  <th>Summary</th>
                  <th>Updated</th>
                </tr>
              </thead>
              <tbody>${rows.join("")}</tbody>
            </table>
          `;
        }

        // --- Documents tab ---
        const docRows = documents.map((d) => {
          const statusBadge = {
            uploaded: '<span class="badge badge-warning">Uploaded</span>',
            ingested: '<span class="badge badge-info">Ingested</span>',
            confirmed: '<span class="badge badge-success">Confirmed</span>',
            error: '<span class="badge badge-danger">Error</span>',
          }[d.status] || `<span class="badge">${d.status}</span>`;

          return `
            <tr>
              <td>${d.filename || "—"}</td>
              <td>${(d.doc_type || "").toUpperCase()}</td>
              <td>${statusBadge}</td>
              <td>${d.return_id || "—"}</td>
              <td>${d.uploaded_at || "—"}</td>
            </tr>
          `;
        });

        const documentsHtml = `
          <div style="margin-bottom: 1rem;">
            <form method="POST" action="/dashboard/tax/upload" enctype="multipart/form-data" class="upload-form">
              <div style="display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap;">
                <select name="doc_type" required style="padding: 0.4rem;">
                  <option value="">Document type...</option>
                  <option value="w2">W-2</option>
                  <option value="1099-sa">1099-SA (HSA)</option>
                  <option value="1099-int">1099-INT</option>
                  <option value="1099-div">1099-DIV</option>
                  <option value="1099-nec">1099-NEC</option>
                  <option value="1099-g">1099-G</option>
                  <option value="1099-misc">1099-MISC</option>
                  <option value="1098-t">1098-T (Education)</option>
                  <option value="1098-e">1098-E (Student Loan)</option>
                  <option value="1098">1098 (Mortgage)</option>
                </select>
                <input type="file" name="document" accept=".pdf" required />
                <button type="submit" class="btn btn-sm btn-primary">Upload &amp; Ingest</button>
              </div>
            </form>
          </div>
          ${docRows.length > 0 ? `
            <table class="table">
              <thead>
                <tr>
                  <th>File</th>
                  <th>Type</th>
                  <th>Status</th>
                  <th>Return</th>
                  <th>Uploaded</th>
                </tr>
              </thead>
              <tbody>${docRows.join("")}</tbody>
            </table>
          ` : '<p class="muted">No documents uploaded yet. Upload W-2, 1099, or 1098 PDFs above.</p>'}
        `;

        return {
          html: `
            <div class="tabs" style="margin-bottom: 1rem;">
              <button class="tab-btn active" onclick="showTab('returns')">Returns</button>
              <button class="tab-btn" onclick="showTab('documents')">Documents (${documents.length})</button>
            </div>
            <div id="tab-returns" class="tab-content">${returnsHtml}</div>
            <div id="tab-documents" class="tab-content" style="display:none;">${documentsHtml}</div>
            <script>
              function showTab(name) {
                document.querySelectorAll('.tab-content').forEach(el => el.style.display = 'none');
                document.querySelectorAll('.tab-btn').forEach(el => el.classList.remove('active'));
                document.getElementById('tab-' + name).style.display = 'block';
                event.target.classList.add('active');
              }
            </script>
          `,
        };
      } catch (err) {
        return { html: `<p class="error">Error loading tax data: ${err.message}</p>` };
      }
    },
  };
}
