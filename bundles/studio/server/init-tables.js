/**
 * Studio bundle — table initialization.
 *
 * Creates the three bundle-owned tables: songs (row + latest snapshot),
 * the append-only Yjs update log, and the shared history. Safe to re-run
 * (everything is CREATE ... IF NOT EXISTS).
 *
 * These tables are local to the instance that owns the project: a song's Yjs
 * updates and history never enter instance sync before collaboration exists.
 */

async function initTable(db, label, sql) {
  try {
    await db.executeMultiple(sql);
  } catch (err) {
    console.error(`Failed to initialize ${label}:`, err.message);
    throw err;
  }
}

/**
 * Initialize the Studio tables. Idempotent.
 * @param {object} db - @libsql/client-compatible client (db.execute, db.executeMultiple)
 * @returns {Promise<void>}
 */
export async function initStudioTables(db) {
  // --- Songs: one row per song, carrying the latest snapshot ---

  await initTable(db, "studio_songs table", `
    CREATE TABLE IF NOT EXISTS studio_songs (
      id TEXT PRIMARY KEY,
      project_id INTEGER NOT NULL,
      title TEXT NOT NULL,
      created_at TEXT,
      updated_at TEXT,
      snapshot BLOB,
      snapshot_seq INTEGER NOT NULL DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_studio_songs_project
      ON studio_songs(project_id, updated_at DESC);
  `);

  // --- Updates: the Yjs update log, one row per applied command ---

  await initTable(db, "studio_updates table", `
    CREATE TABLE IF NOT EXISTS studio_updates (
      song_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      data BLOB NOT NULL,
      created_at TEXT,
      PRIMARY KEY (song_id, seq)
    );
  `);

  // --- History: one entry per command, with its before/after for selective undo ---

  await initTable(db, "studio_history table", `
    CREATE TABLE IF NOT EXISTS studio_history (
      id TEXT PRIMARY KEY,
      song_id TEXT NOT NULL,
      seq INTEGER NOT NULL,
      command TEXT NOT NULL,
      args_json TEXT,
      author_kind TEXT,
      author_id TEXT,
      author_label TEXT,
      summary TEXT,
      touched_json TEXT,
      inverse_json TEXT,
      undo_of TEXT,
      undone_by TEXT,
      created_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_studio_history_song
      ON studio_history(song_id, seq DESC);
  `);
}