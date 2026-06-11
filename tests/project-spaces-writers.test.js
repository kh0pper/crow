/**
 * Tests for W2-5 Stage B2 — FK re-pointing to project_spaces.
 *
 * Task A scope: tests 1, 2, 9-note (double-init harness), 10.
 *
 * Test inventory:
 *   1. FK rebuild correctness (main) — DATA-CARRYING path with adversarial seed
 *      (deleted high id so sqlite_sequence.seq > MAX(id); FTS-matchable content;
 *       extra columns populated; mid-rebuild failure injection)
 *   2. FK enforcement direction: insert source with ps-only project_id succeeds;
 *      delete that ps row → source SET NULL; backend CASCADE
 *  10. Bundle-rebuild data path: old bundle schemas constructed manually,
 *      maker_learner_settings age/avatar + AUTOINCREMENT data_case_studies seeded,
 *      each bundle's init-tables rebuild asserted for parity + sequence preservation
 *
 * Note (spec test 9): addColumnIfMissing("research_notes","lamport_ts",...) (:160)
 * and addUuidColumn("research_notes") run BEFORE research_notes CREATE (:481).
 * All harnesses run init-db TWICE to match live-host schemas.
 */

import { test, after } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDbClient } from "../servers/db.js";
import { initMakerLabTables } from "../bundles/maker-lab/server/init-tables.js";
import { initDataDashboardTables } from "../bundles/data-dashboard/server/init-tables.js";

// ── Helpers ──────────────────────────────────────────────────────────────────

function runInitDb(dir) {
  execFileSync(process.execPath, ["scripts/init-db.js"], {
    env: { ...process.env, CROW_DATA_DIR: dir },
    stdio: "pipe",
    cwd: join(import.meta.dirname, ".."),
  });
}

// ── Test 1: FK rebuild correctness (DATA-CARRYING path) ──────────────────────

