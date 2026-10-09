import { randomBytes } from "node:crypto";
// Crow Artifacts — bundle-owned tables in crow.db (spec §4.1). Ramble/phone
// pattern: CREATE IF NOT EXISTS, called by the core mount and by the panel
// routes; a bundle-owned table needs no SCHEMA_GENERATION bump.
// artifact_shares and artifact_public_links arrive with step 6 (sharing).
export async function initArtifactsTables(db) {
  await db.executeMultiple(`
    CREATE TABLE IF NOT EXISTS artifacts (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      type TEXT NOT NULL CHECK (type IN ('page','document','diagram','data','slides','pdf','image','docx','map')),
      owner TEXT NOT NULL DEFAULT 'owner',
      created_by_bot TEXT,
      origin_session TEXT,
      origin_card INTEGER,
      received INTEGER NOT NULL DEFAULT 1,          -- fail closed: only an explicit 0 is 'ours'
      origin_contact TEXT,
      remote_id TEXT,
      current_version INTEGER,
      published_version INTEGER,
      -- R2-L4: the title was written by a session that was not provably
      -- clean; cleared when the owner approves version 1.
      title_tainted INTEGER NOT NULL DEFAULT 1,     -- fail closed: only an explicit 0 is clean
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      deleted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_artifacts_bot ON artifacts(created_by_bot);
    CREATE TABLE IF NOT EXISTS artifact_bot_access (
      artifact_id TEXT NOT NULL,
      bot_id TEXT NOT NULL,
      granted_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (artifact_id, bot_id)
    );
    CREATE TABLE IF NOT EXISTS artifact_versions (
      artifact_id TEXT NOT NULL,
      n INTEGER NOT NULL,
      state TEXT NOT NULL CHECK (state IN ('current','proposed','past')),
      files_json TEXT NOT NULL,
      source_json TEXT,
      recipe_json TEXT,
      kit_digest TEXT,
      size INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      made_by TEXT NOT NULL CHECK (made_by IN ('bot','user','hand-off')),
      made_by_bot TEXT,
      round_id INTEGER,
      untrusted_input INTEGER NOT NULL DEFAULT 1,   -- fail closed: only an explicit 0 is trusted
      -- Taint (spec §7.3): inherited by every version derived from a tainted
      -- one; cleared ONLY by an explicit owner approve/publish.
      derived_from INTEGER,
      trust_cleared_at TEXT,
      change_note TEXT,
      a11y_summary TEXT,
      anchor_map_json TEXT,
      proposed_reason TEXT,
      flagged_reason TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (artifact_id, n)
    );
    CREATE TABLE IF NOT EXISTS artifact_threads (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      artifact_id TEXT NOT NULL,
      version_n INTEGER NOT NULL,
      anchor_json TEXT NOT NULL CHECK (length(anchor_json) <= 4096),
      status TEXT NOT NULL DEFAULT 'open' CHECK (status IN ('open','resolved','anchor-moved')),
      author_kind TEXT NOT NULL CHECK (author_kind IN ('owner','contact','bot')),
      author_id TEXT,
      ask_now INTEGER NOT NULL DEFAULT 0,
      -- The version the anchor's TEXT was taken from (plan review R-H1).
      -- Carry-forward moves version_n / the block id, never the text, so an
      -- anchor is as trusted as this version (tainted until the owner approves).
      anchor_from_version INTEGER,
      sent_round_id INTEGER,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_artifact_threads_art ON artifact_threads(artifact_id, status);
    CREATE TABLE IF NOT EXISTS artifact_comments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      thread_id INTEGER NOT NULL,
      author_kind TEXT NOT NULL CHECK (author_kind IN ('owner','contact','bot')),
      author_id TEXT,
      text TEXT NOT NULL,
      ts INTEGER NOT NULL,
      -- 1 when written by a bot inside an UNTRUSTED round's session: such a
      -- reply can carry injected text and never makes a later round trusted.
      tainted INTEGER NOT NULL DEFAULT 1,           -- fail closed: only an explicit 0 is clean
      deleted_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_artifact_comments_thread ON artifact_comments(thread_id);
    CREATE INDEX IF NOT EXISTS idx_artifact_comments_author ON artifact_comments(author_kind, author_id, ts);
    CREATE TABLE IF NOT EXISTS artifact_rounds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      artifact_id TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'round' CHECK (kind IN ('round','ask')),
      base_version INTEGER NOT NULL,
      thread_ids_json TEXT NOT NULL,
      untrusted_input INTEGER NOT NULL DEFAULT 1,   -- fail closed
      datasets_approved INTEGER NOT NULL DEFAULT 0, -- not approved unless the owner approves
      delivery TEXT CHECK (delivery IN ('perch-session','board-card')),
      bot_id TEXT,
      session_id TEXT,
      card_id INTEGER,
      status TEXT NOT NULL CHECK (status IN ('queued','pending','delivering','working','done','failed','timed-out')),
      deadline INTEGER,
      summary TEXT,
      result_version INTEGER,
      session_stopped_at TEXT,
      -- R2-H1: {threadId: max comment id} frozen at Send; delivery sends exactly this.
      snapshot_json TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    -- H5: at most one active revision round per artifact (an Ask is separate).
    CREATE UNIQUE INDEX IF NOT EXISTS uq_artifact_active_round ON artifact_rounds(artifact_id)
      WHERE kind = 'round' AND status IN ('queued','pending','delivering','working');
    CREATE TABLE IF NOT EXISTS artifact_audit (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      artifact_id TEXT,
      actor_kind TEXT NOT NULL,
      actor_id TEXT,
      action TEXT NOT NULL,
      target TEXT,
      detail_json TEXT,
      ts TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_artifact_audit_art ON artifact_audit(artifact_id, ts);
    -- R3-M3: this DB's artifact-store identity (matched against the blob
    -- store's marker before any reclaim deletes anything).
    CREATE TABLE IF NOT EXISTS artifact_store_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
    -- Sessions that saw untrusted text (trust.js). Insert-only.
    CREATE TABLE IF NOT EXISTS artifact_session_taint (
      bot_id TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      reason TEXT,
      ts TEXT NOT NULL DEFAULT (datetime('now')),
      PRIMARY KEY (bot_id, thread_id)
    );
  `);
  // Additive migrations for databases created by an earlier version of this
  // bundle (plan review R-L6). CREATE IF NOT EXISTS never adds a column, so
  // every column added after the first release is listed here as well.
  for (const [table, col, decl] of ADDED_COLUMNS) await addColumnIfMissing(db, table, col, decl);
  await db.execute({ sql: "INSERT OR IGNORE INTO artifact_store_meta (key, value) VALUES ('store_id', ?)", args: [randomBytes(16).toString("hex")] });
  // D22 (R3-L1): Perch sessions that existed before D22 have no record of what
  // they read; mark them tainted once (they re-earn trust only as new sessions).
  const done = (await db.execute({ sql: "SELECT value FROM artifact_store_meta WHERE key='d22_backfill'", args: [] })).rows[0];
  if (!done) {
    try { await db.execute({ sql: "INSERT OR IGNORE INTO artifact_session_taint (bot_id, thread_id, reason) SELECT bot_id, gateway_thread_id, 'pre-d22' FROM bot_sessions WHERE gateway_thread_id IS NOT NULL", args: [] }); } catch { /* no bot_sessions table (tests, a fresh install) */ }
    await db.execute({ sql: "INSERT OR IGNORE INTO artifact_store_meta (key, value) VALUES ('d22_backfill', datetime('now'))", args: [] });
  }
}

export const ADDED_COLUMNS = [
  ["artifact_versions", "derived_from", "INTEGER"],
  ["artifact_versions", "trust_cleared_at", "TEXT"],
  ["artifact_threads", "anchor_from_version", "INTEGER"],
  // Upgrade backfill is UNTRUSTED: a row written before the column existed has
  // unknown provenance (security review: no clean-by-default migration).
  ["artifact_comments", "tainted", "INTEGER NOT NULL DEFAULT 1"],
  ["artifact_rounds", "session_stopped_at", "TEXT"],
  ["artifact_rounds", "snapshot_json", "TEXT"],
  ["artifacts", "title_tainted", "INTEGER NOT NULL DEFAULT 1"],
];

export async function addColumnIfMissing(db, table, col, decl) {
  if (!/^[a-z_]+$/.test(table) || !/^[a-z_]+$/.test(col) || !/^[A-Z ]+(DEFAULT \d+)?$/.test(decl)) throw new Error("bad migration spec");
  const { rows } = await db.execute({ sql: `PRAGMA table_info(${table})`, args: [] });
  if (!rows.some((r) => r.name === col)) await db.execute({ sql: `ALTER TABLE ${table} ADD COLUMN ${col} ${decl}`, args: [] });
}
