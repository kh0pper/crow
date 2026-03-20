/**
 * Crow Tax — Dashboard Panel
 *
 * Shows tax return status, summary, and download links.
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

        if (returns.rows.length === 0) {
          return {
            html: `
              <div class="panel-empty">
                <p>No tax returns found.</p>
                <p class="muted">Use <code>crow_tax_new_return</code> to start.</p>
              </div>
            `,
          };
        }

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

        return {
          html: `
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
          `,
        };
      } catch (err) {
        return { html: `<p class="error">Error loading tax data: ${err.message}</p>` };
      }
    },
  };
}