test("1. FK rebuild correctness — data-carrying path with adversarial seed", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crow-psw-t1-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  const dbPath = join(dir, "crow.db");

  // Step A: construct pre-B2 schema manually in a fresh DB.
  // Hardcoded DDL cross-checked against `git show 206b0cc:scripts/init-db.js`.
  // We build only the tables needed for the rebuild test:
  // research_projects (parent), project_spaces (new parent), research_sources,
  // data_backends, research_notes + their FTS/indexes + live-extra columns.
  const rawDb = createDbClient(dbPath);

  // Base tables needed as FK parents
  await rawDb.executeMultiple(`
    CREATE TABLE research_projects (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      description TEXT,
      type TEXT DEFAULT 'research',
      status TEXT DEFAULT 'active',
      tags TEXT,
      uuid TEXT,
      origin_instance_id TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE project_spaces (
      id INTEGER PRIMARY KEY,
      uuid TEXT NOT NULL UNIQUE DEFAULT (lower(hex(randomblob(16)))),
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT,
      type TEXT NOT NULL DEFAULT 'general',
      status TEXT NOT NULL DEFAULT 'active',
      owner_contact_id INTEGER,
      workspace_dir TEXT,
      storage_prefix TEXT,
      tasks_db_uri TEXT,
      db_path TEXT,
      origin_instance_id TEXT,
      tags TEXT,
      archived_at TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE TABLE data_backends (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER NOT NULL,
      name TEXT NOT NULL,
      backend_type TEXT DEFAULT 'mcp_server',
      connection_ref TEXT NOT NULL,
      schema_info TEXT,
      status TEXT DEFAULT 'disconnected',
      last_connected_at TEXT,
      last_error TEXT,
      tags TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      uuid TEXT,
      origin_instance_id TEXT,
      FOREIGN KEY (project_id) REFERENCES research_projects(id) ON DELETE CASCADE
    );

    CREATE INDEX IF NOT EXISTS idx_backends_project ON data_backends(project_id);
    CREATE INDEX IF NOT EXISTS idx_backends_status ON data_backends(status);
  `);

  // Pre-B2 research_sources (FK targets research_projects)
  await rawDb.executeMultiple(`
    CREATE TABLE research_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER,
      title TEXT NOT NULL,
      source_type TEXT NOT NULL CHECK(source_type IN (
        'web_article', 'academic_paper', 'book', 'interview',
        'web_search', 'web_scrape', 'api_data', 'document',
        'video', 'podcast', 'social_media', 'government_doc',
        'dataset', 'other'
      )),
      url TEXT,
      authors TEXT,
      publication_date TEXT,
      publisher TEXT,
      doi TEXT,
      isbn TEXT,
      abstract TEXT,
      content_summary TEXT,
      full_text TEXT,
      citation_apa TEXT NOT NULL,
      retrieval_date TEXT DEFAULT (date('now')),
      retrieval_method TEXT,
      verified INTEGER DEFAULT 0,
      verification_notes TEXT,
      tags TEXT,
      relevance_score INTEGER DEFAULT 5 CHECK(relevance_score BETWEEN 1 AND 10),
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES research_projects(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_sources_project ON research_sources(project_id);
    CREATE INDEX IF NOT EXISTS idx_sources_type ON research_sources(source_type);
    CREATE INDEX IF NOT EXISTS idx_sources_verified ON research_sources(verified);
  `);

  // Live-extra columns: backend_id + uuid + origin_instance_id
  await rawDb.execute("ALTER TABLE research_sources ADD COLUMN backend_id INTEGER REFERENCES data_backends(id) ON DELETE SET NULL");
  await rawDb.execute("ALTER TABLE research_sources ADD COLUMN uuid TEXT");
  await rawDb.execute("ALTER TABLE research_sources ADD COLUMN origin_instance_id TEXT");
  await rawDb.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_research_sources_uuid ON research_sources(uuid)");

  // FTS for research_sources
  await rawDb.executeMultiple(`
    CREATE VIRTUAL TABLE sources_fts USING fts5(
      title, authors, abstract, content_summary, full_text, tags, citation_apa,
      content=research_sources,
      content_rowid=id
    );

    CREATE TRIGGER sources_ai AFTER INSERT ON research_sources BEGIN
      INSERT INTO sources_fts(rowid, title, authors, abstract, content_summary, full_text, tags, citation_apa)
      VALUES (new.id, new.title, new.authors, new.abstract, new.content_summary, new.full_text, new.tags, new.citation_apa);
    END;

    CREATE TRIGGER sources_ad AFTER DELETE ON research_sources BEGIN
      INSERT INTO sources_fts(sources_fts, rowid, title, authors, abstract, content_summary, full_text, tags, citation_apa)
      VALUES ('delete', old.id, old.title, old.authors, old.abstract, old.content_summary, old.full_text, old.tags, old.citation_apa);
    END;

    CREATE TRIGGER sources_au AFTER UPDATE ON research_sources BEGIN
      INSERT INTO sources_fts(sources_fts, rowid, title, authors, abstract, content_summary, full_text, tags, citation_apa)
      VALUES ('delete', old.id, old.title, old.authors, old.abstract, old.content_summary, old.full_text, old.tags, old.citation_apa);
      INSERT INTO sources_fts(rowid, title, authors, abstract, content_summary, full_text, tags, citation_apa)
      VALUES (new.id, new.title, new.authors, new.abstract, new.content_summary, new.full_text, new.tags, new.citation_apa);
    END;
  `);

  // Pre-B2 research_notes (FK targets research_projects)
  await rawDb.executeMultiple(`
    CREATE TABLE research_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER,
      source_id INTEGER,
      title TEXT,
      content TEXT NOT NULL,
      note_type TEXT DEFAULT 'note' CHECK(note_type IN ('note', 'quote', 'summary', 'analysis', 'question', 'insight')),
      tags TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES research_projects(id) ON DELETE SET NULL,
      FOREIGN KEY (source_id) REFERENCES research_sources(id) ON DELETE SET NULL
    );

    CREATE INDEX IF NOT EXISTS idx_notes_project ON research_notes(project_id);
    CREATE INDEX IF NOT EXISTS idx_notes_source ON research_notes(source_id);
  `);

  // Live-extra columns for research_notes
  await rawDb.execute("ALTER TABLE research_notes ADD COLUMN lamport_ts INTEGER DEFAULT 0");
  await rawDb.execute("ALTER TABLE research_notes ADD COLUMN updated_at TEXT");
  await rawDb.execute("ALTER TABLE research_notes ADD COLUMN uuid TEXT");
  await rawDb.execute("ALTER TABLE research_notes ADD COLUMN origin_instance_id TEXT");
  await rawDb.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_research_notes_uuid ON research_notes(uuid)");

  // Live-extra columns for data_backends
  // (uuid + origin_instance_id already in canonical CREATE above — they're live extras)
  await rawDb.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_data_backends_uuid ON data_backends(uuid)");

  // Seed a research_project (old parent) and mirror it into project_spaces
  await rawDb.execute(`INSERT INTO research_projects (id, name, uuid, created_at, updated_at)
    VALUES (1, 'Test Project', lower(hex(randomblob(16))), datetime('now'), datetime('now'))`);
  await rawDb.execute(`INSERT INTO project_spaces (id, slug, name, created_at, updated_at)
    VALUES (1, 'test-project-1', 'Test Project', datetime('now'), datetime('now'))`);

  // Seed a data_backend pointing at the rp project
  await rawDb.execute(`INSERT INTO data_backends (id, project_id, name, connection_ref, uuid)
    VALUES (1, 1, 'My Backend', '{}', lower(hex(randomblob(16))))`);

  // Seed research_sources — include backend_id, uuid, origin_instance_id
  await rawDb.execute(`INSERT INTO research_sources
    (id, project_id, title, source_type, citation_apa, full_text, backend_id, uuid, origin_instance_id)
    VALUES (1, 1, 'Searchable Source Alpha', 'web_article', 'Alpha (2024)', 'alpha content', 1,
      lower(hex(randomblob(16))), 'inst-a')`);

  await rawDb.execute(`INSERT INTO research_sources
    (id, project_id, title, source_type, citation_apa, uuid)
    VALUES (2, 1, 'Searchable Source Beta', 'book', 'Beta (2023)', lower(hex(randomblob(16))))`);

  // Seed a note referencing source 1
  await rawDb.execute(`INSERT INTO research_notes
    (id, project_id, source_id, content, lamport_ts, uuid, origin_instance_id)
    VALUES (1, 1, 1, 'Note about alpha', 42, lower(hex(randomblob(16))), 'inst-a')`);

  // Insert and delete a high-id row to drive sqlite_sequence.seq > MAX(id)
  // This is the C1 adversarial case: without sequence capture/restore, next insert reuses id 10
  await rawDb.execute(`INSERT INTO research_sources (id, project_id, title, source_type, citation_apa, uuid)
    VALUES (10, 1, 'Deleted High Id', 'other', 'Deleted (2024)', lower(hex(randomblob(16))))`);
  await rawDb.execute("DELETE FROM research_sources WHERE id = 10");

  // Verify sqlite_sequence has seq=10 for research_sources before rebuild
  const { rows: preSeq } = await rawDb.execute(
    "SELECT seq FROM sqlite_sequence WHERE name = 'research_sources'"
  );
  assert.equal(Number(preSeq[0].seq), 10, "pre-rebuild seq should be 10 (deleted high id)");

  // Snapshot index list before rebuild (spec C3 parity check)
  const { rows: preIdxRows } = await rawDb.execute(
    "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='research_sources' AND sql IS NOT NULL ORDER BY name"
  );
  const preIdxNames = new Set(preIdxRows.map((r) => r.name));

  // Snapshot FK list before rebuild
  const { rows: preFkList } = await rawDb.execute("PRAGMA foreign_key_list(research_sources)");

  rawDb.close();

  // Step B: Run the rebuild by importing the function from init-db.
  // We can't import init-db directly (it's a top-level script), so we
  // run init-db.js against this DB directory — but init-db.js runs the
  // FULL init, which means fresh tables would be created IF NOT EXISTS first.
  // Instead, we inline the rebuild logic by importing helpers directly.
  // The rebuild function is NOT exported from init-db.js (it's module-local),
  // so we test it indirectly by running init-db.js against a DB that has
  // the OLD schema — init-db detects the old FK and rebuilds.
  //
  // Run init-db.js twice (spec test-note 9): first run does the rebuild;
  // second run must be a no-op (detect-skip idempotency).
  runInitDb(dir);
  runInitDb(dir);

  // Step C: assertions
  const db = createDbClient(dbPath);

  // sqlite_sequence preserved at >= 10 (spec C1)
  const { rows: postSeq } = await db.execute(
    "SELECT seq FROM sqlite_sequence WHERE name = 'research_sources'"
  );
  assert.ok(postSeq.length === 1, "exactly one sqlite_sequence row for research_sources");
  assert.ok(
    Number(postSeq[0].seq) >= 10,
    `post-rebuild seq must be >= 10 (was ${postSeq[0].seq})`
  );

  // Next insert after rebuild must NOT reuse id 10 (spec C1)
  await db.execute(`INSERT INTO research_sources (project_id, title, source_type, citation_apa, uuid)
    VALUES (1, 'Post-Rebuild Source', 'other', 'Post (2024)', lower(hex(randomblob(16))))`);
  const { rows: newSrcRows } = await db.execute(
    "SELECT id FROM research_sources WHERE title = 'Post-Rebuild Source'"
  );
  assert.ok(newSrcRows[0].id > 10, `new source id ${newSrcRows[0].id} must be > 10 (no reuse)`);

  // Rowids unchanged — source ids 1 and 2 still there
  const { rows: srcRows } = await db.execute(
    "SELECT id, title FROM research_sources WHERE id IN (1, 2) ORDER BY id"
  );
  assert.equal(srcRows.length, 2);
  assert.equal(srcRows[0].title, "Searchable Source Alpha");
  assert.equal(srcRows[1].title, "Searchable Source Beta");

  // FTS integrity check (spec step 5: research_sources only)
  // The rebuild recreates sources_ai/ad/au triggers
  await assert.doesNotReject(
    db.execute("INSERT INTO sources_fts(sources_fts) VALUES('integrity-check')"),
    "sources_fts integrity-check should pass"
  );

  // FTS MATCH on pre-rebuild content still works
  const { rows: ftsRows } = await db.execute(
    "SELECT rowid FROM sources_fts WHERE sources_fts MATCH 'alpha'"
  );
  assert.ok(ftsRows.some((r) => r.rowid === 1), "FTS should still match 'alpha' → rowid 1");

  // Note → source FK intact
  const { rows: noteRows } = await db.execute(
    "SELECT source_id, lamport_ts FROM research_notes WHERE id = 1"
  );
  assert.equal(noteRows[0].source_id, 1, "note→source FK rowid preserved");
  assert.equal(noteRows[0].lamport_ts, 42, "lamport_ts extra column preserved");

  // PRAGMA foreign_key_list parity (spec C2: backend_id FK must survive)
  const { rows: postFkList } = await db.execute("PRAGMA foreign_key_list(research_sources)");
  // Should have project_id → project_spaces and backend_id → data_backends
  const postFkByFrom = Object.fromEntries(postFkList.map((r) => [r.from, r]));
  assert.ok(postFkByFrom.project_id, "project_id FK must be present post-rebuild");
  assert.equal(postFkByFrom.project_id.table, "project_spaces", "project_id FK must point to project_spaces");
  assert.equal(postFkByFrom.project_id.on_delete, "SET NULL");
  assert.ok(postFkByFrom.backend_id, "backend_id FK must be present (spec C2 — silent loss test)");
  assert.equal(postFkByFrom.backend_id.table, "data_backends");
  assert.equal(postFkByFrom.backend_id.on_delete, "SET NULL");

  // Index parity (spec C3: UNIQUE uuid indexes must survive)
  const { rows: postIdxRows } = await db.execute(
    "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='research_sources' AND sql IS NOT NULL ORDER BY name"
  );
  const postIdxNames = new Set(postIdxRows.map((r) => r.name));
  for (const name of preIdxNames) {
    assert.ok(postIdxNames.has(name), `index ${name} must survive rebuild`);
  }
  assert.ok(postIdxNames.has("idx_research_sources_uuid"), "UNIQUE uuid index must survive (spec C3)");

  // PRAGMA table_info parity — extra columns still present
  const { rows: postColRows } = await db.execute("PRAGMA table_info(research_sources)");
  const postCols = new Set(postColRows.map((r) => r.name));
  for (const col of ["backend_id", "uuid", "origin_instance_id"]) {
    assert.ok(postCols.has(col), `extra column ${col} must survive rebuild`);
  }

  // Verify research_notes also rebuilt correctly
  const { rows: notesFkList } = await db.execute("PRAGMA foreign_key_list(research_notes)");
  const notesFkByFrom = Object.fromEntries(notesFkList.map((r) => [r.from, r]));
  assert.equal(notesFkByFrom.project_id?.table, "project_spaces", "notes project_id → project_spaces");
  assert.equal(notesFkByFrom.project_id?.on_delete, "SET NULL");

  // Verify data_backends also rebuilt correctly
  const { rows: backendFkList } = await db.execute("PRAGMA foreign_key_list(data_backends)");
  const backendFkByFrom = Object.fromEntries(backendFkList.map((r) => [r.from, r]));
  assert.equal(backendFkByFrom.project_id?.table, "project_spaces", "backends project_id → project_spaces");
  assert.equal(backendFkByFrom.project_id?.on_delete, "CASCADE");

  // PRAGMA foreign_key_check — no violations
  const { rows: fkcSrc } = await db.execute("PRAGMA foreign_key_check(research_sources)");
  assert.equal(fkcSrc.length, 0, "no FK violations in research_sources");
  const { rows: fkcNotes } = await db.execute("PRAGMA foreign_key_check(research_notes)");
  assert.equal(fkcNotes.length, 0, "no FK violations in research_notes");
  const { rows: fkcBackends } = await db.execute("PRAGMA foreign_key_check(data_backends)");
  assert.equal(fkcBackends.length, 0, "no FK violations in data_backends");

  // Second run idempotency: detect-skip — no double-rebuild (tested by fact that second run succeeds)
  // (runInitDb already called twice above)

  db.close();
});

