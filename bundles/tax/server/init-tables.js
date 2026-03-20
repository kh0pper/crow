/**
 * Crow Tax — Table Initialization
 *
 * Creates the tax_returns table. Safe to re-run.
 */

export async function initTaxTables(db) {
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS tax_returns (
      id TEXT PRIMARY KEY,
      tax_year INTEGER NOT NULL,
      filing_status TEXT NOT NULL,
      data TEXT NOT NULL,
      result TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_tax_returns_year ON tax_returns(tax_year);
    CREATE INDEX IF NOT EXISTS idx_tax_returns_status ON tax_returns(status);
  `);
}
