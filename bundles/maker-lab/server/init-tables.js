/**
 * Maker Lab Bundle — Table Initialization
 *
 * Creates maker-lab session, device-binding, redemption-code,
 * batch, transcript, and per-learner settings tables.
 * Safe to re-run.
 *
 * Learner profiles themselves are stored in project_spaces
 * with type='learner_profile' (W2-5 B2 migration).
 */

async function initTable(db, label, sql) {
  try {
    await db.executeMultiple(sql);
  } catch (err) {
    console.error(`[maker-lab] Failed to initialize ${label}:`, err.message);
    throw err;
  }
}

// W2-5 B2: rebuild maker-lab FKs from research_projects(id) → project_spaces(id).
// Idempotent: detects via PRAGMA foreign_key_list; skips tables already rebuilt.
// Same rules as main init-db rebuild: PRAGMA FK OFF/ON outside transactions,
// BEGIN IMMEDIATE + explicit ROLLBACK, sqlite_master index snapshot,
// sqlite_sequence capture/restore (UPDATE then INSERT-on-0-changes), abort on unknown.
// No FTS involvement in these tables.
async function rebuildMakerLabFKsToProjectSpaces(db) {
  const TABLE_SPECS = {
    maker_sessions: {
      isAutoincrement: false, // TEXT PRIMARY KEY, not AUTOINCREMENT
      newDdl: `CREATE TABLE maker_sessions_new (
      token TEXT PRIMARY KEY,
      learner_id INTEGER REFERENCES project_spaces(id) ON DELETE SET NULL,
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
    )`,
      knownExtras: [],
      canonicalColumns: [
        "token", "learner_id", "is_guest", "guest_age_band", "batch_id",
        "started_at", "expires_at", "revoked_at", "state", "ending_started_at",
        "idle_lock_min", "idle_locked_at", "last_activity_at", "kiosk_device_id",
        "hints_used", "transcripts_enabled_snapshot",
      ],
    },
    maker_bound_devices: {
      isAutoincrement: false, // TEXT PRIMARY KEY
      newDdl: `CREATE TABLE maker_bound_devices_new (
      fingerprint TEXT PRIMARY KEY,
      learner_id INTEGER REFERENCES project_spaces(id) ON DELETE CASCADE,
      label TEXT,
      bound_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT
    )`,
      knownExtras: [],
      canonicalColumns: ["fingerprint", "learner_id", "label", "bound_at", "last_seen_at"],
    },
    maker_transcripts: {
      isAutoincrement: true,
      newDdl: `CREATE TABLE maker_transcripts_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      learner_id INTEGER NOT NULL REFERENCES project_spaces(id) ON DELETE CASCADE,
      session_token TEXT NOT NULL,
      turn_no INTEGER NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('kid','tutor','system')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
      knownExtras: [],
      canonicalColumns: ["id", "learner_id", "session_token", "turn_no", "role", "content", "created_at"],
    },
    maker_learner_settings: {
      isAutoincrement: false, // learner_id is PK, not AUTOINCREMENT
      newDdl: `CREATE TABLE maker_learner_settings_new (
      learner_id INTEGER PRIMARY KEY REFERENCES project_spaces(id) ON DELETE CASCADE,
      age INTEGER,
      avatar TEXT,
      transcripts_enabled INTEGER NOT NULL DEFAULT 0,
      transcripts_retention_days INTEGER NOT NULL DEFAULT 30,
      idle_lock_default_min INTEGER,
      auto_resume_min INTEGER NOT NULL DEFAULT 15,
      voice_input_enabled INTEGER NOT NULL DEFAULT 0,
      consent_captured_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    )`,
      // age + avatar added via addColumnIfMissing on pre-existing installs (spec N1)
      knownExtras: ["age", "avatar"],
      canonicalColumns: [
        "learner_id", "transcripts_enabled", "transcripts_retention_days",
        "idle_lock_default_min", "auto_resume_min", "voice_input_enabled",
        "consent_captured_at", "updated_at",
      ],
    },
  };

  // PRAGMA foreign_keys OFF must be outside any transaction (spec step 2)
  await db.execute("PRAGMA foreign_keys = OFF");

  try {
    for (const [tableName, spec] of Object.entries(TABLE_SPECS)) {
      // Step 1: detect — skip if already points at project_spaces (or table absent)
      let fkList;
      try {
        const r = await db.execute(`PRAGMA foreign_key_list(${tableName})`);
        fkList = r.rows;
      } catch {
        // Table doesn't exist yet — will be created by initTable below; skip rebuild
        continue;
      }
      const hasRpRef = fkList.some(
        (r) => r.table === "research_projects" && r.from === "learner_id"
      );
      if (!hasRpRef) {
        continue;
      }

      console.log(`[maker-lab W2-5 B2] Rebuilding ${tableName} FK → project_spaces …`);

      // Step 3: snapshot index DDL from sqlite_master
      const { rows: idxRows } = await db.execute({
        sql: `SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL`,
        args: [tableName],
      });

      // Verify no unknown columns (spec C2 + N1 — abort before any DDL)
      const { rows: colRows } = await db.execute(`PRAGMA table_info(${tableName})`);
      // Per-table column set (spec D2 fix: a merged union across tables would
      // let a column belonging to table A slip through unnoticed on table B)
      const canonicalCols = new Set([...spec.canonicalColumns, ...spec.knownExtras]);
      for (const col of colRows) {
        if (!canonicalCols.has(col.name)) {
          await db.execute("PRAGMA foreign_keys = ON");
          throw new Error(
            `[maker-lab W2-5 B2] Unknown column ${tableName}.${col.name} — add it to the rebuild's extras list (and test fixture) or remove the column`
          );
        }
      }

      // Step 4: capture sqlite_sequence (AUTOINCREMENT tables only)
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

        await db.execute(spec.newDdl);
        await db.execute({
          sql: `INSERT INTO ${tableName}_new (${colList}) SELECT ${colList} FROM ${tableName}`,
        });
        await db.execute(`DROP TABLE ${tableName}`);
        await db.execute(`ALTER TABLE ${tableName}_new RENAME TO ${tableName}`);

        for (const idx of idxRows) {
          await db.execute(idx.sql);
        }

        // Restore sqlite_sequence (spec C1 + N2)
        if (spec.isAutoincrement && capturedSeq !== null) {
          const { rows: maxRows } = await db.execute(
            `SELECT MAX(id) AS maxId FROM ${tableName}`
          );
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
        await db.execute("PRAGMA foreign_keys = ON");
        throw err;
      }

      // foreign_key_check per rebuilt table
      const { rows: fkViolations } = await db.execute(
        `PRAGMA foreign_key_check(${tableName})`
      );
      if (fkViolations.length > 0) {
        await db.execute("PRAGMA foreign_keys = ON");
        throw new Error(
          `[maker-lab W2-5 B2] PRAGMA foreign_key_check(${tableName}) returned ${fkViolations.length} violation(s)`
        );
      }

      console.log(`[maker-lab W2-5 B2] ${tableName} rebuilt → project_spaces`);
    }
  } finally {
    await db.execute("PRAGMA foreign_keys = ON");
  }
}

