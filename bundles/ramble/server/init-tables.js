async function initTable(db, label, sql) {
  try { await db.executeMultiple(sql); }
  catch (err) { console.error(`[ramble init] ${label}:`, err.message); throw err; }
}

async function ensureColumn(db, table, column, ddl) {
  const info = await db.execute({ sql: `PRAGMA table_info(${table})`, args: [] });
  if (!info.rows.some((r) => r.name === column)) {
    await initTable(db, `${table}.${column}`, `ALTER TABLE ${table} ADD COLUMN ${column} ${ddl};`);
  }
}

export async function initRambleTables(db) {
  await initTable(db, "ramble_marks", `
    CREATE TABLE IF NOT EXISTS ramble_marks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      mark_id TEXT UNIQUE NOT NULL,
      author TEXT NOT NULL,
      author_level TEXT,
      kind TEXT NOT NULL,
      anchor_kind TEXT NOT NULL,
      geohash TEXT, lat REAL, lon REAL, accuracy_m REAL, anchor_ref TEXT,
      visibility TEXT NOT NULL DEFAULT 'public',
      reveal TEXT NOT NULL DEFAULT 'open',
      content_text TEXT, content_kind TEXT DEFAULT 'none', content_ref TEXT,
      thumb_enc TEXT, locked_blob TEXT,
      created_at INTEGER NOT NULL,
      expires_at INTEGER,
      nostr_event_id TEXT UNIQUE,
      publish_state TEXT NOT NULL DEFAULT 'pending',
      origin TEXT NOT NULL DEFAULT 'local',
      lamport_ts INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS ramble_marks_geohash ON ramble_marks(geohash);
    CREATE INDEX IF NOT EXISTS ramble_marks_pubstate ON ramble_marks(publish_state);`);

  await initTable(db, "ramble_marks_fts", `
    CREATE VIRTUAL TABLE IF NOT EXISTS ramble_marks_fts USING fts5(
      content_text, mark_id UNINDEXED, content=ramble_marks, content_rowid=id
    );
    CREATE TRIGGER IF NOT EXISTS ramble_marks_ai AFTER INSERT ON ramble_marks BEGIN
      INSERT INTO ramble_marks_fts(rowid, content_text, mark_id) VALUES (new.id, new.content_text, new.mark_id);
    END;
    CREATE TRIGGER IF NOT EXISTS ramble_marks_ad AFTER DELETE ON ramble_marks BEGIN
      INSERT INTO ramble_marks_fts(ramble_marks_fts, rowid, content_text, mark_id) VALUES ('delete', old.id, old.content_text, old.mark_id);
    END;
    CREATE TRIGGER IF NOT EXISTS ramble_marks_au AFTER UPDATE ON ramble_marks BEGIN
      INSERT INTO ramble_marks_fts(ramble_marks_fts, rowid, content_text, mark_id) VALUES ('delete', old.id, old.content_text, old.mark_id);
      INSERT INTO ramble_marks_fts(rowid, content_text, mark_id) VALUES (new.id, new.content_text, new.mark_id);
    END;`);

  await ensureColumn(db, "ramble_marks", "bird_species", "TEXT");
  await ensureColumn(db, "ramble_marks", "bird_seed", "INTEGER");

  await initTable(db, "ramble_pet", `
    CREATE TABLE IF NOT EXISTS ramble_pet (
      owner TEXT PRIMARY KEY DEFAULT 'self',
      mood TEXT NOT NULL DEFAULT 'happy',
      energy INTEGER NOT NULL DEFAULT 60,
      last_fed_at INTEGER,
      places_week INTEGER NOT NULL DEFAULT 0,
      unlocks_week INTEGER NOT NULL DEFAULT 0,
      crows_week INTEGER NOT NULL DEFAULT 0
    );`);

  // week_start (Task 14): added via a guarded ALTER TABLE rather than the
  // CREATE above so a host that already created ramble_pet before this
  // column existed still gets it, idempotently, with no SCHEMA_GENERATION
  // bump (ramble_pet is per-instance, not synced).
  await ensureColumn(db, "ramble_pet", "week_start", "INTEGER");
  await ensureColumn(db, "ramble_pet", "active_egg_id", "TEXT");
  await ensureColumn(db, "ramble_pet", "chores_json", "TEXT");
  await ensureColumn(db, "ramble_pet", "lamport_ts", "INTEGER DEFAULT 0");

  await initTable(db, "ramble_settings", `
    CREATE TABLE IF NOT EXISTS ramble_settings (
      key TEXT PRIMARY KEY,
      value TEXT,
      lamport_ts INTEGER DEFAULT 0
    );`);

  // Pending NIP-09 deletes for already-published public marks. A TABLE, not a
  // `ramble_settings` JSON list: the gateway drain and the authoring path would
  // otherwise read-modify-write the same JSON blob and lose each other's
  // entries (R14). Deliberately has NO lamport_ts and is absent from
  // instance-sync's SYNCED_TABLES — a tombstone is one instance's outbound
  // work item, not shared state. Rows are deleted once a relay accepts.
  await initTable(db, "ramble_tombstones", `
    CREATE TABLE IF NOT EXISTS ramble_tombstones (
      nostr_event_id TEXT PRIMARY KEY,
      mark_id TEXT,
      kind TEXT NOT NULL,
      author_level TEXT,
      created_at INTEGER NOT NULL
    );`);

  await initTable(db, "ramble_groups", `
    CREATE TABLE IF NOT EXISTS ramble_groups (
      group_id TEXT PRIMARY KEY,
      name TEXT,
      shared_key TEXT NOT NULL,
      members TEXT,
      created_at INTEGER NOT NULL
    );`);

  await initTable(db, "ramble_blocks", `
    CREATE TABLE IF NOT EXISTS ramble_blocks (
      persona TEXT PRIMARY KEY,
      reason TEXT,
      created_at INTEGER NOT NULL,
      lamport_ts INTEGER DEFAULT 0
    );`);

  await initTable(db, "ramble_eggs", `
    CREATE TABLE IF NOT EXISTS ramble_eggs (
      egg_id TEXT PRIMARY KEY,
      status TEXT NOT NULL DEFAULT 'shelf',
      warmth INTEGER NOT NULL DEFAULT 0,
      species TEXT,
      seed INTEGER,
      found_cell TEXT,
      found_week TEXT,
      from_crow_id TEXT,
      created_at INTEGER NOT NULL,
      hatched_at INTEGER,
      lamport_ts INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS ramble_eggs_status ON ramble_eggs(status);`);

  await initTable(db, "ramble_credits", `
    CREATE TABLE IF NOT EXISTS ramble_credits (
      kind TEXT NOT NULL,
      key TEXT NOT NULL,
      credited_at INTEGER NOT NULL,
      PRIMARY KEY (kind, key)
    );`);
}
