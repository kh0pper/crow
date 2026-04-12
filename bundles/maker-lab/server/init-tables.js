/**
 * Maker Lab Bundle — Table Initialization
 *
 * Creates maker-lab session, device-binding, redemption-code,
 * batch, transcript, and per-learner settings tables.
 * Safe to re-run.
 *
 * Learner profiles themselves are stored in the shared research_projects
 * table with type='learner_profile' (no schema change needed per CLAUDE.md).
 */

async function initTable(db, label, sql) {
  try {
    await db.executeMultiple(sql);
  } catch (err) {
    console.error(`[maker-lab] Failed to initialize ${label}:`, err.message);
    throw err;
  }
}

export async function initMakerLabTables(db) {
  // Sessions — one row per live kiosk session.
  // learner_id is nullable for guest sessions (is_guest=1).
  // transcripts_enabled_snapshot is captured at session start and never
  // re-read from live settings during the session (plan contract).
  await initTable(db, "maker_sessions", `
    CREATE TABLE IF NOT EXISTS maker_sessions (
      token TEXT PRIMARY KEY,
      learner_id INTEGER REFERENCES research_projects(id) ON DELETE SET NULL,
      is_guest INTEGER NOT NULL DEFAULT 0,
      guest_age_band TEXT,
      batch_id TEXT REFERENCES maker_batches(batch_id) ON DELETE SET NULL,
      started_at TEXT NOT NULL DEFAULT (datetime('now')),
      expires_at TEXT NOT NULL,
      revoked_at TEXT,
      state TEXT NOT NULL DEFAULT 'active' CHECK(state IN ('active','ending','revoked')),
      ending_started_at TEXT,
      idle_lock_min INTEGER,
      idle_locked_at TEXT,
      last_activity_at TEXT NOT NULL DEFAULT (datetime('now')),
      kiosk_device_id TEXT,
      hints_used INTEGER NOT NULL DEFAULT 0,
      transcripts_enabled_snapshot INTEGER NOT NULL DEFAULT 0,
      CHECK ((is_guest = 1 AND learner_id IS NULL AND guest_age_band IS NOT NULL)
          OR (is_guest = 0 AND learner_id IS NOT NULL))
    );

    CREATE INDEX IF NOT EXISTS idx_maker_sessions_learner ON maker_sessions(learner_id);
    CREATE INDEX IF NOT EXISTS idx_maker_sessions_state ON maker_sessions(state);
    CREATE INDEX IF NOT EXISTS idx_maker_sessions_guest ON maker_sessions(is_guest);
    CREATE INDEX IF NOT EXISTS idx_maker_sessions_batch ON maker_sessions(batch_id);
  `);

  // Bound devices — solo-mode LAN-exposure fingerprint registry.
  await initTable(db, "maker_bound_devices", `
    CREATE TABLE IF NOT EXISTS maker_bound_devices (
      fingerprint TEXT PRIMARY KEY,
      learner_id INTEGER REFERENCES research_projects(id) ON DELETE CASCADE,
      label TEXT,
      bound_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT
    );

    CREATE INDEX IF NOT EXISTS idx_maker_bound_learner ON maker_bound_devices(learner_id);
  `);

  // Redemption codes — one-shot codes for QR/URL handoff.
  // used_at is set atomically by UPDATE...WHERE used_at IS NULL RETURNING.
  await initTable(db, "maker_redemption_codes", `
    CREATE TABLE IF NOT EXISTS maker_redemption_codes (
      code TEXT PRIMARY KEY,
      session_token TEXT NOT NULL REFERENCES maker_sessions(token) ON DELETE CASCADE,
      expires_at TEXT NOT NULL,
      used_at TEXT,
      claimed_by_fingerprint TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_maker_codes_unused
      ON maker_redemption_codes(code) WHERE used_at IS NULL;
  `);

  // Batches — enables one-action revoke of a printed QR sheet.
  await initTable(db, "maker_batches", `
    CREATE TABLE IF NOT EXISTS maker_batches (
      batch_id TEXT PRIMARY KEY,
      label TEXT,
      created_by_admin TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      revoked_at TEXT,
      revoke_reason TEXT
    );
  `);

  // Transcripts — only written when transcripts_enabled_snapshot=1 on the session.
  // Retention sweep runs on a timer (default 30 days).
  await initTable(db, "maker_transcripts", `
    CREATE TABLE IF NOT EXISTS maker_transcripts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      learner_id INTEGER NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
      session_token TEXT NOT NULL,
      turn_no INTEGER NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('kid','tutor','system')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_maker_transcripts_learner ON maker_transcripts(learner_id);
    CREATE INDEX IF NOT EXISTS idx_maker_transcripts_session ON maker_transcripts(session_token);
    CREATE INDEX IF NOT EXISTS idx_maker_transcripts_created ON maker_transcripts(created_at);
  `);

  // Per-learner settings.
  await initTable(db, "maker_learner_settings", `
    CREATE TABLE IF NOT EXISTS maker_learner_settings (
      learner_id INTEGER PRIMARY KEY REFERENCES research_projects(id) ON DELETE CASCADE,
      transcripts_enabled INTEGER NOT NULL DEFAULT 0,
      transcripts_retention_days INTEGER NOT NULL DEFAULT 30,
      idle_lock_default_min INTEGER,
      auto_resume_min INTEGER NOT NULL DEFAULT 15,
      voice_input_enabled INTEGER NOT NULL DEFAULT 0,
      consent_captured_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Boot-time sweep: remove orphaned guest sessions from a crash.
  try {
    await db.execute("DELETE FROM maker_sessions WHERE is_guest = 1 AND (revoked_at IS NOT NULL OR state = 'revoked' OR expires_at < datetime('now'))");
  } catch (err) {
    // Non-fatal — table may not yet have rows.
  }
}