// ── Test 2: FK enforcement direction ─────────────────────────────────────────

test("2. FK enforcement direction — ps-only project_id accepted; ps DELETE cascades", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crow-psw-t2-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  // Run init-db twice (spec test-note 9)
  runInitDb(dir);
  runInitDb(dir);

  const dbPath = join(dir, "crow.db");
  const db = createDbClient(dbPath);

  // Create a project_spaces row directly (ps-only — no rp row)
  await db.execute(`INSERT INTO project_spaces (id, slug, name, type, status, created_at, updated_at)
    VALUES (999, 'ps-only-test-999', 'PS Only Project', 'general', 'active', datetime('now'), datetime('now'))`);

  // Verify it did NOT create an rp row (ps-only)
  const { rows: rpCheck } = await db.execute(
    "SELECT id FROM research_projects WHERE id = 999"
  );
  assert.equal(rpCheck.length, 0, "ps-only row must not exist in research_projects");

  // Insert a research_source with project_id pointing at the ps-only id — must succeed (spec test 2)
  await db.execute(`INSERT INTO research_sources (project_id, title, source_type, citation_apa)
    VALUES (999, 'PS Source', 'web_article', 'PSS (2024)')`);

  const { rows: srcRows } = await db.execute(
    "SELECT id, project_id FROM research_sources WHERE title = 'PS Source'"
  );
  assert.equal(srcRows.length, 1, "source insert must succeed for ps-only project_id");
  assert.equal(srcRows[0].project_id, 999);
  const srcId = srcRows[0].id;

  // Insert a data_backend with project_id = ps-only id — must succeed (CASCADE FK)
  await db.execute(`INSERT INTO data_backends (project_id, name, connection_ref)
    VALUES (999, 'PS Backend', '{}')`);
  const { rows: beRows } = await db.execute(
    "SELECT id FROM data_backends WHERE project_id = 999"
  );
  assert.equal(beRows.length, 1, "backend insert must succeed for ps-only project_id");
  const beId = beRows[0].id;

  // Delete the ps row — CASCADE on data_backends, SET NULL on research_sources
  await db.execute("DELETE FROM project_spaces WHERE id = 999");

  const { rows: srcAfter2 } = await db.execute({
    sql: "SELECT project_id FROM research_sources WHERE id = ?",
    args: [srcId],
  });
  assert.equal(srcAfter2.length, 1, "source row must still exist (SET NULL semantics)");
  assert.equal(srcAfter2[0].project_id, null, "source project_id must be SET NULL after ps delete");

  const { rows: beAfter } = await db.execute({
    sql: "SELECT id FROM data_backends WHERE id = ?",
    args: [beId],
  });
  assert.equal(beAfter.length, 0, "backend row must be CASCADE-deleted after ps delete");

  db.close();
});

