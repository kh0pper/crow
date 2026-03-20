/**
 * Crow Tax — Panel API Routes
 *
 * Provides endpoints for the dashboard panel.
 */

export default function taxRoutes(router, db) {
  // GET /api/tax/returns — list all returns
  router.get("/api/tax/returns", async (req, res) => {
    try {
      const result = await db.execute({
        sql: "SELECT id, tax_year, filing_status, status, updated_at FROM tax_returns WHERE status != 'purged' ORDER BY updated_at DESC",
        args: [],
      });
      res.json({ returns: result.rows });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // GET /api/tax/returns/:id/summary — get calculated summary (no PII)
  router.get("/api/tax/returns/:id/summary", async (req, res) => {
    try {
      const result = await db.execute({
        sql: "SELECT id, tax_year, filing_status, status, result FROM tax_returns WHERE id = ?",
        args: [req.params.id],
      });
      if (result.rows.length === 0) {
        return res.status(404).json({ error: "Not found" });
      }
      const row = result.rows[0];
      res.json({
        id: row.id,
        taxYear: row.tax_year,
        filingStatus: row.filing_status,
        status: row.status,
        result: row.result ? JSON.parse(row.result) : null,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });
}
