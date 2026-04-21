/**
 * Crow Campaigns — Table Initialization
 *
 * Creates all Campaigns tables in Crow's shared crow.db.
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
 * Initialize all Campaigns tables.
 * @param {object} db - @libsql/client database instance
 */
export async function initCampaignsTables(db) {
  // --- Credentials (encrypted at rest) ---
  await initTable(db, "campaigns_credentials", `
    CREATE TABLE IF NOT EXISTS campaigns_credentials (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL DEFAULT 'reddit',
      username TEXT NOT NULL,
      client_id_enc TEXT NOT NULL,
      client_secret_enc TEXT NOT NULL,
      password_enc TEXT NOT NULL,
      is_active INTEGER NOT NULL DEFAULT 1,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_campaigns_creds_platform ON campaigns_credentials(platform);
  `);

  // --- Subreddits (cached intelligence) ---
  await initTable(db, "campaigns_subreddits", `
    CREATE TABLE IF NOT EXISTS campaigns_subreddits (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      subscribers INTEGER,
      rules_json TEXT,
      flair_json TEXT,
      timing_rules TEXT,
      culture_notes TEXT,
      last_crawled_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // --- Campaigns ---
  await initTable(db, "campaigns_campaigns", `
    CREATE TABLE IF NOT EXISTS campaigns_campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      credential_id INTEGER,
      require_approval INTEGER NOT NULL DEFAULT 1,
      brief TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (credential_id) REFERENCES campaigns_credentials(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns_campaigns(status);
  `);

  // --- Posts ---
  await initTable(db, "campaigns_posts", `
    CREATE TABLE IF NOT EXISTS campaigns_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL,
      subreddit_name TEXT NOT NULL,
      post_type TEXT NOT NULL DEFAULT 'text',
      title TEXT,
      body TEXT,
      flair_id TEXT,
      flair_text TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      scheduled_at TEXT,
      published_at TEXT,
      reddit_post_id TEXT,
      reddit_url TEXT,
      error TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (campaign_id) REFERENCES campaigns_campaigns(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_campaigns_posts_campaign ON campaigns_posts(campaign_id);
    CREATE INDEX IF NOT EXISTS idx_campaigns_posts_status ON campaigns_posts(status);
    CREATE INDEX IF NOT EXISTS idx_campaigns_posts_scheduled ON campaigns_posts(scheduled_at);
  `);

  // --- Post History (audit log) ---
  await initTable(db, "campaigns_post_history", `
    CREATE TABLE IF NOT EXISTS campaigns_post_history (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      post_id INTEGER NOT NULL,
      from_status TEXT,
      to_status TEXT NOT NULL,
      details TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (post_id) REFERENCES campaigns_posts(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_campaigns_history_post ON campaigns_post_history(post_id);
    CREATE INDEX IF NOT EXISTS idx_campaigns_history_time ON campaigns_post_history(created_at DESC);
  `);

  console.log("[campaigns] Tables initialized");
}
