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

// W2-5 B2: rebuild data-dashboard FKs from research_projects(id) → project_spaces(id).
// Idempotent: detects via PRAGMA foreign_key_list; skips tables already rebuilt.
// Same rules as main init-db rebuild: PRAGMA FK OFF/ON outside transactions,
// BEGIN IMMEDIATE + explicit ROLLBACK, sqlite_master index snapshot,
// sqlite_sequence capture/restore (UPDATE then INSERT-on-0-changes), abort on unknown.
async function rebuildDashboardFKsToProjectSpaces(db) {
  const TABLE_SPECS = {
    data_dashboard_items: {
      isAutoincrement: true,
      newDdl: `CREATE TABLE data_dashboard_items_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER REFERENCES project_spaces(id) ON DELETE CASCADE,
      backend_id INTEGER REFERENCES data_backends(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      item_type TEXT NOT NULL CHECK(item_type IN ('query', 'chart')),
      sql TEXT,
      config TEXT,
      description TEXT,
      is_pinned INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    )`,
      knownExtras: [],
      canonicalColumns: [
        "id", "project_id", "backend_id", "name", "item_type", "sql", "config",
        "description", "is_pinned", "created_at", "updated_at",
      ],
    },
    data_case_studies: {
      isAutoincrement: true,
      newDdl: `CREATE TABLE data_case_studies_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER REFERENCES project_spaces(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT,
      blog_post_id INTEGER REFERENCES blog_posts(id) ON DELETE SET NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      default_voice TEXT,
      display_order INTEGER DEFAULT 0
    )`,
      // default_voice + display_order added via addColumnIfMissing (spec N1)
      knownExtras: ["default_voice", "display_order"],
      canonicalColumns: [
        "id", "project_id", "title", "description", "blog_post_id",
        "created_at", "updated_at",
      ],
    },
  };

  // PRAGMA foreign_keys OFF must be outside any transaction (spec step 2)
  await db.execute({ sql: "PRAGMA foreign_keys = OFF" });

  try {
    for (const [tableName, spec] of Object.entries(TABLE_SPECS)) {
      // Step 1: detect — skip if already points at project_spaces (or table absent)
      let fkList;
      try {
        const r = await db.execute({ sql: `PRAGMA foreign_key_list(${tableName})` });
        fkList = r.rows;
      } catch {
        continue;
      }
      const hasRpRef = fkList.some(
        (r) => r.table === "research_projects" && r.from === "project_id"
      );
      if (!hasRpRef) {
        continue;
      }

      console.log(`[data-dashboard W2-5 B2] Rebuilding ${tableName} FK → project_spaces …`);

      // Step 3: snapshot index DDL from sqlite_master
      const { rows: idxRows } = await db.execute({
        sql: `SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL`,
        args: [tableName],
      });

      // Verify no unknown columns (spec C2 + N1 — abort before any DDL)
      const { rows: colRows } = await db.execute({ sql: `PRAGMA table_info(${tableName})` });
      // Per-table column set (spec D2 fix: a merged union across tables would
      // let a column belonging to table A slip through unnoticed on table B)
      const canonicalCols = new Set([...spec.canonicalColumns, ...spec.knownExtras]);
      for (const col of colRows) {
        if (!canonicalCols.has(col.name)) {
          await db.execute({ sql: "PRAGMA foreign_keys = ON" });
          throw new Error(
            `[data-dashboard W2-5 B2] Unknown column ${tableName}.${col.name} — add it to the rebuild's extras list (and test fixture) or remove the column`
          );
        }
      }

      // Step 4: capture sqlite_sequence (AUTOINCREMENT tables)
      let capturedSeq = null;
      if (spec.isAutoincrement) {
        const { rows: seqRows } = await db.execute({
          sql: `SELECT seq FROM sqlite_sequence WHERE name = ?`,
          args: [tableName],
        });
        capturedSeq = seqRows.length > 0 ? Number(seqRows[0].seq) : 0;
      }

      const colList = colRows.map((c) => c.name).join(", ");

      try {
        await db.executeMultiple(`BEGIN IMMEDIATE`);

        await db.execute({ sql: spec.newDdl });
        await db.execute({
          sql: `INSERT INTO ${tableName}_new (${colList}) SELECT ${colList} FROM ${tableName}`,
        });
        await db.execute({ sql: `DROP TABLE ${tableName}` });
        await db.execute({ sql: `ALTER TABLE ${tableName}_new RENAME TO ${tableName}` });

        for (const idx of idxRows) {
          await db.execute({ sql: idx.sql });
        }

        // Restore sqlite_sequence (spec C1 + N2)
        if (spec.isAutoincrement && capturedSeq !== null) {
          const { rows: maxRows } = await db.execute({
            sql: `SELECT MAX(id) AS maxId FROM ${tableName}`,
          });
          const maxId = maxRows[0]?.maxId != null ? Number(maxRows[0].maxId) : 0;
          const restoreSeq = Math.max(capturedSeq, maxId);
          const upd = await db.execute({
            sql: `UPDATE sqlite_sequence SET seq = ? WHERE name = ?`,
            args: [restoreSeq, tableName],
          });
          if (upd.rowsAffected === 0) {
            await db.execute({
              sql: `INSERT INTO sqlite_sequence (name, seq) VALUES (?, ?)`,
              args: [tableName, restoreSeq],
            });
          }
        }

        await db.executeMultiple(`COMMIT`);
      } catch (err) {
        try { await db.executeMultiple(`ROLLBACK`); } catch {}
        await db.execute({ sql: "PRAGMA foreign_keys = ON" });
        throw err;
      }

      // foreign_key_check per rebuilt table
      const { rows: fkViolations } = await db.execute({
        sql: `PRAGMA foreign_key_check(${tableName})`,
      });
      if (fkViolations.length > 0) {
        await db.execute({ sql: "PRAGMA foreign_keys = ON" });
        throw new Error(
          `[data-dashboard W2-5 B2] PRAGMA foreign_key_check(${tableName}) returned ${fkViolations.length} violation(s)`
        );
      }

      console.log(`[data-dashboard W2-5 B2] ${tableName} rebuilt → project_spaces`);
    }
  } finally {
    await db.execute({ sql: "PRAGMA foreign_keys = ON" });
  }
}

export async function initDataDashboardTables(db) {
  // Run FK rebuild FIRST (spec C5 mandate: awaited+fatal; rebuild before any writer call)
  await rebuildDashboardFKsToProjectSpaces(db);

  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS data_dashboard_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER REFERENCES project_spaces(id) ON DELETE CASCADE,
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
      project_id INTEGER REFERENCES project_spaces(id) ON DELETE CASCADE,
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
