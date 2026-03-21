/**
 * IPTV Bundle — Table Initialization
 *
 * Creates all IPTV-related tables and indexes.
 * Safe to re-run (uses CREATE TABLE IF NOT EXISTS everywhere).
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
 * Initialize all IPTV-related tables in the database.
 * @param {object} db - @libsql/client database instance
 */
export async function initIptvTables(db) {
  await initTable(db, "iptv_playlists", `
    CREATE TABLE IF NOT EXISTS iptv_playlists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      url TEXT,
      file_path TEXT,
      auto_refresh INTEGER DEFAULT 0,
      last_refreshed_at TEXT,
      channel_count INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  await initTable(db, "iptv_channels", `
    CREATE TABLE IF NOT EXISTS iptv_channels (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      playlist_id INTEGER REFERENCES iptv_playlists(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      stream_url TEXT NOT NULL,
      logo_url TEXT,
      group_title TEXT,
      tvg_id TEXT,
      tvg_name TEXT,
      is_favorite INTEGER DEFAULT 0,
      last_checked_at TEXT,
      status TEXT DEFAULT 'unknown'
    );

    CREATE INDEX IF NOT EXISTS idx_iptv_channels_playlist ON iptv_channels(playlist_id);
    CREATE INDEX IF NOT EXISTS idx_iptv_channels_group ON iptv_channels(group_title);
    CREATE INDEX IF NOT EXISTS idx_iptv_channels_favorite ON iptv_channels(is_favorite);
  `);

  await initTable(db, "iptv_epg", `
    CREATE TABLE IF NOT EXISTS iptv_epg (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_tvg_id TEXT NOT NULL,
      title TEXT NOT NULL,
      description TEXT,
      start_time TEXT NOT NULL,
      end_time TEXT NOT NULL,
      category TEXT,
      icon_url TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_iptv_epg_channel ON iptv_epg(channel_tvg_id, start_time);
  `);

  await initTable(db, "iptv_recordings", `
    CREATE TABLE IF NOT EXISTS iptv_recordings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      channel_id INTEGER REFERENCES iptv_channels(id),
      channel_name TEXT,
      program_title TEXT,
      file_path TEXT,
      status TEXT DEFAULT 'scheduled',
      start_time TEXT,
      end_time TEXT,
      duration_seconds INTEGER,
      file_size_bytes INTEGER,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
}
