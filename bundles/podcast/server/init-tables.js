/**
 * Podcast table initialization (self-contained for bundle add-on).
 * All CREATE TABLE IF NOT EXISTS — safe to run on existing databases.
 */

export async function initPodcastTables(db) {
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS podcast_subscriptions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      feed_url TEXT NOT NULL UNIQUE,
      title TEXT,
      description TEXT,
      image_url TEXT,
      last_fetched TEXT,
      fetch_interval_min INTEGER DEFAULT 60,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE IF NOT EXISTS podcast_episodes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      subscription_id INTEGER NOT NULL,
      guid TEXT,
      title TEXT NOT NULL,
      description TEXT,
      audio_url TEXT,
      duration TEXT,
      pub_date TEXT,
      listened INTEGER DEFAULT 0,
      playlist_id INTEGER,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (subscription_id) REFERENCES podcast_subscriptions(id) ON DELETE CASCADE,
      FOREIGN KEY (playlist_id) REFERENCES podcast_playlists(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_podcast_episodes_sub ON podcast_episodes(subscription_id);
    CREATE UNIQUE INDEX IF NOT EXISTS idx_podcast_episodes_guid ON podcast_episodes(subscription_id, guid);

    CREATE TABLE IF NOT EXISTS podcast_playlists (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);
}
