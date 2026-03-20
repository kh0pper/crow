/**
 * Media Bundle — Table Initialization
 *
 * Creates all media-related tables, FTS indexes, triggers, and indexes.
 * Safe to re-run (uses CREATE TABLE IF NOT EXISTS everywhere).
 *
 * Extracted from scripts/init-db.js (media tables section).
 */

async function initTable(db, label, sql) {
  try {
    await db.executeMultiple(sql);
  } catch (err) {
    console.error(`Failed to initialize ${label}:`, err.message);
    throw err;
  }
}

async function addColumnIfMissing(db, table, column, definition) {
  try {
    const cols = await db.execute({ sql: `PRAGMA table_info(${table})` });
    const exists = cols.rows.some(r => r.name === column);
    if (!exists) {
      await db.execute({ sql: `ALTER TABLE ${table} ADD COLUMN ${column} ${definition}` });
      console.log(`Added column ${table}.${column}`);
    }
  } catch (err) {
    console.warn(`Warning: could not check/add ${table}.${column}: ${err.message}`);
  }
}

/**
 * Initialize all media-related tables in the database.
 * @param {object} db - @libsql/client database instance
 */
export async function initMediaTables(db) {
  // --- Media Sources ---

  await initTable(db, "media_sources table", `
    CREATE TABLE IF NOT EXISTS media_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_type TEXT NOT NULL DEFAULT 'rss',
      name TEXT NOT NULL,
      url TEXT NOT NULL UNIQUE,
      category TEXT,
      fetch_interval_min INTEGER DEFAULT 30,
      last_fetched TEXT,
      last_error TEXT,
      enabled INTEGER DEFAULT 1,
      config TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_media_sources_type ON media_sources(source_type);
    CREATE INDEX IF NOT EXISTS idx_media_sources_enabled ON media_sources(enabled);
    CREATE INDEX IF NOT EXISTS idx_media_sources_category ON media_sources(category);
  `);

  // Add auth_config for paywalled sources
  await addColumnIfMissing(db, "media_sources", "auth_config", "TEXT");

  // --- Media Articles ---

  await initTable(db, "media_articles table", `
    CREATE TABLE IF NOT EXISTS media_articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      source_id INTEGER NOT NULL,
      guid TEXT,
      url TEXT,
      title TEXT NOT NULL,
      author TEXT,
      pub_date TEXT,
      content_raw TEXT,
      content_full TEXT,
      content_fetch_status TEXT DEFAULT 'pending',
      summary TEXT,
      topics TEXT,
      categories TEXT,
      sentiment_score REAL,
      key_entities TEXT,
      ai_analysis_status TEXT DEFAULT 'pending',
      estimated_read_time INTEGER,
      popularity_score INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      UNIQUE(source_id, guid),
      FOREIGN KEY (source_id) REFERENCES media_sources(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_media_articles_source ON media_articles(source_id);
    CREATE INDEX IF NOT EXISTS idx_media_articles_pub_date ON media_articles(pub_date DESC);
    CREATE INDEX IF NOT EXISTS idx_media_articles_status ON media_articles(content_fetch_status);
  `);

  // --- Media Articles FTS ---

  await initTable(db, "media_articles FTS index", `
    CREATE VIRTUAL TABLE IF NOT EXISTS media_articles_fts USING fts5(
      title, content_full, summary, topics, categories, key_entities,
      content=media_articles,
      content_rowid=id
    );
  `);

  await initTable(db, "media_articles FTS triggers", `
    CREATE TRIGGER IF NOT EXISTS media_articles_ai AFTER INSERT ON media_articles BEGIN
      INSERT INTO media_articles_fts(rowid, title, content_full, summary, topics, categories, key_entities)
      VALUES (new.id, new.title, new.content_full, new.summary, new.topics, new.categories, new.key_entities);
    END;

    CREATE TRIGGER IF NOT EXISTS media_articles_ad AFTER DELETE ON media_articles BEGIN
      INSERT INTO media_articles_fts(media_articles_fts, rowid, title, content_full, summary, topics, categories, key_entities)
      VALUES ('delete', old.id, old.title, old.content_full, old.summary, old.topics, old.categories, old.key_entities);
    END;

    CREATE TRIGGER IF NOT EXISTS media_articles_au AFTER UPDATE ON media_articles BEGIN
      INSERT INTO media_articles_fts(media_articles_fts, rowid, title, content_full, summary, topics, categories, key_entities)
      VALUES ('delete', old.id, old.title, old.content_full, old.summary, old.topics, old.categories, old.key_entities);
      INSERT INTO media_articles_fts(rowid, title, content_full, summary, topics, categories, key_entities)
      VALUES (new.id, new.title, new.content_full, new.summary, new.topics, new.categories, new.key_entities);
    END;
  `);

  // --- Article States ---

  await initTable(db, "media_article_states table", `
    CREATE TABLE IF NOT EXISTS media_article_states (
      article_id INTEGER PRIMARY KEY,
      is_read INTEGER DEFAULT 0,
      is_saved INTEGER DEFAULT 0,
      is_starred INTEGER DEFAULT 0,
      listen_progress REAL,
      dwell_time_sec INTEGER,
      read_at TEXT,
      FOREIGN KEY (article_id) REFERENCES media_articles(id) ON DELETE CASCADE
    );
  `);

  // --- Feedback ---

  await initTable(db, "media_feedback table", `
    CREATE TABLE IF NOT EXISTS media_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      article_id INTEGER NOT NULL,
      feedback TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (article_id) REFERENCES media_articles(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_media_feedback_article ON media_feedback(article_id);
  `);

  // --- Add columns that may be missing on older schemas ---

  await addColumnIfMissing(db, "media_articles", "image_url", "TEXT");
  await addColumnIfMissing(db, "media_articles", "audio_url", "TEXT");
  await addColumnIfMissing(db, "media_articles", "source_url", "TEXT");

  // --- Audio Cache ---

  await initTable(db, "media_audio_cache table", `
    CREATE TABLE IF NOT EXISTS media_audio_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      article_id INTEGER NOT NULL UNIQUE,
      content_hash TEXT NOT NULL,
      audio_path TEXT NOT NULL,
      voice TEXT DEFAULT 'en-US-AriaNeural',
      duration_sec REAL,
      file_size INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      last_accessed TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (article_id) REFERENCES media_articles(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_media_audio_cache_accessed ON media_audio_cache(last_accessed);
  `);

  // --- Briefings ---

  await initTable(db, "media_briefings table", `
    CREATE TABLE IF NOT EXISTS media_briefings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      script TEXT,
      audio_path TEXT,
      article_ids TEXT,
      duration_sec REAL,
      voice TEXT DEFAULT 'en-US-AriaNeural',
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // --- Playlists ---

  await initTable(db, "media_playlists table", `
    CREATE TABLE IF NOT EXISTS media_playlists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      auto_generated INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Add columns that may be missing on older schemas
  await addColumnIfMissing(db, "media_playlists", "slug", "TEXT");
  await addColumnIfMissing(db, "media_playlists", "visibility", "TEXT DEFAULT 'private'");

  await initTable(db, "media_playlist_items table", `
    CREATE TABLE IF NOT EXISTS media_playlist_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      playlist_id INTEGER NOT NULL,
      item_type TEXT NOT NULL,
      item_id INTEGER NOT NULL,
      position INTEGER DEFAULT 0,
      FOREIGN KEY (playlist_id) REFERENCES media_playlists(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_media_playlist_items_playlist ON media_playlist_items(playlist_id);
  `);

  // --- Smart Folders ---

  await initTable(db, "media_smart_folders table", `
    CREATE TABLE IF NOT EXISTS media_smart_folders (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      query_json TEXT NOT NULL,
      auto_generated INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // --- Digest Preferences ---

  await initTable(db, "media_digest_preferences table", `
    CREATE TABLE IF NOT EXISTS media_digest_preferences (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      schedule TEXT DEFAULT 'daily_morning',
      email TEXT,
      custom_instructions TEXT,
      enabled INTEGER DEFAULT 0,
      last_sent TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // --- Interest Profiles ---

  await initTable(db, "media_interest_profiles table", `
    CREATE TABLE IF NOT EXISTS media_interest_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      profile_type TEXT NOT NULL,
      profile_key TEXT NOT NULL,
      affinity REAL DEFAULT 0.5,
      interaction_count INTEGER DEFAULT 0,
      updated_at TEXT DEFAULT (datetime('now')),
      UNIQUE(profile_type, profile_key)
    );
    CREATE INDEX IF NOT EXISTS idx_interest_profiles_type ON media_interest_profiles(profile_type);
  `);

  // --- Normalize pub_date values ---
  // RSS feeds provide dates in RFC 2822 format (e.g. "Wed, 31 Dec 2025 08:00:00 GMT")
  // which don't sort correctly in SQLite. Convert all non-ISO dates to ISO 8601.
  try {
    const { rows } = await db.execute({
      sql: "SELECT id, pub_date FROM media_articles WHERE pub_date IS NOT NULL AND pub_date NOT LIKE '____-__-__T%'",
    });
    if (rows.length > 0) {
      let fixed = 0;
      for (const row of rows) {
        try {
          const d = new Date(row.pub_date);
          if (!isNaN(d.getTime())) {
            await db.execute({ sql: "UPDATE media_articles SET pub_date = ? WHERE id = ?", args: [d.toISOString(), row.id] });
            fixed++;
          }
        } catch {}
      }
      if (fixed > 0) console.log(`[media] Normalized ${fixed} pub_date values to ISO 8601`);
    }
  } catch (err) {
    console.warn("[media] pub_date normalization skipped:", err.message);
  }

  console.log("[media] Tables initialized");
}
