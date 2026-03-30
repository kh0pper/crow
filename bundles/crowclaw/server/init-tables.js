/**
 * CrowClaw — Table Initialization
 *
 * Creates all CrowClaw tables in Crow's shared crow.db.
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
 * Initialize all CrowClaw tables.
 * @param {object} db - @libsql/client database instance
 */
export async function initCrowClawTables(db) {
  // --- Bot Definitions ---
  await initTable(db, "crowclaw_bots", `
    CREATE TABLE IF NOT EXISTS crowclaw_bots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL UNIQUE,
      display_name TEXT,
      status TEXT NOT NULL DEFAULT 'created',
      deploy_mode TEXT NOT NULL DEFAULT 'native',
      config_dir TEXT,
      workspace_dir TEXT,
      service_unit TEXT,
      gateway_port INTEGER,
      ai_source TEXT NOT NULL DEFAULT 'byoai',
      primary_model TEXT,
      safety_policy_json TEXT,
      last_started_at TEXT,
      last_error TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      lamport_ts INTEGER DEFAULT 0
    );

    CREATE INDEX IF NOT EXISTS idx_crowclaw_bots_status ON crowclaw_bots(status);
  `);

  // --- User Profiles ---
  await initTable(db, "crowclaw_user_profiles", `
    CREATE TABLE IF NOT EXISTS crowclaw_user_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_id INTEGER NOT NULL,
      platform TEXT NOT NULL,
      platform_user_id TEXT NOT NULL,
      display_name TEXT,
      language TEXT DEFAULT 'en',
      tts_voice TEXT,
      timezone TEXT,
      persona_notes TEXT,
      is_owner INTEGER DEFAULT 0,
      preferences_json TEXT,
      crow_memory_tag TEXT,
      lamport_ts INTEGER DEFAULT 0,
      UNIQUE(bot_id, platform, platform_user_id),
      FOREIGN KEY (bot_id) REFERENCES crowclaw_bots(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_crowclaw_profiles_bot ON crowclaw_user_profiles(bot_id);
  `);

  // --- Workspace Files ---
  await initTable(db, "crowclaw_workspace_files", `
    CREATE TABLE IF NOT EXISTS crowclaw_workspace_files (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_id INTEGER NOT NULL,
      file_name TEXT NOT NULL,
      content TEXT,
      is_template INTEGER DEFAULT 0,
      lamport_ts INTEGER DEFAULT 0,
      UNIQUE(bot_id, file_name),
      FOREIGN KEY (bot_id) REFERENCES crowclaw_bots(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_crowclaw_workspace_bot ON crowclaw_workspace_files(bot_id);
  `);

  // --- Deployments (audit log) ---
  await initTable(db, "crowclaw_deployments", `
    CREATE TABLE IF NOT EXISTS crowclaw_deployments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_id INTEGER NOT NULL,
      action TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'started',
      details TEXT,
      error TEXT,
      started_at TEXT DEFAULT (datetime('now')),
      completed_at TEXT,
      FOREIGN KEY (bot_id) REFERENCES crowclaw_bots(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_crowclaw_deployments_bot ON crowclaw_deployments(bot_id);
    CREATE INDEX IF NOT EXISTS idx_crowclaw_deployments_time ON crowclaw_deployments(started_at DESC);
  `);

  // --- Skills ---
  await initTable(db, "crowclaw_skills", `
    CREATE TABLE IF NOT EXISTS crowclaw_skills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_id INTEGER NOT NULL,
      skill_name TEXT NOT NULL,
      source_path TEXT,
      deployed_at TEXT DEFAULT (datetime('now')),
      UNIQUE(bot_id, skill_name),
      FOREIGN KEY (bot_id) REFERENCES crowclaw_bots(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_crowclaw_skills_bot ON crowclaw_skills(bot_id);
  `);

  // --- Safety Events ---
  await initTable(db, "crowclaw_safety_events", `
    CREATE TABLE IF NOT EXISTS crowclaw_safety_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_id INTEGER,
      event_type TEXT NOT NULL,
      severity TEXT NOT NULL DEFAULT 'info',
      details_json TEXT,
      user_id TEXT,
      timestamp TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_crowclaw_safety_bot ON crowclaw_safety_events(bot_id);
    CREATE INDEX IF NOT EXISTS idx_crowclaw_safety_time ON crowclaw_safety_events(timestamp DESC);
  `);

  // --- Bot Messages (for Crow Messages panel chat) ---
  await initTable(db, "crowclaw_bot_messages", `
    CREATE TABLE IF NOT EXISTS crowclaw_bot_messages (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bot_id INTEGER NOT NULL REFERENCES crowclaw_bots(id),
      role TEXT NOT NULL,
      content TEXT,
      tool_name TEXT,
      tool_result TEXT,
      session_id TEXT,
      attachments TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_cbm_bot_session ON crowclaw_bot_messages(bot_id, session_id);
  `);

  // Migration: add attachments column if missing (existing tables)
  try {
    await db.execute("SELECT attachments FROM crowclaw_bot_messages LIMIT 0");
  } catch {
    try {
      await db.execute("ALTER TABLE crowclaw_bot_messages ADD COLUMN attachments TEXT");
      console.log("[crowclaw] Added attachments column to crowclaw_bot_messages");
    } catch (err) {
      console.error("[crowclaw] Migration failed:", err.message);
    }
  }

  console.log("[crowclaw] Tables initialized");
}