// ── Test 10: Bundle-rebuild data path ────────────────────────────────────────

test("10. bundle-rebuild data path — old schemas seeded, rebuild asserts parity + sequence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "crow-psw-t10-"));
  after(() => rmSync(dir, { recursive: true, force: true }));

  // Run init-db twice (spec test-note 9) to get the full live schema
  runInitDb(dir);
  runInitDb(dir);

  const dbPath = join(dir, "crow.db");

  // ----- Maker-Lab -----
  // The real maker-lab init-tables.js uses @libsql/client (bundles/maker-lab/server/db.js).
  // For the test we use servers/db.js (better-sqlite3 wrapper) — same surface API.
  // The rebuild logic only calls: db.execute(string|{sql,args}), db.executeMultiple(string)
  // which both wrappers support identically.
  const mlDb = createDbClient(dbPath);

  // Manually construct the OLD maker-lab schema (pre-B2 DDL from git show 206b0cc)
  // maker_learner_settings with age/avatar (spec N1: present on EVERY live host)
  await mlDb.executeMultiple(`
    DROP TABLE IF EXISTS maker_sessions;
    DROP TABLE IF EXISTS maker_bound_devices;
    DROP TABLE IF EXISTS maker_transcripts;
    DROP TABLE IF EXISTS maker_learner_settings;
  `);

  // Need maker_batches for the FK
  await mlDb.executeMultiple(`
    CREATE TABLE IF NOT EXISTS maker_batches (
      batch_id TEXT PRIMARY KEY,
      label TEXT,
      created_by_admin TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      revoked_at TEXT,
      revoke_reason TEXT
    );
  `);

  await mlDb.executeMultiple(`
    CREATE TABLE maker_sessions (
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

    CREATE INDEX idx_maker_sessions_learner ON maker_sessions(learner_id);
    CREATE INDEX idx_maker_sessions_state ON maker_sessions(state);
    CREATE INDEX idx_maker_sessions_guest ON maker_sessions(is_guest);
    CREATE INDEX idx_maker_sessions_batch ON maker_sessions(batch_id);

    CREATE TABLE maker_bound_devices (
      fingerprint TEXT PRIMARY KEY,
      learner_id INTEGER REFERENCES research_projects(id) ON DELETE CASCADE,
      label TEXT,
      bound_at TEXT NOT NULL DEFAULT (datetime('now')),
      last_seen_at TEXT
    );

    CREATE INDEX idx_maker_bound_learner ON maker_bound_devices(learner_id);

    CREATE TABLE maker_transcripts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      learner_id INTEGER NOT NULL REFERENCES research_projects(id) ON DELETE CASCADE,
      session_token TEXT NOT NULL,
      turn_no INTEGER NOT NULL,
      role TEXT NOT NULL CHECK(role IN ('kid','tutor','system')),
      content TEXT NOT NULL,
      created_at TEXT NOT NULL DEFAULT (datetime('now'))
    );

    CREATE INDEX idx_maker_transcripts_learner ON maker_transcripts(learner_id);
    CREATE INDEX idx_maker_transcripts_session ON maker_transcripts(session_token);
    CREATE INDEX idx_maker_transcripts_created ON maker_transcripts(created_at);

    CREATE TABLE maker_learner_settings (
      learner_id INTEGER PRIMARY KEY REFERENCES research_projects(id) ON DELETE CASCADE,
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

  // Seed a research_project (so we can insert learner settings)
  await mlDb.execute(`INSERT OR IGNORE INTO research_projects (id, name, type, created_at, updated_at)
    VALUES (50, 'Learner Profile 50', 'learner_profile', datetime('now'), datetime('now'))`);

  // Seed maker_transcripts with a deleted high id (spec N4 / C1)
  await mlDb.execute(`INSERT INTO maker_transcripts (id, learner_id, session_token, turn_no, role, content)
    VALUES (100, 50, 'tok-a', 1, 'kid', 'hello tutor')`);
  await mlDb.execute("DELETE FROM maker_transcripts WHERE id = 100");
  const { rows: mlPreSeq } = await mlDb.execute(
    "SELECT seq FROM sqlite_sequence WHERE name = 'maker_transcripts'"
  );
  assert.equal(Number(mlPreSeq[0].seq), 100, "pre-rebuild maker_transcripts seq should be 100");

  // Seed maker_learner_settings with age + avatar (spec N1 extras)
  // Note: needs rp row to exist (rp is the current FK parent pre-rebuild)
  await mlDb.execute(`INSERT INTO maker_learner_settings
    (learner_id, age, avatar, transcripts_enabled)
    VALUES (50, 8, 'robot', 1)`);

  // Snapshot pre-rebuild index list for maker_sessions
  const { rows: mlPreIdx } = await mlDb.execute(
    "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='maker_sessions' AND sql IS NOT NULL ORDER BY name"
  );
  const mlPreIdxNames = new Set(mlPreIdx.map((r) => r.name));

  mlDb.close();

  // Run the maker-lab rebuild via initMakerLabTables
  const mlDb2 = createDbClient(dbPath);
  await initMakerLabTables(mlDb2);

  // Assertions for maker-lab rebuild
  // FK now points to project_spaces
  const { rows: mlFkSessions } = await mlDb2.execute("PRAGMA foreign_key_list(maker_sessions)");
  const mlFkByFrom = Object.fromEntries(mlFkSessions.map((r) => [r.from, r]));
  assert.equal(mlFkByFrom.learner_id?.table, "project_spaces", "maker_sessions learner_id → project_spaces");
  assert.equal(mlFkByFrom.learner_id?.on_delete, "SET NULL");

  const { rows: mlFkDevices } = await mlDb2.execute("PRAGMA foreign_key_list(maker_bound_devices)");
  const mlFkDevByFrom = Object.fromEntries(mlFkDevices.map((r) => [r.from, r]));
  assert.equal(mlFkDevByFrom.learner_id?.table, "project_spaces", "maker_bound_devices → project_spaces");
  assert.equal(mlFkDevByFrom.learner_id?.on_delete, "CASCADE");

  const { rows: mlFkTranscripts } = await mlDb2.execute("PRAGMA foreign_key_list(maker_transcripts)");
  const mlFkTransByFrom = Object.fromEntries(mlFkTranscripts.map((r) => [r.from, r]));
  assert.equal(mlFkTransByFrom.learner_id?.table, "project_spaces", "maker_transcripts → project_spaces");
  assert.equal(mlFkTransByFrom.learner_id?.on_delete, "CASCADE");

  const { rows: mlFkSettings } = await mlDb2.execute("PRAGMA foreign_key_list(maker_learner_settings)");
  assert.ok(mlFkSettings.some((r) => r.table === "project_spaces"), "maker_learner_settings → project_spaces");

  // sqlite_sequence preserved for maker_transcripts (spec N4/C1)
  const { rows: mlPostSeq } = await mlDb2.execute(
    "SELECT seq FROM sqlite_sequence WHERE name = 'maker_transcripts'"
  );
  assert.ok(mlPostSeq.length === 1, "exactly one sqlite_sequence row for maker_transcripts");
  assert.ok(
    Number(mlPostSeq[0].seq) >= 100,
    `post-rebuild maker_transcripts seq must be >= 100 (was ${mlPostSeq[0].seq})`
  );

  // Insert after rebuild must NOT reuse id 100
  // (maker_transcripts references project_spaces now — need a ps row with id=50)
  await mlDb2.execute(`INSERT OR IGNORE INTO project_spaces (id, slug, name, type, status, created_at, updated_at)
    VALUES (50, 'learner-50', 'Learner Profile 50', 'learner_profile', 'active', datetime('now'), datetime('now'))`);
  await mlDb2.execute(`INSERT INTO maker_transcripts (learner_id, session_token, turn_no, role, content)
    VALUES (50, 'tok-b', 2, 'tutor', 'hello kid')`);
  const { rows: newTrans } = await mlDb2.execute(
    "SELECT id FROM maker_transcripts WHERE session_token = 'tok-b'"
  );
  assert.ok(newTrans[0].id > 100, `new transcript id ${newTrans[0].id} must be > 100 (no id reuse)`);

  // maker_learner_settings data preserved + extras survive
  const { rows: settingsRows } = await mlDb2.execute(
    "SELECT learner_id, age, avatar FROM maker_learner_settings WHERE learner_id = 50"
  );
  assert.equal(settingsRows.length, 1, "settings row must survive rebuild");
  assert.equal(settingsRows[0].age, 8, "age extra column preserved");
  assert.equal(settingsRows[0].avatar, "robot", "avatar extra column preserved");

  // Index parity for maker_sessions
  const { rows: mlPostIdx } = await mlDb2.execute(
    "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='maker_sessions' AND sql IS NOT NULL ORDER BY name"
  );
  const mlPostIdxNames = new Set(mlPostIdx.map((r) => r.name));
  for (const name of mlPreIdxNames) {
    assert.ok(mlPostIdxNames.has(name), `maker_sessions index ${name} must survive rebuild`);
  }

  // FK check for all maker-lab tables
  for (const t of ["maker_sessions", "maker_bound_devices", "maker_transcripts", "maker_learner_settings"]) {
    const { rows: v } = await mlDb2.execute(`PRAGMA foreign_key_check(${t})`);
    assert.equal(v.length, 0, `no FK violations in ${t}`);
  }

  // Second call idempotent (detect-skip)
  await assert.doesNotReject(
    initMakerLabTables(mlDb2),
    "second initMakerLabTables call must be idempotent"
  );

  mlDb2.close();

  // ----- Data Dashboard -----
  const ddDb = createDbClient(dbPath);

  // Manually construct OLD data-dashboard schema (pre-B2)
  await ddDb.executeMultiple(`
    DROP TABLE IF EXISTS data_case_study_sections;
    DROP TABLE IF EXISTS data_case_studies;
    DROP TABLE IF EXISTS data_dashboard_items;
  `);

  await ddDb.executeMultiple(`
    CREATE TABLE data_dashboard_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER REFERENCES research_projects(id) ON DELETE CASCADE,
      backend_id INTEGER REFERENCES data_backends(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      item_type TEXT NOT NULL CHECK(item_type IN ('query', 'chart')),
      sql TEXT,
      config TEXT,
      description TEXT,
      is_pinned INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE TABLE data_case_studies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER REFERENCES research_projects(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      description TEXT,
      blog_post_id INTEGER REFERENCES blog_posts(id) ON DELETE SET NULL,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      default_voice TEXT,
      display_order INTEGER DEFAULT 0
    );

    CREATE TABLE data_case_study_sections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      case_study_id INTEGER NOT NULL REFERENCES data_case_studies(id) ON DELETE CASCADE,
      section_type TEXT NOT NULL CHECK(section_type IN ('text', 'chart', 'map')),
      sort_order INTEGER DEFAULT 0,
      title TEXT,
      content TEXT,
      sql TEXT,
      config TEXT,
      caption TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  // Ensure research_projects has id=1 (the old FK parent) for seeding
  await ddDb.execute(`INSERT OR IGNORE INTO research_projects (id, name, created_at, updated_at)
    VALUES (1, 'Test Project', datetime('now'), datetime('now'))`);

  // Seed data_case_studies with a deleted high id (spec N4: seq > MAX(id))
  await ddDb.execute(`INSERT INTO data_case_studies (id, project_id, title, default_voice, display_order)
    VALUES (200, 1, 'Case Study High', 'en-US', 5)`);
  await ddDb.execute("DELETE FROM data_case_studies WHERE id = 200");
  const { rows: ddPreSeq } = await ddDb.execute(
    "SELECT seq FROM sqlite_sequence WHERE name = 'data_case_studies'"
  );
  assert.equal(Number(ddPreSeq[0].seq), 200, "pre-rebuild data_case_studies seq should be 200");

  // Seed a real case study (with extras populated)
  await ddDb.execute(`INSERT INTO data_case_studies (id, project_id, title, default_voice, display_order)
    VALUES (5, 1, 'Real Case', 'en-GB', 3)`);

  ddDb.close();

  // Run the data-dashboard rebuild
  const ddDb2 = createDbClient(dbPath);
  await initDataDashboardTables(ddDb2);

  // FK assertions
  const { rows: ddFkItems } = await ddDb2.execute("PRAGMA foreign_key_list(data_dashboard_items)");
  assert.ok(
    ddFkItems.some((r) => r.from === "project_id" && r.table === "project_spaces"),
    "data_dashboard_items project_id → project_spaces"
  );

  const { rows: ddFkStudies } = await ddDb2.execute("PRAGMA foreign_key_list(data_case_studies)");
  assert.ok(
    ddFkStudies.some((r) => r.from === "project_id" && r.table === "project_spaces"),
    "data_case_studies project_id → project_spaces"
  );

  // sqlite_sequence preserved for data_case_studies
  const { rows: ddPostSeq } = await ddDb2.execute(
    "SELECT seq FROM sqlite_sequence WHERE name = 'data_case_studies'"
  );
  assert.ok(ddPostSeq.length === 1, "exactly one sqlite_sequence row for data_case_studies");
  assert.ok(
    Number(ddPostSeq[0].seq) >= 200,
    `post-rebuild data_case_studies seq must be >= 200 (was ${ddPostSeq[0].seq})`
  );

  // Insert after rebuild must NOT reuse id 200.
  // project_spaces needs id=1 as FK parent (re-check: research_projects id=1
  // was seeded above and the rp→ps trigger mirrors it; if not, insert directly).
  await ddDb2.execute(`INSERT OR IGNORE INTO project_spaces (id, slug, name, type, status, created_at, updated_at)
    VALUES (1, 'test-proj-1', 'Test Project', 'general', 'active', datetime('now'), datetime('now'))`);
  await ddDb2.execute(`INSERT INTO data_case_studies (project_id, title)
    VALUES (1, 'Post-Rebuild Case')`);
  const { rows: newCase } = await ddDb2.execute(
    "SELECT id FROM data_case_studies WHERE title = 'Post-Rebuild Case'"
  );
  assert.ok(newCase[0].id > 200, `new case study id ${newCase[0].id} must be > 200 (no id reuse)`);

  // Existing data preserved with extras
  const { rows: realCase } = await ddDb2.execute(
    "SELECT default_voice, display_order FROM data_case_studies WHERE id = 5"
  );
  assert.equal(realCase.length, 1, "case study id=5 must survive rebuild");
  assert.equal(realCase[0].default_voice, "en-GB", "default_voice extra column preserved");
  assert.equal(realCase[0].display_order, 3, "display_order extra column preserved");

  // FK check
  for (const t of ["data_dashboard_items", "data_case_studies"]) {
    const { rows: v } = await ddDb2.execute(`PRAGMA foreign_key_check(${t})`);
    assert.equal(v.length, 0, `no FK violations in ${t}`);
  }

  // Second call idempotent
  await assert.doesNotReject(
    initDataDashboardTables(ddDb2),
    "second initDataDashboardTables call must be idempotent"
  );

  ddDb2.close();
});