export async function initMakerLabTables(db) {
  // Run FK rebuild FIRST (before CREATE IF NOT EXISTS — tables may already exist with old FKs)
  await rebuildMakerLabFKsToProjectSpaces(db);

  // Sessions — one row per live kiosk session.
  // learner_id is nullable for guest sessions (is_guest=1).
  // transcripts_enabled_snapshot is captured at session start and never
  // re-read from live settings during the session (plan contract).
  await initTable(db, "maker_sessions", `
    CREATE TABLE IF NOT EXISTS maker_sessions (
      token TEXT PRIMARY KEY,
      learner_id INTEGER REFERENCES project_spaces(id) ON DELETE SET NULL,
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
      learner_id INTEGER REFERENCES project_spaces(id) ON DELETE CASCADE,
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
      learner_id INTEGER NOT NULL REFERENCES project_spaces(id) ON DELETE CASCADE,
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

  // Per-learner settings. Also stores age + avatar — project_spaces
  // doesn't have a metadata column, so learner attributes live here.
  await initTable(db, "maker_learner_settings", `
    CREATE TABLE IF NOT EXISTS maker_learner_settings (
      learner_id INTEGER PRIMARY KEY REFERENCES project_spaces(id) ON DELETE CASCADE,
      age INTEGER,
      avatar TEXT,
      transcripts_enabled INTEGER NOT NULL DEFAULT 0,
      transcripts_retention_days INTEGER NOT NULL DEFAULT 30,
      idle_lock_default_min INTEGER,
      auto_resume_min INTEGER NOT NULL DEFAULT 15,
      voice_input_enabled INTEGER NOT NULL DEFAULT 0,
      consent_captured_at TEXT,
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
  `);

  // Migration for existing installs created before age/avatar were added.
  async function addColumnIfMissing(table, col, decl) {
    try {
      const r = await db.execute(`PRAGMA table_info(${table})`);
      const cols = new Set(r.rows.map((x) => x.name));
      if (!cols.has(col)) {
        await db.execute(`ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`);
      }
    } catch {}
  }
  await addColumnIfMissing("maker_learner_settings", "age", "INTEGER");
  await addColumnIfMissing("maker_learner_settings", "avatar", "TEXT");

  // Boot-time sweep: remove orphaned guest sessions from a crash.
  try {
    await db.execute("DELETE FROM maker_sessions WHERE is_guest = 1 AND (revoked_at IS NOT NULL OR state = 'revoked' OR expires_at < datetime('now'))");
  } catch (err) {
    // Non-fatal — table may not yet have rows.
  }
}
