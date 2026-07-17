/**
 * PM Workspace — table initialization.
 *
 * Idempotent (CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS
 * everywhere). Safe to re-run on every server start.
 */

async function initTable(db, label, sql) {
  try {
    await db.executeMultiple(sql);
  } catch (err) {
    console.error(`[pm-workspace init] ${label}:`, err.message);
    throw err;
  }
}

export async function initPmTables(db) {
  await initTable(db, "pm_notes", `
    CREATE TABLE IF NOT EXISTS pm_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      kind TEXT CHECK(kind IN ('markdown','drawing')),
      content_md TEXT,
      strokes_json TEXT,
      image_path TEXT,
      ocr_text TEXT,
      ocr_status TEXT DEFAULT 'n/a',
      memory_id INTEGER,
      board_ref TEXT,
      tags TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_pm_notes_kind ON pm_notes(kind);
    CREATE INDEX IF NOT EXISTS idx_pm_notes_updated ON pm_notes(updated_at DESC);
  `);

  await initTable(db, "pm_notes FTS index", `
    CREATE VIRTUAL TABLE IF NOT EXISTS pm_notes_fts USING fts5(
      title, content_md, ocr_text, tags,
      content=pm_notes,
      content_rowid=id
    );
  `);

  await initTable(db, "pm_notes FTS triggers", `
    CREATE TRIGGER IF NOT EXISTS pm_notes_ai AFTER INSERT ON pm_notes BEGIN
      INSERT INTO pm_notes_fts(rowid, title, content_md, ocr_text, tags)
      VALUES (new.id, new.title, new.content_md, new.ocr_text, new.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS pm_notes_ad AFTER DELETE ON pm_notes BEGIN
      INSERT INTO pm_notes_fts(pm_notes_fts, rowid, title, content_md, ocr_text, tags)
      VALUES ('delete', old.id, old.title, old.content_md, old.ocr_text, old.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS pm_notes_au AFTER UPDATE ON pm_notes BEGIN
      INSERT INTO pm_notes_fts(pm_notes_fts, rowid, title, content_md, ocr_text, tags)
      VALUES ('delete', old.id, old.title, old.content_md, old.ocr_text, old.tags);
      INSERT INTO pm_notes_fts(rowid, title, content_md, ocr_text, tags)
      VALUES (new.id, new.title, new.content_md, new.ocr_text, new.tags);
    END;
  `);

  await initTable(db, "pm_digests", `
    CREATE TABLE IF NOT EXISTS pm_digests (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      digest_date TEXT UNIQUE,
      html TEXT,
      summary TEXT,
      sources_json TEXT,
      sent_at TEXT,
      sent_via TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  await initTable(db, "pm_sync_state", `
    CREATE TABLE IF NOT EXISTS pm_sync_state (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source TEXT,
      board_id TEXT,
      item_id TEXT,
      local_kind TEXT,
      local_id INTEGER,
      content_hash TEXT,
      monday_updated_at TEXT,
      last_synced_at TEXT,
      UNIQUE(board_id, item_id)
    );

    CREATE INDEX IF NOT EXISTS idx_pm_sync_state_local ON pm_sync_state(local_kind, local_id);
  `);

  await initTable(db, "pm_planned_events", `
    CREATE TABLE IF NOT EXISTS pm_planned_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      uid TEXT UNIQUE,
      title TEXT NOT NULL,
      start_utc TEXT NOT NULL,
      end_utc TEXT NOT NULL,
      location TEXT,
      body TEXT,
      source TEXT,
      source_ref TEXT,
      status TEXT DEFAULT 'proposed'
        CHECK(status IN ('proposed','approved','rejected','exported','confirmed','cancelled')),
      decided_at TEXT,
      decided_via TEXT,
      exported_at TEXT,
      feed_file TEXT,
      confirmed_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_pm_planned_events_status ON pm_planned_events(status, start_utc);
  `);

  await initTable(db, "pm_sync_log", `
    CREATE TABLE IF NOT EXISTS pm_sync_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      run_at TEXT DEFAULT (datetime('now')),
      direction TEXT,
      board_id TEXT,
      action TEXT,
      item_ref TEXT,
      detail TEXT,
      ok INTEGER
    );

    CREATE INDEX IF NOT EXISTS idx_pm_sync_log_run ON pm_sync_log(run_at DESC);
  `);
}
