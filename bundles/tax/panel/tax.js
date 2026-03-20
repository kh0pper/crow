/**
 * Crow Tax — Dashboard Panel
 *
 * Full tax filing panel with:
 * - Returns list with status and summary
 * - Document upload with PDF ingestion
 * - Extracted value verification with edit capability
 *
 * Uses handler pattern for Express req/res access.
 */

export default {
  id: "tax",
  name: "Tax Filing",
  icon: "file-text",
  route: "/dashboard/tax",
  navOrder: 40,

  async handler(req, res, { db, layout, appRoot }) {
    const { pathToFileURL } = await import("node:url");
    const { join } = await import("node:path");
    const { escapeHtml, badge } = await import(
      pathToFileURL(join(appRoot, "servers/gateway/dashboard/shared/components.js")).href
    );

    // --- Load data ---
    let returns = [];
    try {
      const r = await db.execute({
        sql: "SELECT id, tax_year, filing_status, status, result, updated_at FROM tax_returns WHERE status != 'purged' ORDER BY updated_at DESC LIMIT 10",
        args: [],
      });
      returns = r.rows;
    } catch {}

    let documents = [];
    try {
      const d = await db.execute({
        sql: "SELECT * FROM tax_documents ORDER BY uploaded_at DESC LIMIT 20",
        args: [],
      });
      documents = d.rows;
    } catch {}

    const tab = req.query.tab || "returns";

    // --- Returns tab ---
    let returnsContent;
    if (returns.length === 0) {
      returnsContent = `
        <div class="empty-state" style="padding: 2rem; text-align: center; color: var(--text-muted);">
          <p style="font-size: 1.1rem;">No tax returns yet</p>
          <p>Upload your W-2s and other tax documents in the <a href="/dashboard/tax?tab=documents">Documents</a> tab, then ask Crow to prepare your return.</p>
        </div>
      `;
    } else {
      const rows = returns.map((r) => {
        const result = r.result ? JSON.parse(r.result) : null;
        const statusMap = {
          draft: badge("Draft", "warning"),
          calculated: badge("Calculated", "info"),
          filed: badge("Filed", "success"),
        };
        const statusBadge = statusMap[r.status] || badge(r.status);

        let summary = '<span style="color:var(--text-muted)">Not calculated</span>';
        if (result) {
          const refund = result.result.refundOrOwed;
          summary = `AGI: $${result.agi.toLocaleString(undefined, {minimumFractionDigits: 2})} &middot; ` +
            (refund >= 0
              ? `<strong style="color:var(--success)">Refund: $${refund.toFixed(2)}</strong>`
              : `<strong style="color:var(--danger)">Owed: $${Math.abs(refund).toFixed(2)}</strong>`);
        }

        return `<tr>
          <td><code>${escapeHtml(r.id)}</code></td>
          <td>${r.tax_year}</td>
          <td>${escapeHtml(r.filing_status.toUpperCase())}</td>
          <td>${statusBadge}</td>
          <td>${summary}</td>
          <td>${escapeHtml(r.updated_at || "")}</td>
        </tr>`;
      });

      returnsContent = `
        <table class="table">
          <thead><tr><th>ID</th><th>Year</th><th>Filing</th><th>Status</th><th>Summary</th><th>Updated</th></tr></thead>
          <tbody>${rows.join("")}</tbody>
        </table>
      `;
    }

    // --- Documents tab ---
    const uploadForm = `
      <form method="POST" action="/api/tax/upload" enctype="multipart/form-data" style="margin-bottom:1.5rem; padding:1rem; border:1px dashed var(--border); border-radius:8px;">
        <div style="display:flex; gap:0.5rem; align-items:center; flex-wrap:wrap;">
          <select name="doc_type" required style="padding:0.4rem 0.6rem; border:1px solid var(--border); border-radius:4px; background:var(--bg);">
            <option value="">Document type...</option>
            <optgroup label="Income">
              <option value="w2">W-2</option>
              <option value="1099-sa">1099-SA (HSA)</option>
              <option value="1099-int">1099-INT (Interest)</option>
              <option value="1099-div">1099-DIV (Dividends)</option>
              <option value="1099-nec">1099-NEC (Self-employment)</option>
              <option value="1099-g">1099-G (Government)</option>
              <option value="1099-misc">1099-MISC</option>
            </optgroup>
            <optgroup label="Deductions &amp; Credits">
              <option value="1098-t">1098-T (Education)</option>
              <option value="1098-e">1098-E (Student Loan)</option>
              <option value="1098">1098 (Mortgage)</option>
            </optgroup>
          </select>
          <select name="owner" style="padding:0.4rem 0.6rem; border:1px solid var(--border); border-radius:4px; background:var(--bg);">
            <option value="taxpayer">Taxpayer</option>
            <option value="spouse">Spouse</option>
            <option value="joint">Joint/Shared</option>
          </select>
          <input type="file" name="document" accept=".pdf" required style="flex:1;" />
          <button type="submit" class="btn btn-primary">Upload &amp; Extract</button>
        </div>
        <p style="margin:0.5rem 0 0; font-size:0.85rem; color:var(--text-muted);">
          Upload a PDF — Crow will extract the values and ask you to verify before adding to your return.
        </p>
      </form>
    `;

    let docsContent;
    if (documents.length === 0) {
      docsContent = `
        ${uploadForm}
        <div class="empty-state" style="padding:2rem; text-align:center; color:var(--text-muted);">
          <p>No documents uploaded yet.</p>
          <p>Upload your W-2, 1099, or 1098 PDFs above.</p>
        </div>
      `;
    } else {
      const docCards = documents.map((d) => {
        const statusMap = {
          uploaded: badge("Uploaded", "warning"),
          ingested: badge("Review", "info"),
          confirmed: badge("Confirmed", "success"),
          error: badge("Error", "danger"),
        };
        const statusBadge = statusMap[d.status] || badge(d.status);
        const extracted = d.extracted_data ? JSON.parse(d.extracted_data) : null;
        const warnings = d.warnings ? JSON.parse(d.warnings) : [];
        const confidence = d.confidence ? JSON.parse(d.confidence) : {};

        // W-2 field labels for display
        const w2Labels = {
          employer: "Employer name", ein: "EIN", wages: "Box 1 — Wages",
          federalWithheld: "Box 2 — Federal tax withheld",
          ssWages: "Box 3 — Social security wages", ssTaxWithheld: "Box 4 — SS tax withheld",
          medicareWages: "Box 5 — Medicare wages", medicareTaxWithheld: "Box 6 — Medicare tax",
          stateWages: "Box 16 — State wages", stateWithheld: "Box 17 — State tax",
          code12: "Box 12 — Codes",
        };
        const docLabels = (d.doc_type || "").startsWith("w2") ? w2Labels : {};

        // Define which fields to show based on document type
        const fieldDefs = {
          w2: [
            { key: "employer", label: "Employer name", type: "text" },
            { key: "ein", label: "EIN", type: "text" },
            { key: "wages", label: "Box 1 — Wages", type: "number" },
            { key: "federalWithheld", label: "Box 2 — Federal tax withheld", type: "number" },
            { key: "ssWages", label: "Box 3 — Social security wages", type: "number" },
            { key: "ssTaxWithheld", label: "Box 4 — SS tax withheld", type: "number" },
            { key: "medicareWages", label: "Box 5 — Medicare wages", type: "number" },
            { key: "medicareTaxWithheld", label: "Box 6 — Medicare tax", type: "number" },
            { key: "stateWages", label: "Box 16 — State wages", type: "number" },
            { key: "stateWithheld", label: "Box 17 — State tax", type: "number" },
          ],
          "1099-sa": [
            { key: "payer", label: "Payer/Trustee", type: "text" },
            { key: "grossDistribution", label: "Box 1 — Gross distribution", type: "number" },
            { key: "distributionCode", label: "Box 3 — Distribution code", type: "text" },
          ],
          "1098-t": [
            { key: "institution", label: "Institution", type: "text" },
            { key: "studentName", label: "Student name", type: "text" },
            { key: "tuitionPaid", label: "Box 1 — Tuition paid", type: "number" },
            { key: "scholarships", label: "Box 5 — Scholarships", type: "number" },
          ],
          "1098-e": [
            { key: "lender", label: "Lender", type: "text" },
            { key: "interest", label: "Box 1 — Student loan interest", type: "number" },
          ],
          "1098": [
            { key: "lender", label: "Lender", type: "text" },
            { key: "interest", label: "Box 1 — Mortgage interest", type: "number" },
          ],
        };
        const fields = fieldDefs[d.doc_type] || Object.keys(extracted || {}).map(k => ({ key: k, label: k, type: typeof extracted[k] === "number" ? "number" : "text" }));

        let detailHtml = "";
        if ((d.status === "ingested" || d.status === "uploaded") && extracted) {
          const warningHtml = warnings.length > 0
            ? `<div style="margin:0.5rem 0; padding:0.5rem; background:rgba(255,193,7,0.1); border:1px solid rgba(255,193,7,0.3); border-radius:4px; font-size:0.85rem;">
                <strong>Review needed.</strong> PDF extraction may be inaccurate — please verify and correct.
                ${warnings.map(w => `<div style="margin-top:0.25rem">&#9888; ${escapeHtml(w)}</div>`).join("")}
              </div>`
            : "";

          const fieldInputs = fields.map(({ key, label, type }) => {
            const val = extracted[key];
            const conf = confidence[key];
            const confPct = conf ? Math.round(conf * 100) : null;
            const isLow = confPct !== null && confPct < 80;
            const displayVal = val === null || val === undefined ? "" : (typeof val === "number" ? val : String(val));
            const inputStyle = isLow ? "border-color:var(--warning, orange)" : "";
            return `<div style="display:flex; gap:0.5rem; align-items:center; margin-bottom:0.4rem;">
              <label style="width:200px; font-size:0.85rem; font-weight:500; flex-shrink:0">${escapeHtml(label)}</label>
              <input type="${type === "number" ? "text" : "text"}" name="field_${key}" value="${escapeHtml(String(displayVal))}" style="flex:1; padding:0.3rem 0.5rem; border:1px solid var(--border); border-radius:4px; font-size:0.85rem; ${inputStyle}" />
              ${isLow ? '<span style="color:var(--warning, orange); font-size:0.75rem; flex-shrink:0">low conf</span>' : ""}
            </div>`;
          }).join("");

          detailHtml = `
            <div style="margin-top:0.75rem;">
              ${warningHtml}
              <form method="POST" action="/api/tax/documents/${d.id}/confirm">
                ${fieldInputs}
                <div style="display:flex; gap:0.5rem; margin-top:0.75rem;">
                  <button type="submit" class="btn btn-primary btn-sm">Confirm Values</button>
                  <span style="font-size:0.8rem; color:var(--text-muted); align-self:center;">
                    Correct any values above, then confirm to save.
                  </span>
                </div>
              </form>
            </div>
          `;
        } else if (d.status === "confirmed") {
          const confirmedData = d.extracted_data ? JSON.parse(d.extracted_data) : {};
          const summaryRows = fields.filter(f => confirmedData[f.key]).map(({ key, label }) => {
            const val = confirmedData[key];
            const display = typeof val === "number" ? `$${val.toLocaleString(undefined, {minimumFractionDigits: 2})}` : escapeHtml(String(val));
            return `<tr><td style="font-weight:500">${escapeHtml(label)}</td><td>${display}</td></tr>`;
          }).join("");
          detailHtml = `<div style="margin-top:0.5rem;">
            <table class="table" style="font-size:0.85rem;"><tbody>${summaryRows}</tbody></table>
          </div>`;
        } else if (d.status === "error") {
          detailHtml = `<div style="margin-top:0.5rem; font-size:0.85rem;">
            <div style="color:var(--danger); margin-bottom:0.5rem;">${warnings.map(w => escapeHtml(w)).join("<br>")}</div>
            <p>The PDF couldn't be read. Enter the values manually using the form above (upload again) or tell Crow directly.</p>
          </div>`;
        }

        return `
          <div style="border:1px solid var(--border); border-radius:8px; padding:1rem; margin-bottom:0.75rem;">
            <div style="display:flex; justify-content:space-between; align-items:center;">
              <div>
                <strong>${escapeHtml(d.filename || "Unknown")}</strong>
                <span style="margin-left:0.5rem; text-transform:uppercase; font-size:0.8rem; color:var(--text-muted);">${escapeHtml(d.doc_type || "")}</span>
              </div>
              <div>${statusBadge}</div>
            </div>
            ${detailHtml}
          </div>
        `;
      }).join("");

      docsContent = `${uploadForm}${docCards}`;
    }

    // --- Tab navigation ---
    const tabBtn = (name, label, count) => {
      const active = tab === name ? 'style="border-bottom:2px solid var(--primary); font-weight:600;"' : '';
      const countBadge = count > 0 ? ` (${count})` : "";
      return `<a href="/dashboard/tax?tab=${name}" ${active} style="padding:0.5rem 1rem; text-decoration:none; color:inherit;">${label}${countBadge}</a>`;
    };

    const content = `
      <div style="border-bottom:1px solid var(--border); margin-bottom:1rem; display:flex; gap:0;">
        ${tabBtn("returns", "Returns", returns.length)}
        ${tabBtn("documents", "Documents", documents.length)}
      </div>
      <div>
        ${tab === "documents" ? docsContent : returnsContent}
      </div>
    `;

    return layout({
      title: "Tax Filing",
      content,
    });
  },
};
