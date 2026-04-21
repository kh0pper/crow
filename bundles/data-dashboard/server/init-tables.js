/**
 * Data Dashboard — Table Initialization
 *
 * Creates bundle-specific tables in the main crow.db.
 * Called on first server start, not during core npm run init-db.
 */

async function addColumnIfMissing(db, table, column, definition) {
  try {
    const cols = await db.execute({ sql: `PRAGMA table_info(${table})` });
    const exists = cols.rows.some((r) => r.name === column);
    if (!exists) {
      await db.execute({ sql: `ALTER TABLE ${table} ADD COLUMN ${column} ${definition}` });
      console.log(`Added column ${table}.${column}`);
    }
  } catch (err) {
    console.warn(`Warning: could not check/add ${table}.${column}: ${err.message}`);
  }
}

export async function initDataDashboardTables(db) {
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS data_dashboard_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER REFERENCES research_projects(id) ON DELETE CASCADE,
      backend_id INTEGER REFERENCES data_backends(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      item_type TEXT NOT NULL CHECK(item_type IN ('query', 'chart')),
      sql TEXT,
      config TEXT,
      description TEXT,
      is_pinned INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS data_case_studies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER REFERENCES research_projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT,
      blog_post_id INTEGER REFERENCES blog_posts(id) ON DELETE SET NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS data_case_study_sections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_study_id INTEGER NOT NULL REFERENCES data_case_studies(id) ON DELETE CASCADE,
      section_type TEXT NOT NULL CHECK(section_type IN ('text', 'chart', 'map')),
      sort_order INTEGER DEFAULT 0,
      title TEXT,
      content TEXT,
      sql TEXT,
      config TEXT,
      caption TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Phase 1 + 8 column additions (idempotent for existing installs).
  await addColumnIfMissing(db, "data_case_studies", "default_voice", "TEXT");
  await addColumnIfMissing(db, "data_case_studies", "display_order", "INTEGER DEFAULT 0");
  await addColumnIfMissing(db, "data_case_study_sections", "caption", "TEXT");
}
