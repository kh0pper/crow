import { createDbClient, resolveDataDir } from "../servers/db.js";
import { ensureTenant, DEFAULT_TENANT_ID } from "../servers/shared/tenancy.js";
import { mkdirSync } from "fs";
import { randomBytes } from "node:crypto";
import { resolve } from "path";
import { slugify, workspacePathFor, storagePrefixFor } from "../servers/shared/slugify.js";
import { BOT_JOBS_DDL } from "./pi-bots/bot-jobs-schema.mjs";

// Ensure data directory exists
const dataDir = process.env.CROW_DB_PATH
  ? resolve(process.env.CROW_DB_PATH, "..")
  : resolveDataDir();
mkdirSync(dataDir, { recursive: true });

const db = createDbClient();

async function initTable(label, sql) {
  try {
    await db.executeMultiple(sql);
  } catch (err) {
    console.error(`Failed to initialize ${label}:`, err.message);
    process.exit(1);
  }
}

// --- Persistent Memory Tables ---

await initTable("memories table", `
  CREATE TABLE IF NOT EXISTS memories (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    category TEXT NOT NULL DEFAULT 'general',
    content TEXT NOT NULL,
    context TEXT,
    tags TEXT,
    source TEXT,
    importance INTEGER DEFAULT 5 CHECK(importance BETWEEN 1 AND 10),
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    accessed_at TEXT DEFAULT (datetime('now')),
    access_count INTEGER DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_memories_category ON memories(category);
  CREATE INDEX IF NOT EXISTS idx_memories_importance ON memories(importance DESC);
  CREATE INDEX IF NOT EXISTS idx_memories_tags ON memories(tags);
  CREATE INDEX IF NOT EXISTS idx_memories_source ON memories(source);
`);

await initTable("memories FTS index", `
  CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    content, context, tags, source, category,
    content=memories,
    content_rowid=id
  );
`);

await initTable("memories FTS triggers", `
  CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
    INSERT INTO memories_fts(rowid, content, context, tags, source, category)
    VALUES (new.id, new.content, new.context, new.tags, new.source, new.category);
  END;

  CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, context, tags, source, category)
    VALUES ('delete', old.id, old.content, old.context, old.tags, old.source, old.category);
  END;

  CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE ON memories BEGIN
    INSERT INTO memories_fts(memories_fts, rowid, content, context, tags, source, category)
    VALUES ('delete', old.id, old.content, old.context, old.tags, old.source, old.category);
    INSERT INTO memories_fts(rowid, content, context, tags, source, category)
    VALUES (new.id, new.content, new.context, new.tags, new.source, new.category);
  END;
`);

// --- Research Pipeline Tables ---

await initTable("research tables", `
  -- (B3b 2026-06-12: research_projects is no longer created — project_spaces is
  --  the system of record; existing hosts drop the dormant table in the guarded
  --  migration at the end of this file.)
  CREATE TABLE IF NOT EXISTS research_sources (
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
    FOREIGN KEY (project_id) REFERENCES project_spaces(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_sources_project ON research_sources(project_id);
  CREATE INDEX IF NOT EXISTS idx_sources_type ON research_sources(source_type);
  CREATE INDEX IF NOT EXISTS idx_sources_verified ON research_sources(verified);
`);

// --- Data Backends Table ---

await initTable("data_backends table", `
  CREATE TABLE IF NOT EXISTS data_backends (
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
    FOREIGN KEY (project_id) REFERENCES project_spaces(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_backends_project ON data_backends(project_id);
  CREATE INDEX IF NOT EXISTS idx_backends_status ON data_backends(status);
`);

// --- Migrate existing tables: add new columns if missing ---

async function addColumnIfMissing(table, column, definition) {
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

await addColumnIfMissing("research_sources", "backend_id", "INTEGER REFERENCES data_backends(id) ON DELETE SET NULL");

// --- Project Space redesign Phase 1, M0 (2026-05-26) ---
// Stable opaque identifiers + origin tracking for every project-scoped row.
// `uuid` survives a future per-project DB split and cross-peer share.
// `origin_instance_id` is the instance that first wrote the row; immutable.
// Added now as nullable + backfilled, then indexed UNIQUE — SQLite ADD COLUMN
// cannot accept a non-constant default expression like randomblob(16) nor a
// column-level UNIQUE constraint, so this is the only safe shape.
async function addUuidColumn(table) {
  await addColumnIfMissing(table, "uuid", "TEXT");
  await addColumnIfMissing(table, "origin_instance_id", "TEXT");
  try {
    await db.execute({
      sql: `UPDATE ${table} SET uuid = lower(hex(randomblob(16))) WHERE uuid IS NULL`,
    });
    await db.execute({
      sql: `CREATE UNIQUE INDEX IF NOT EXISTS idx_${table}_uuid ON ${table}(uuid)`,
    });
  } catch (err) {
    console.warn(`Warning: could not backfill/index ${table}.uuid: ${err.message}`);
  }
}
// research_notes + storage_files are handled in the late-migrations block at
// the END of this file — their CREATE TABLE statements come later, so running
// addUuidColumn here was a no-op-with-warning on fresh databases (the columns
// were silently MISSING on new installs until the 2026-06-12 fix).
for (const t of ["research_sources", "data_backends"]) {
  await addUuidColumn(t);
}

// --- Project Space redesign Phase 1, M1 (2026-05-26) ---
// Promote `research_projects` (which is overloaded across research / data_connector
// / learner_profile / bot scope / Kanban container) into a first-class shareable
// space with members, capabilities, workspace dir, audit log.
//
// Design constraints (see ~/.claude/plans/yeah-let-s-do-some-shimmering-key.md):
//   - `research_projects` stays a real, writable table. `project_spaces` sits
//     alongside it. Triggers mirror rp → ps so legacy callers (12+ INSERT sites)
//     keep working with zero coordination during the transition window.
//   - `type` is NOT CHECK-constrained: maker-lab uses 'learner_profile' today;
//     the constraint lands when the maker-lab split happens.
//   - Two partial UNIQUE indexes on project_members instead of one composite —
//     SQLite UNIQUE treats NULLs as distinct, so `UNIQUE(project_id, contact_id)`
//     does NOT prevent two NULL-contact (local owner) rows.
//   - Trigger uses a SQL-only fallback slug. New code paths (M2+) compute the
//     richer slugify() in JS before writing directly to project_spaces.
await initTable("project_spaces table", `
  CREATE TABLE IF NOT EXISTS project_spaces (
    id                   INTEGER PRIMARY KEY,
    uuid                 TEXT NOT NULL UNIQUE DEFAULT (lower(hex(randomblob(16)))),
    slug                 TEXT NOT NULL UNIQUE,
    name                 TEXT NOT NULL,
    description          TEXT,
    type                 TEXT NOT NULL DEFAULT 'general',
    status               TEXT NOT NULL DEFAULT 'active'
                           CHECK (status IN ('active','paused','completed','archived')),
    owner_contact_id     INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
    workspace_dir        TEXT,
    storage_prefix       TEXT,
    tasks_db_uri         TEXT,
    db_path              TEXT,
    origin_instance_id   TEXT,
    tags                 TEXT,
    archived_at          TEXT,
    created_at           TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at           TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_project_spaces_slug   ON project_spaces(slug);
  CREATE INDEX IF NOT EXISTS idx_project_spaces_status ON project_spaces(status);
  CREATE INDEX IF NOT EXISTS idx_project_spaces_type   ON project_spaces(type);
`);

await initTable("project_members table", `
  CREATE TABLE IF NOT EXISTS project_members (
    id                       INTEGER PRIMARY KEY AUTOINCREMENT,
    uuid                     TEXT NOT NULL UNIQUE DEFAULT (lower(hex(randomblob(16)))),
    project_id               INTEGER NOT NULL REFERENCES project_spaces(id) ON DELETE CASCADE,
    contact_id               INTEGER REFERENCES contacts(id) ON DELETE CASCADE,
    role                     TEXT NOT NULL CHECK (role IN ('owner','editor','viewer','guest')),
    capabilities             TEXT,
    mode                     TEXT,
    granted_at               TEXT NOT NULL DEFAULT (datetime('now')),
    granted_by_contact_id    INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
    revoked_at               TEXT,
    origin_instance_id       TEXT
  );

  CREATE INDEX IF NOT EXISTS idx_project_members_project ON project_members(project_id);
  CREATE INDEX IF NOT EXISTS idx_project_members_contact ON project_members(contact_id);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_project_members_local_owner
    ON project_members(project_id) WHERE contact_id IS NULL AND revoked_at IS NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_project_members_remote
    ON project_members(project_id, contact_id) WHERE contact_id IS NOT NULL AND revoked_at IS NULL;
`);

await initTable("project_audit_log table", `
  CREATE TABLE IF NOT EXISTS project_audit_log (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id    INTEGER NOT NULL REFERENCES project_spaces(id) ON DELETE CASCADE,
    actor_type    TEXT NOT NULL CHECK (actor_type IN ('local','contact','bot','system')),
    actor_id      TEXT,
    action        TEXT NOT NULL,
    target        TEXT,
    payload       TEXT,
    created_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_project_audit_project ON project_audit_log(project_id, created_at DESC);
`);

// Project-scoping for storage files: M2 ACL gates uploads on this column,
// and crow_project_get joins on it for file counts. Added after the
// project_spaces table exists (FK target). project_id = NULL means the
// file is global / unscoped (legacy behavior preserved for existing rows).

// One-shot migration: copy any research_projects rows that aren't already in
// project_spaces. Idempotent — re-running init-db.js doesn't duplicate rows.
// Computes the rich slug in JS (instead of via a SQLite UDF, which would have
// to be registered on every libsql connection).
async function migrateLegacyProjectsToSpaces() {
  // B3b: on hosts where the dormant research_projects table has already been
  // dropped (and on fresh databases that never create it) there is nothing to
  // backfill — skip silently.
  const rpExists = (await db.execute({
    sql: "SELECT 1 FROM sqlite_master WHERE type='table' AND name='research_projects'",
  })).rows.length > 0;
  if (!rpExists) return;
  const dataDir = process.env.CROW_DB_PATH
    ? resolve(process.env.CROW_DB_PATH, "..")
    : resolveDataDir();

  const { rows: legacy } = await db.execute({
    sql: `SELECT rp.id, rp.uuid, rp.name, rp.description, rp.type, rp.status, rp.tags, rp.created_at, rp.updated_at
            FROM research_projects rp
            LEFT JOIN project_spaces ps ON ps.id = rp.id
           WHERE ps.id IS NULL`,
  });
  if (legacy.length === 0) return;

  for (const r of legacy) {
    const slug = slugify(r.name, r.id);
    const workspaceDir = workspacePathFor(dataDir, slug);
    const storagePrefix = storagePrefixFor(slug);

    try {
      mkdirSync(workspaceDir, { recursive: true });
    } catch (err) {
      console.warn(`Warning: could not create workspace dir ${workspaceDir}: ${err.message}`);
    }

    try {
      await db.execute({
        sql: `INSERT INTO project_spaces
                (id, uuid, slug, name, description, type, status, tags,
                 workspace_dir, storage_prefix, created_at, updated_at)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        args: [
          r.id,
          // Pre-B3a hosts carried rp.uuid (backfilled by the old addUuidColumn
          // pass); a raw pre-M0 table has no uuid column at all — mint one so
          // the ps NOT NULL constraint is satisfied either way.
          r.uuid ?? randomBytes(16).toString("hex"),
          slug,
          r.name,
          r.description ?? null,
          r.type ?? "general",
          r.status ?? "active",
          r.tags ?? null,
          workspaceDir,
          storagePrefix,
          r.created_at ?? null,
          r.updated_at ?? null,
        ],
      });
      await db.execute({
        sql: `INSERT INTO project_members (project_id, contact_id, role, granted_at)
              VALUES (?, NULL, 'owner', ?)`,
        args: [r.id, r.created_at ?? null],
      });
      console.log(`Migrated research_project #${r.id} → project_spaces (slug: ${slug})`);
    } catch (err) {
      console.warn(`Warning: could not migrate research_project #${r.id}: ${err.message}`);
    }
  }
}
await migrateLegacyProjectsToSpaces();

// Canonical-slug normalization pass.
//
// For workspace-less project_spaces rows (workspace_dir IS NULL) whose slug
// doesn't match slugify(name, id), update to canonical form. These are rows
// created by the SQL trigger, which uses a simpler replace-chain that doesn't
// strip diacritics (e.g. "Café Münze" → "café-münze-7" instead of
// "cafe-munze-7"). Rows WITH a workspace_dir keep their slug — filesystem
// coupling wins and the slug is stable after creation.
//
// Semantics: for workspace-less rows the slug intentionally follows the
// current name (a renamed legacy project re-slugs on next init-db run).
//
// Idempotent: re-running init-db is a no-op when all slugs are canonical.
(async function normalizeProjectSlugs() {
  const { rows } = await db.execute({
    sql: `SELECT id, name, slug FROM project_spaces WHERE workspace_dir IS NULL`,
  });
  for (const r of rows) {
    const canonical = slugify(r.name, r.id);
    if (r.slug !== canonical) {
      await db.execute({
        sql: `UPDATE project_spaces SET slug = ? WHERE id = ? AND workspace_dir IS NULL`,
        args: [canonical, r.id],
      });
      console.log(`Normalized slug for project_spaces #${r.id}: "${r.slug}" → "${canonical}"`);
    }
  }
})();

// W2-5B3a (2026-06-12): the rp→ps forward triggers are RETIRED. All readers
// (B1) and writers (B2) use project_spaces. B3b (same day) drops the dormant
// research_projects table itself via the guarded migration at the end of this
// file — these trigger DROPs stay so any host that skipped B3a still
// converges. The migrateLegacyProjectsToSpaces backstop above self-heals any
// unmirrored rows BEFORE the drop guard will allow the table to go.
await initTable("retire rp→ps forward triggers (B3a)", `
  DROP TRIGGER IF EXISTS tr_rp_to_ps_ins;
  DROP TRIGGER IF EXISTS tr_rp_to_ps_upd;
  DROP TRIGGER IF EXISTS tr_rp_to_ps_del;
`);

await initTable("sources FTS index", `
  CREATE VIRTUAL TABLE IF NOT EXISTS sources_fts USING fts5(
    title, authors, abstract, content_summary, full_text, tags, citation_apa,
    content=research_sources,
    content_rowid=id
  );
`);

await initTable("sources FTS triggers and notes table", `
  CREATE TRIGGER IF NOT EXISTS sources_ai AFTER INSERT ON research_sources BEGIN
    INSERT INTO sources_fts(rowid, title, authors, abstract, content_summary, full_text, tags, citation_apa)
    VALUES (new.id, new.title, new.authors, new.abstract, new.content_summary, new.full_text, new.tags, new.citation_apa);
  END;

  CREATE TRIGGER IF NOT EXISTS sources_ad AFTER DELETE ON research_sources BEGIN
    INSERT INTO sources_fts(sources_fts, rowid, title, authors, abstract, content_summary, full_text, tags, citation_apa)
    VALUES ('delete', old.id, old.title, old.authors, old.abstract, old.content_summary, old.full_text, old.tags, old.citation_apa);
  END;

  CREATE TRIGGER IF NOT EXISTS sources_au AFTER UPDATE ON research_sources BEGIN
    INSERT INTO sources_fts(sources_fts, rowid, title, authors, abstract, content_summary, full_text, tags, citation_apa)
    VALUES ('delete', old.id, old.title, old.authors, old.abstract, old.content_summary, old.full_text, old.tags, old.citation_apa);
    INSERT INTO sources_fts(rowid, title, authors, abstract, content_summary, full_text, tags, citation_apa)
    VALUES (new.id, new.title, new.authors, new.abstract, new.content_summary, new.full_text, new.tags, new.citation_apa);
  END;

  CREATE TABLE IF NOT EXISTS research_notes (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER,
    source_id INTEGER,
    title TEXT,
    content TEXT NOT NULL,
    note_type TEXT DEFAULT 'note' CHECK(note_type IN ('note', 'quote', 'summary', 'analysis', 'question', 'insight')),
    tags TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (project_id) REFERENCES project_spaces(id) ON DELETE SET NULL,
    FOREIGN KEY (source_id) REFERENCES research_sources(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_notes_project ON research_notes(project_id);
  CREATE INDEX IF NOT EXISTS idx_notes_source ON research_notes(source_id);
`);

// --- OAuth Tables (for mobile gateway) ---

await initTable("OAuth tables", `
  CREATE TABLE IF NOT EXISTS oauth_clients (
    client_id TEXT PRIMARY KEY,
    metadata TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE TABLE IF NOT EXISTS oauth_tokens (
    token TEXT PRIMARY KEY,
    token_type TEXT NOT NULL CHECK(token_type IN ('access', 'refresh')),
    client_id TEXT NOT NULL,
    scopes TEXT DEFAULT '',
    resource TEXT,
    expires_at TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_tokens_client ON oauth_tokens(client_id);
  CREATE INDEX IF NOT EXISTS idx_tokens_type ON oauth_tokens(token_type);
`);

// --- P2P Sharing Tables ---

await initTable("contacts table", `
  CREATE TABLE IF NOT EXISTS contacts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    crow_id TEXT NOT NULL UNIQUE,
    display_name TEXT,
    ed25519_pubkey TEXT NOT NULL,
    secp256k1_pubkey TEXT NOT NULL,
    relay_url TEXT,
    is_blocked INTEGER DEFAULT 0,
    last_seen TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_contacts_crow_id ON contacts(crow_id);
  CREATE INDEX IF NOT EXISTS idx_contacts_blocked ON contacts(is_blocked);
`);

// Migrate shared_items: remove CHECK constraint on share_type for extensibility (blog_post, file, etc.)
await (async () => {
  try {
    // Check if old CHECK constraint exists by trying to read table schema
    const tableInfo = await db.execute("SELECT sql FROM sqlite_master WHERE type='table' AND name='shared_items'");
    const sql = tableInfo.rows[0]?.sql || "";
    if (sql.includes("CHECK(share_type IN")) {
      console.log("Migrating shared_items table (removing share_type CHECK constraint)...");
      await db.executeMultiple(`
        BEGIN IMMEDIATE;
        CREATE TABLE shared_items_new (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          contact_id INTEGER NOT NULL,
          share_type TEXT NOT NULL,
          item_id INTEGER NOT NULL,
          permissions TEXT DEFAULT 'read' CHECK(permissions IN ('read', 'read-write', 'one-time')),
          direction TEXT NOT NULL CHECK(direction IN ('sent', 'received')),
          delivery_status TEXT DEFAULT 'pending' CHECK(delivery_status IN ('pending', 'delivered', 'failed')),
          created_at TEXT DEFAULT (datetime('now')),
          FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
        );
        INSERT INTO shared_items_new SELECT * FROM shared_items;
        DROP TABLE shared_items;
        ALTER TABLE shared_items_new RENAME TO shared_items;
        CREATE INDEX IF NOT EXISTS idx_shared_items_contact ON shared_items(contact_id);
        CREATE INDEX IF NOT EXISTS idx_shared_items_type ON shared_items(share_type);
        CREATE INDEX IF NOT EXISTS idx_shared_items_direction ON shared_items(direction);
        COMMIT;
      `);
      console.log("shared_items migration complete.");
    }
  } catch {
    // Table doesn't exist yet — will be created below
  }
})();

await initTable("shared_items table", `
  CREATE TABLE IF NOT EXISTS shared_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id INTEGER NOT NULL,
    share_type TEXT NOT NULL,
    item_id INTEGER NOT NULL,
    permissions TEXT DEFAULT 'read' CHECK(permissions IN ('read', 'read-write', 'one-time')),
    direction TEXT NOT NULL CHECK(direction IN ('sent', 'received')),
    delivery_status TEXT DEFAULT 'pending' CHECK(delivery_status IN ('pending', 'delivered', 'failed')),
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_shared_items_contact ON shared_items(contact_id);
  CREATE INDEX IF NOT EXISTS idx_shared_items_type ON shared_items(share_type);
  CREATE INDEX IF NOT EXISTS idx_shared_items_direction ON shared_items(direction);
`);

// W4-2 B: track whether a queued share is a project clone ("clone") or a plain
// share row (NULL).  Placed after the initTable block so that the fresh-DB path
// runs in the right order.  The rebuild-migration CREATE at ~:550 intentionally
// omits this column because its SELECT * runs before mode exists on first new-code
// run; addColumnIfMissing is idempotent and safe on both fresh and existing DBs.
await addColumnIfMissing("shared_items", "mode", "TEXT");

await initTable("messages table", `
  CREATE TABLE IF NOT EXISTS messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    contact_id INTEGER NOT NULL,
    nostr_event_id TEXT UNIQUE,
    content TEXT NOT NULL,
    direction TEXT NOT NULL CHECK(direction IN ('sent', 'received')),
    is_read INTEGER DEFAULT 0,
    thread_id TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_messages_contact ON messages(contact_id);
  CREATE INDEX IF NOT EXISTS idx_messages_thread ON messages(thread_id);
  CREATE INDEX IF NOT EXISTS idx_messages_read ON messages(is_read);
`);

await initTable("relay_config table", `
  CREATE TABLE IF NOT EXISTS relay_config (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    relay_url TEXT NOT NULL UNIQUE,
    relay_type TEXT NOT NULL CHECK(relay_type IN ('nostr', 'peer')),
    enabled INTEGER DEFAULT 1,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_relay_config_type ON relay_config(relay_type);
`);

// --- Relay Store-and-Forward Blobs ---

await initTable("relay_blobs table", `
  CREATE TABLE IF NOT EXISTS relay_blobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    recipient_pubkey TEXT NOT NULL,
    blob TEXT NOT NULL,
    sender_pubkey TEXT NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    expires_at TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_relay_blobs_recipient ON relay_blobs(recipient_pubkey);
  CREATE INDEX IF NOT EXISTS idx_relay_blobs_expires ON relay_blobs(expires_at);
`);

// --- Contact Discovery ---

await addColumnIfMissing("contacts", "email_hash", "TEXT");

// --- Messages: attachments and threading ---
await addColumnIfMissing("messages", "attachments", "TEXT");

// --- Cross-Platform Behavioral Context (crow.md) ---

await initTable("crow_context table", `
  CREATE TABLE IF NOT EXISTS crow_context (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    section_key TEXT NOT NULL,
    section_title TEXT NOT NULL,
    content TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0,
    enabled INTEGER DEFAULT 1,
    updated_at TEXT DEFAULT (datetime('now')),
    device_id TEXT DEFAULT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_crow_context_order ON crow_context(sort_order);
`);

// --- Storage Tables ---

await initTable("storage_files table", `
  CREATE TABLE IF NOT EXISTS storage_files (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    s3_key TEXT NOT NULL UNIQUE,
    original_name TEXT NOT NULL,
    mime_type TEXT,
    size_bytes INTEGER,
    bucket TEXT DEFAULT 'crow-files',
    uploaded_by TEXT,
    reference_type TEXT,
    reference_id INTEGER,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_storage_files_ref ON storage_files(reference_type, reference_id);
`);

// --- Blog Tables ---

await initTable("blog_posts table", `
  CREATE TABLE IF NOT EXISTS blog_posts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    slug TEXT NOT NULL UNIQUE,
    title TEXT NOT NULL,
    content TEXT NOT NULL,
    excerpt TEXT,
    author TEXT,
    status TEXT DEFAULT 'draft' CHECK(status IN ('draft', 'published', 'archived')),
    visibility TEXT DEFAULT 'private' CHECK(visibility IN ('private', 'public', 'peers')),
    cover_image_key TEXT,
    tags TEXT,
    nostr_event_id TEXT,
    published_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

await initTable("blog_posts FTS index", `
  CREATE VIRTUAL TABLE IF NOT EXISTS blog_posts_fts USING fts5(
    title, content, excerpt, tags,
    content=blog_posts,
    content_rowid=id
  );
`);

await initTable("blog_posts FTS triggers", `
  CREATE TRIGGER IF NOT EXISTS blog_posts_ai AFTER INSERT ON blog_posts BEGIN
    INSERT INTO blog_posts_fts(rowid, title, content, excerpt, tags)
    VALUES (new.id, new.title, new.content, new.excerpt, new.tags);
  END;

  CREATE TRIGGER IF NOT EXISTS blog_posts_ad AFTER DELETE ON blog_posts BEGIN
    INSERT INTO blog_posts_fts(blog_posts_fts, rowid, title, content, excerpt, tags)
    VALUES ('delete', old.id, old.title, old.content, old.excerpt, old.tags);
  END;

  CREATE TRIGGER IF NOT EXISTS blog_posts_au AFTER UPDATE ON blog_posts BEGIN
    INSERT INTO blog_posts_fts(blog_posts_fts, rowid, title, content, excerpt, tags)
    VALUES ('delete', old.id, old.title, old.content, old.excerpt, old.tags);
    INSERT INTO blog_posts_fts(rowid, title, content, excerpt, tags)
    VALUES (new.id, new.title, new.content, new.excerpt, new.tags);
  END;
`);

// --- Meta-glasses note sessions (Phase 6) ---

await initTable("glasses_note_sessions table", `
  CREATE TABLE IF NOT EXISTS glasses_note_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    topic TEXT,
    mode TEXT NOT NULL CHECK(mode IN ('dictation','session','continuous')),
    started_at TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at TEXT,
    status TEXT NOT NULL DEFAULT 'active' CHECK(status IN ('active','ended','cancelled')),
    project_id INTEGER,
    note_id INTEGER,
    summary TEXT,
    action_items_json TEXT,
    lamport_ts INTEGER DEFAULT 0
  );
`);
await initTable("glasses_note_sessions index", `
  CREATE INDEX IF NOT EXISTS idx_note_sessions_device_status
    ON glasses_note_sessions(device_id, status);
`);

// Phase 6 C.1: action-item confirmation retry budget + raw LLM output
// for parse-error debugging. addColumnIfMissing on SQLite leaves
// pre-existing rows with NULL — read sites must use COALESCE(confirm_retry_count, 0).
await addColumnIfMissing("glasses_note_sessions", "confirm_retry_count", "INTEGER DEFAULT 0");
await addColumnIfMissing("glasses_note_sessions", "summary_raw", "TEXT");

// Phase 6 C.3: continuous-mode consent gate. Start tool sets
// awaiting_consent=1 + consent_expires_at=now+120s; confirm tool
// requires both. addColumnIfMissing leaves old rows NULL — read sites
// MUST use COALESCE(awaiting_consent, 0) = 1.
await addColumnIfMissing("glasses_note_sessions", "awaiting_consent", "INTEGER DEFAULT 0");
await addColumnIfMissing("glasses_note_sessions", "consent_expires_at", "TEXT");

// Phase 6 C.1: research_notes.updated_at was referenced by Phase 6
// crow_glasses_add_to_note (commit 9783a8b) but the column was never
// added to the schema, so the UPDATE silently errored under the
// tool's try/catch. Adding it here makes the dictation append actually
// persist its timestamp; legacy rows get NULL until first edit.
await addColumnIfMissing("research_notes", "updated_at", "TEXT");

// --- W2-5 B2: FK re-pointing (research_sources, research_notes, data_backends) ---
//
// SQLite cannot ALTER a foreign key — each affected table must be rebuilt.
// This function is idempotent: it skips any table whose FK already targets
// project_spaces (detected via PRAGMA foreign_key_list).
//
// Mandatory invariants (spec Part 1, rounds 1+2):
//   - PRAGMA foreign_keys OFF/ON outside all transactions
//   - Per-table BEGIN IMMEDIATE with explicit ROLLBACK on error
//   - Index DDL snapshotted from sqlite_master (never hand-listed)
//   - sqlite_sequence captured before DROP, restored via UPDATE then
//     INSERT-only-on-0-changes after RENAME (AUTOINCREMENT id-reuse prevention)
//   - Abort on unknown column (pre-DDL, old table intact)
//   - FTS triggers recreated for research_sources; FTS integrity-check after
//   - PRAGMA foreign_key_check per rebuilt table; abort on violations
//
async function rebuildMainFKsToProjectSpaces() {
  // ------------------------------------------------------------------
  // Canonical new DDL + per-table known live-extra columns
  // (spec N1: enumerated per-table for ALL tables; abort on unknown)
  // ------------------------------------------------------------------
  const TABLE_SPECS = {
    research_sources: {
      isAutoincrement: true,
      newDdl: `CREATE TABLE research_sources_new (
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
    backend_id INTEGER REFERENCES data_backends(id) ON DELETE SET NULL,
    uuid TEXT,
    origin_instance_id TEXT,
    file_path TEXT,
    s3_key TEXT,
    FOREIGN KEY (project_id) REFERENCES project_spaces(id) ON DELETE SET NULL
  )`,
      // columns known to be added via addColumnIfMissing / addUuidColumn
      // (spec C2: backend_id would be silently lost if derived from PRAGMA table_info alone).
      // file_path + s3_key: legacy host-local columns (found on grackle at the
      // 2026-06-11 deploy, 16 rows of real data each) — carried by the rebuild;
      // NOT part of the canonical fresh-install schema.
      knownExtras: ["backend_id", "uuid", "origin_instance_id", "file_path", "s3_key"],
      canonicalColumns: [
        "id", "project_id", "title", "source_type", "url", "authors",
        "publication_date", "publisher", "doi", "isbn", "abstract",
        "content_summary", "full_text", "citation_apa", "retrieval_date",
        "retrieval_method", "verified", "verification_notes", "tags",
        "relevance_score", "created_at",
      ],
    },
    research_notes: {
      isAutoincrement: true,
      newDdl: `CREATE TABLE research_notes_new (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    project_id INTEGER,
    source_id INTEGER,
    title TEXT,
    content TEXT NOT NULL,
    note_type TEXT DEFAULT 'note' CHECK(note_type IN ('note', 'quote', 'summary', 'analysis', 'question', 'insight')),
    tags TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    lamport_ts INTEGER DEFAULT 0,
    updated_at TEXT,
    uuid TEXT,
    origin_instance_id TEXT,
    FOREIGN KEY (project_id) REFERENCES project_spaces(id) ON DELETE SET NULL,
    FOREIGN KEY (source_id) REFERENCES research_sources(id) ON DELETE SET NULL
  )`,
      knownExtras: ["lamport_ts", "updated_at", "uuid", "origin_instance_id"],
      canonicalColumns: [
        "id", "project_id", "source_id", "title", "content", "note_type",
        "tags", "created_at",
      ],
    },
    data_backends: {
      isAutoincrement: true,
      newDdl: `CREATE TABLE data_backends_new (
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
    FOREIGN KEY (project_id) REFERENCES project_spaces(id) ON DELETE CASCADE
  )`,
      knownExtras: ["uuid", "origin_instance_id"],
      canonicalColumns: [
        "id", "project_id", "name", "backend_type", "connection_ref",
        "schema_info", "status", "last_connected_at", "last_error", "tags",
        "created_at", "updated_at",
      ],
    },
  };

  // PRAGMA foreign_keys OFF must be outside any transaction (spec step 2)
  await db.execute("PRAGMA foreign_keys = OFF");

  try {
    for (const [tableName, spec] of Object.entries(TABLE_SPECS)) {
      // Step 1: detect — skip if already points at project_spaces
      const { rows: fkList } = await db.execute(
        `PRAGMA foreign_key_list(${tableName})`
      );
      const hasRpRef = fkList.some(
        (r) => r.table === "research_projects" && r.from === "project_id"
      );
      if (!hasRpRef) {
        // Already rebuilt or never needed — skip
        continue;
      }

      console.log(`[W2-5 B2] Rebuilding ${tableName} FK → project_spaces …`);

      // Step 3: snapshot index DDL from sqlite_master (never hand-list — spec C3)
      const { rows: idxRows } = await db.execute({
        sql: `SELECT name, sql FROM sqlite_master WHERE type='index' AND tbl_name=? AND sql IS NOT NULL`,
        args: [tableName],
      });

      // Verify no unknown columns before any DDL (spec C2 + N1)
      const { rows: colRows } = await db.execute(
        `PRAGMA table_info(${tableName})`
      );
      // Per-table column set (spec D2 fix: a merged union across tables would
      // let a column belonging to table A slip through unnoticed on table B)
      const canonicalCols = new Set([...spec.canonicalColumns, ...spec.knownExtras]);
      for (const col of colRows) {
        if (!canonicalCols.has(col.name)) {
          await db.execute("PRAGMA foreign_keys = ON");
          throw new Error(
            `[W2-5 B2] Unknown column ${tableName}.${col.name} — add it to the rebuild's extras list (and test fixture) or remove the column`
          );
        }
      }

      // Step 4: capture sqlite_sequence before DROP (spec C1)
      let capturedSeq = null;
      if (spec.isAutoincrement) {
        const { rows: seqRows } = await db.execute({
          sql: `SELECT seq FROM sqlite_sequence WHERE name = ?`,
          args: [tableName],
        });
        capturedSeq = seqRows.length > 0 ? Number(seqRows[0].seq) : 0;
      }

      // Step 5: rebuild inside one BEGIN IMMEDIATE transaction (spec step 5)
      // Explicit column lists — rowids preserved (FTS content_rowid + FK targets)
      const colList = colRows.map((c) => c.name).join(", ");

      try {
        await db.executeMultiple(`BEGIN IMMEDIATE`);

        await db.execute(`${spec.newDdl}`);

        await db.execute({
          sql: `INSERT INTO ${tableName}_new (${colList}) SELECT ${colList} FROM ${tableName}`,
        });

        await db.execute(`DROP TABLE ${tableName}`);
        await db.execute(`ALTER TABLE ${tableName}_new RENAME TO ${tableName}`);

        // Recreate all snapshotted indexes (spec C3)
        for (const idx of idxRows) {
          await db.execute(idx.sql);
        }

        // Restore sqlite_sequence (spec C1 + N2)
        // RENAME carries t_new's row → a row always exists post-RENAME
        // UPDATE first; INSERT only if 0 rows changed (N2: unconditional INSERT duplicates)
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

        // research_sources only: recreate FTS triggers (DROP TABLE killed them)
        if (tableName === "research_sources") {
          await db.execute(`
            CREATE TRIGGER IF NOT EXISTS sources_ai AFTER INSERT ON research_sources BEGIN
              INSERT INTO sources_fts(rowid, title, authors, abstract, content_summary, full_text, tags, citation_apa)
              VALUES (new.id, new.title, new.authors, new.abstract, new.content_summary, new.full_text, new.tags, new.citation_apa);
            END
          `);
          await db.execute(`
            CREATE TRIGGER IF NOT EXISTS sources_ad AFTER DELETE ON research_sources BEGIN
              INSERT INTO sources_fts(sources_fts, rowid, title, authors, abstract, content_summary, full_text, tags, citation_apa)
              VALUES ('delete', old.id, old.title, old.authors, old.abstract, old.content_summary, old.full_text, old.tags, old.citation_apa);
            END
          `);
          await db.execute(`
            CREATE TRIGGER IF NOT EXISTS sources_au AFTER UPDATE ON research_sources BEGIN
              INSERT INTO sources_fts(sources_fts, rowid, title, authors, abstract, content_summary, full_text, tags, citation_apa)
              VALUES ('delete', old.id, old.title, old.authors, old.abstract, old.content_summary, old.full_text, old.tags, old.citation_apa);
              INSERT INTO sources_fts(rowid, title, authors, abstract, content_summary, full_text, tags, citation_apa)
              VALUES (new.id, new.title, new.authors, new.abstract, new.content_summary, new.full_text, new.tags, new.citation_apa);
            END
          `);
        }

        await db.executeMultiple(`COMMIT`);
      } catch (err) {
        // Explicit ROLLBACK on error (spec C5 — abandoned open txn holds the write lock)
        try { await db.executeMultiple(`ROLLBACK`); } catch {}
        await db.execute("PRAGMA foreign_keys = ON");
        throw err;
      }

      // FTS integrity check for research_sources (after COMMIT — spec step 5)
      if (tableName === "research_sources") {
        try {
          await db.execute(`INSERT INTO sources_fts(sources_fts) VALUES('integrity-check')`);
        } catch (ftsErr) {
          await db.execute("PRAGMA foreign_keys = ON");
          throw new Error(`[W2-5 B2] sources_fts integrity-check failed after rebuild: ${ftsErr.message}`);
        }
      }

      // Step 6: foreign_key_check per rebuilt table (spec step 6)
      const { rows: fkViolations } = await db.execute(
        `PRAGMA foreign_key_check(${tableName})`
      );
      if (fkViolations.length > 0) {
        await db.execute("PRAGMA foreign_keys = ON");
        throw new Error(
          `[W2-5 B2] PRAGMA foreign_key_check(${tableName}) returned ${fkViolations.length} violation(s) after rebuild`
        );
      }

      console.log(`[W2-5 B2] ${tableName} rebuilt successfully → project_spaces`);
    }
  } finally {
    // PRAGMA foreign_keys ON must be outside any transaction (spec step 2)
    await db.execute("PRAGMA foreign_keys = ON");
  }
}

// Placement: after research_notes.updated_at (:773), after addUuidColumn (:194),
// after migrateLegacyProjectsToSpaces (:349) — spec step 7.
await rebuildMainFKsToProjectSpaces();

// W2-5 B2: PII purge — archived learner ps rows are residue of pre-B2 parental
// deletions whose data was meant to be gone (B1 privacy commitment). Idempotent.
await db.execute(
  `DELETE FROM project_spaces WHERE type = 'learner_profile' AND archived_at IS NOT NULL`
);

// Phase 6 C.2: caption fill-in tracking. crow_glasses_capture_and_attach_photo
// inserts the markdown ref + a backfill row immediately; the scheduler's
// runCaptionBackfill replaces the `[caption pending]` placeholder once the
// auto-caption from recordGlassesPhoto's vision pipeline lands. Restart-safe
// (a setTimeout would be lost on gateway restart). Caps at 5 attempts before
// giving up and leaving the placeholder for operator edit.
await initTable("glasses_caption_backfill table", `
  CREATE TABLE IF NOT EXISTS glasses_caption_backfill (
    note_id INTEGER NOT NULL,
    photo_id INTEGER NOT NULL,
    requested_at TEXT NOT NULL DEFAULT (datetime('now')),
    attempts INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (note_id, photo_id)
  );
`);

// --- Meta-glasses photo library (Phase 5) ---

await initTable("glasses_photos table", `
  CREATE TABLE IF NOT EXISTS glasses_photos (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    device_id TEXT NOT NULL,
    captured_at TEXT NOT NULL DEFAULT (datetime('now')),
    minio_key TEXT,
    disk_path TEXT,
    caption TEXT,
    ocr_text TEXT,
    mime TEXT NOT NULL,
    size_bytes INTEGER NOT NULL
  );
`);
await initTable("glasses_photos index", `
  CREATE INDEX IF NOT EXISTS idx_glasses_photos_device_time
    ON glasses_photos(device_id, captured_at DESC);
`);
await initTable("glasses_photos FTS index", `
  CREATE VIRTUAL TABLE IF NOT EXISTS glasses_photos_fts USING fts5(
    caption, ocr_text,
    content=glasses_photos,
    content_rowid=id,
    tokenize='unicode61'
  );
`);
await initTable("glasses_photos FTS triggers", `
  CREATE TRIGGER IF NOT EXISTS glasses_photos_ai AFTER INSERT ON glasses_photos BEGIN
    INSERT INTO glasses_photos_fts(rowid, caption, ocr_text)
    VALUES (new.id, new.caption, new.ocr_text);
  END;

  CREATE TRIGGER IF NOT EXISTS glasses_photos_ad AFTER DELETE ON glasses_photos BEGIN
    INSERT INTO glasses_photos_fts(glasses_photos_fts, rowid, caption, ocr_text)
    VALUES ('delete', old.id, old.caption, old.ocr_text);
  END;

  CREATE TRIGGER IF NOT EXISTS glasses_photos_au AFTER UPDATE ON glasses_photos BEGIN
    INSERT INTO glasses_photos_fts(glasses_photos_fts, rowid, caption, ocr_text)
    VALUES ('delete', old.id, old.caption, old.ocr_text);
    INSERT INTO glasses_photos_fts(rowid, caption, ocr_text)
    VALUES (new.id, new.caption, new.ocr_text);
  END;
`);

// --- Dashboard Settings ---

await initTable("dashboard_settings table", `
  CREATE TABLE IF NOT EXISTS dashboard_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

// --- MCP Session Log ---

await initTable("mcp_sessions table", `
  CREATE TABLE IF NOT EXISTS mcp_sessions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    session_id TEXT NOT NULL,
    transport TEXT NOT NULL,
    server_name TEXT NOT NULL,
    client_info TEXT,
    tool_calls_summary TEXT,
    tool_call_count INTEGER DEFAULT 0,
    started_at TEXT DEFAULT (datetime('now')),
    ended_at TEXT,
    last_activity_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_mcp_sessions_started ON mcp_sessions(started_at DESC);
  CREATE INDEX IF NOT EXISTS idx_mcp_sessions_server ON mcp_sessions(server_name);
`);

// --- Audit Log ---

await initTable("audit_log table", `
  CREATE TABLE IF NOT EXISTS audit_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    event_type TEXT NOT NULL,
    actor TEXT,
    ip_address TEXT,
    details TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_audit_log_event_created ON audit_log(event_type, created_at);
`);

// --- F.11: Moderation Actions (queued destructive moderation) ---
// Bundles (gotosocial, funkwhale, pixelfed, lemmy, mastodon, peertube) INSERT
// rows here when an AI invokes a destructive moderation verb. The operator
// confirms from the Nest panel before the action fires.
await initTable("moderation_actions table", `
  CREATE TABLE IF NOT EXISTS moderation_actions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    bundle_id TEXT NOT NULL,
    action_type TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    requested_by TEXT NOT NULL,
    requested_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    confirmed_by TEXT,
    confirmed_at INTEGER,
    error TEXT,
    idempotency_key TEXT UNIQUE NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_moderation_actions_status ON moderation_actions(status, expires_at);
  CREATE INDEX IF NOT EXISTS idx_moderation_actions_bundle ON moderation_actions(bundle_id, requested_at DESC);
`);

// --- F.11: Identity Attestations ---
// Crow's root Ed25519 identity signs per-app handles so remote viewers can
// verify "these handles belong to the same root identity" via the gateway's
// /.well-known/crow-identity.json endpoint. version + revoked_at support
// key rotation.
await initTable("identity_attestations table", `
  CREATE TABLE IF NOT EXISTS identity_attestations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    crow_id TEXT NOT NULL,
    app TEXT NOT NULL,
    external_handle TEXT NOT NULL,
    app_pubkey TEXT,
    sig TEXT NOT NULL,
    version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    revoked_at INTEGER
  );

  CREATE INDEX IF NOT EXISTS idx_identity_attestations_crow ON identity_attestations(crow_id, app);
  CREATE INDEX IF NOT EXISTS idx_identity_attestations_active ON identity_attestations(app, external_handle) WHERE revoked_at IS NULL;
  CREATE UNIQUE INDEX IF NOT EXISTS idx_identity_attestations_uniq ON identity_attestations(crow_id, app, external_handle, version);
`);

await initTable("identity_attestation_revocations table", `
  CREATE TABLE IF NOT EXISTS identity_attestation_revocations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    attestation_id INTEGER NOT NULL REFERENCES identity_attestations(id) ON DELETE CASCADE,
    revoked_at INTEGER NOT NULL,
    reason TEXT,
    sig TEXT NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_identity_attestation_revocations_attestation ON identity_attestation_revocations(attestation_id);
  CREATE INDEX IF NOT EXISTS idx_identity_attestation_revocations_revoked_at ON identity_attestation_revocations(revoked_at DESC);
`);

// Extend contacts with external_handle + external_source so discovered
// federated contacts (Mastodon follows, Lemmy community subscribers, etc.)
// can be linked to the local contacts table.
await addColumnIfMissing("contacts", "external_handle", "TEXT");
await addColumnIfMissing("contacts", "external_source", "TEXT");

// --- F.12: Crosspost rules + log ---
// crosspost_rules holds the operator's opt-in config: "when a new post appears
// in app X, publish a transformed copy to app Y". Triggers: on_publish (with
// 60s grace), on_tag:<tag>, manual.
// crosspost_log is the idempotency + audit log — duplicate idempotency keys
// within 7 days return the cached result; entries >30 days are GC'd daily.
await initTable("crosspost_rules table", `
  CREATE TABLE IF NOT EXISTS crosspost_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_app TEXT NOT NULL,
    source_trigger TEXT NOT NULL,
    target_app TEXT NOT NULL,
    transform TEXT,
    active INTEGER DEFAULT 1,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_crosspost_rules_active ON crosspost_rules(active, source_app, source_trigger);
`);

await initTable("crosspost_log table", `
  CREATE TABLE IF NOT EXISTS crosspost_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    idempotency_key TEXT NOT NULL,
    source_app TEXT NOT NULL,
    source_post_id TEXT NOT NULL,
    target_app TEXT NOT NULL,
    transform TEXT,
    status TEXT NOT NULL DEFAULT 'queued',
    target_post_id TEXT,
    error TEXT,
    scheduled_at INTEGER NOT NULL,
    published_at INTEGER,
    cancelled_at INTEGER,
    created_at INTEGER NOT NULL,
    transformed_payload_json TEXT
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_crosspost_log_idem ON crosspost_log(idempotency_key, source_app, target_app);
  CREATE INDEX IF NOT EXISTS idx_crosspost_log_scheduled ON crosspost_log(status, scheduled_at);
  CREATE INDEX IF NOT EXISTS idx_crosspost_log_created ON crosspost_log(created_at DESC);
`);

// F.13: scheduler needs the transformed payload to publish. Pre-F.13 DBs have
// the table without the column (fresh DBs get it in the CREATE above). Earlier
// F.12 rows will have NULL — the scheduler treats NULL as "manually handled".
await addColumnIfMissing("crosspost_log", "transformed_payload_json", "TEXT");

// --- Per-Device Context Support ---
// Existing installs have section_key UNIQUE constraint that blocks device overrides.
// Migration: add device_id column, drop the old UNIQUE constraint, add partial indexes.

await addColumnIfMissing("crow_context", "device_id", "TEXT DEFAULT NULL");

// Check if the old autoindex (from section_key UNIQUE) exists and drop it by
// recreating the table without the column-level UNIQUE constraint.
try {
  const { rows: autoIdx } = await db.execute(
    "SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='crow_context' AND name LIKE 'sqlite_autoindex%'"
  );
  if (autoIdx.length > 0) {
    // Recreate table without the column-level UNIQUE on section_key
    await db.executeMultiple(`
      CREATE TABLE IF NOT EXISTS crow_context_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        section_key TEXT NOT NULL,
        section_title TEXT NOT NULL,
        content TEXT NOT NULL,
        sort_order INTEGER DEFAULT 0,
        enabled INTEGER DEFAULT 1,
        updated_at TEXT DEFAULT (datetime('now')),
        device_id TEXT DEFAULT NULL
      );
      INSERT OR IGNORE INTO crow_context_new (id, section_key, section_title, content, sort_order, enabled, updated_at, device_id)
        SELECT id, section_key, section_title, content, sort_order, enabled, updated_at, device_id FROM crow_context;
      DROP TABLE crow_context;
      ALTER TABLE crow_context_new RENAME TO crow_context;
      CREATE INDEX IF NOT EXISTS idx_crow_context_order ON crow_context(sort_order);
      CREATE UNIQUE INDEX IF NOT EXISTS idx_crow_context_global
        ON crow_context(section_key)
        WHERE device_id IS NULL;
      CREATE UNIQUE INDEX IF NOT EXISTS idx_crow_context_device
        ON crow_context(section_key, device_id)
        WHERE device_id IS NOT NULL;
    `);
    console.log("  Migrated crow_context: removed column-level UNIQUE, added partial indexes");
  }
} catch (err) {
  // If migration fails, create the indexes anyway (may already exist)
  console.warn("  crow_context migration note:", err.message);
}

// Ensure partial indexes exist (for both new and migrated installs)
try {
  await db.execute(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_crow_context_global
      ON crow_context(section_key)
      WHERE device_id IS NULL
  `);
  await db.execute(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_crow_context_device
      ON crow_context(section_key, device_id)
      WHERE device_id IS NOT NULL
  `);
} catch {
  // Indexes already exist
}

// --- Scoped Memory: instance_id + project_id ---
// instance_id = origin instance (which Crow instance created this memory)
// project_id = project scope (optional, for project-specific memories)
// These are NOT in the FTS5 index — search uses JOIN filtering on the memories table.

await addColumnIfMissing("memories", "instance_id", "TEXT DEFAULT NULL");
await addColumnIfMissing("memories", "project_id", "INTEGER DEFAULT NULL");

try {
  await db.execute("CREATE INDEX IF NOT EXISTS idx_memories_instance_id ON memories(instance_id)");
  await db.execute("CREATE INDEX IF NOT EXISTS idx_memories_project_id ON memories(project_id)");
} catch {}

// --- Scoped Context: project_id ---
// Extends per-device overrides with per-project overrides.
// A section can exist: globally (both NULL), per-device, per-project, or per-device+project.

await addColumnIfMissing("crow_context", "project_id", "INTEGER DEFAULT NULL");

// Recreate unique indexes to include project_id dimension.
// The old indexes (idx_crow_context_global, idx_crow_context_device) only cover
// device_id — they need to be replaced with indexes that also consider project_id.
try {
  // Drop old indexes (safe — CREATE IF NOT EXISTS won't collide)
  await db.execute("DROP INDEX IF EXISTS idx_crow_context_global");
  await db.execute("DROP INDEX IF EXISTS idx_crow_context_device");

  // Global: section_key unique when both device_id and project_id are NULL
  await db.execute(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_crow_context_global
      ON crow_context(section_key)
      WHERE device_id IS NULL AND project_id IS NULL
  `);

  // Device-only: unique per (section_key, device_id) when project_id is NULL
  await db.execute(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_crow_context_device
      ON crow_context(section_key, device_id)
      WHERE device_id IS NOT NULL AND project_id IS NULL
  `);

  // Project-only: unique per (section_key, project_id) when device_id is NULL
  await db.execute(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_crow_context_project
      ON crow_context(section_key, project_id)
      WHERE project_id IS NOT NULL AND device_id IS NULL
  `);

  // Device+project: unique per (section_key, device_id, project_id) when both set
  await db.execute(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_crow_context_device_project
      ON crow_context(section_key, device_id, project_id)
      WHERE device_id IS NOT NULL AND project_id IS NOT NULL
  `);
} catch (err) {
  console.warn("  crow_context project_id index note:", err.message);
}

// --- Notifications ---

await initTable("notifications table", `
  CREATE TABLE IF NOT EXISTS notifications (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    type TEXT NOT NULL DEFAULT 'system',
    source TEXT,
    title TEXT NOT NULL,
    body TEXT,
    priority TEXT DEFAULT 'normal',
    action_url TEXT,
    metadata TEXT,
    is_read INTEGER DEFAULT 0,
    is_dismissed INTEGER DEFAULT 0,
    snoozed_until TEXT,
    schedule_id INTEGER,
    expires_at TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (schedule_id) REFERENCES schedules(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_notifications_unread ON notifications(is_read, is_dismissed);
  CREATE INDEX IF NOT EXISTS idx_notifications_created ON notifications(created_at DESC);
  CREATE INDEX IF NOT EXISTS idx_notifications_snoozed ON notifications(snoozed_until);
  CREATE INDEX IF NOT EXISTS idx_notifications_expires ON notifications(expires_at);
`);

// --- Scheduled Tasks ---

await initTable("schedules table", `
  CREATE TABLE IF NOT EXISTS schedules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    task TEXT NOT NULL,
    cron_expression TEXT NOT NULL,
    description TEXT,
    enabled INTEGER NOT NULL DEFAULT 1,
    last_run TEXT,
    next_run TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

// --- AI Chat Tables ---

await initTable("chat_conversations table", `
  CREATE TABLE IF NOT EXISTS chat_conversations (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    title TEXT,
    provider TEXT NOT NULL,
    model TEXT NOT NULL,
    profile_id TEXT DEFAULT NULL,
    system_prompt TEXT,
    total_tokens INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_chat_conversations_updated ON chat_conversations(updated_at DESC);
`);

// Migration: add profile_id to existing chat_conversations tables
try {
  const cols = await db.execute("PRAGMA table_info(chat_conversations)");
  if (!cols.rows.some(r => r.name === "profile_id")) {
    await db.execute("ALTER TABLE chat_conversations ADD COLUMN profile_id TEXT DEFAULT NULL");
    console.log("  ✓ Added profile_id column to chat_conversations");
  }
} catch { /* table may not exist yet on first run */ }

await initTable("chat_messages table", `
  CREATE TABLE IF NOT EXISTS chat_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    conversation_id INTEGER NOT NULL,
    role TEXT NOT NULL CHECK(role IN ('user', 'assistant', 'system', 'tool')),
    content TEXT,
    tool_calls TEXT,
    tool_call_id TEXT,
    tool_name TEXT,
    input_tokens INTEGER,
    output_tokens INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (conversation_id) REFERENCES chat_conversations(id) ON DELETE CASCADE
  );

  CREATE INDEX IF NOT EXISTS idx_chat_messages_conv ON chat_messages(conversation_id);
`);

// --- Metering core (paid metered inference) ---
// pricing_rules: operator-editable price book. Cost per 1M tokens keyed by
// provider_id and/or provider_type + model_id ('*' = any model). effective_to
// NULL = currently in force; superseded rules are kept for historical pricing.
await initTable("pricing_rules table", `
  CREATE TABLE IF NOT EXISTS pricing_rules (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    provider_id TEXT,
    provider_type TEXT,
    model_id TEXT NOT NULL DEFAULT '*',
    input_cost_per_1m REAL NOT NULL,
    output_cost_per_1m REAL NOT NULL,
    cache_read_cost_per_1m REAL,
    cache_write_cost_per_1m REAL,
    effective_from TEXT DEFAULT (datetime('now')),
    effective_to TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_pricing_rules_lookup ON pricing_rules(provider_id, provider_type, model_id);
`);

// usage_events: append-only metering ledger. One row per metered inference
// call, attributed to a tenant. priced=0 + computed_cost_usd NULL means no
// price rule matched (surfaced for backfill, never silently dropped). tenant_id
// is nullable for now (Phase 1.0 identity only); full tenant isolation is later.
await initTable("usage_events table", `
  CREATE TABLE IF NOT EXISTS usage_events (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    tenant_id TEXT,
    conversation_id INTEGER,
    message_id INTEGER,
    surface TEXT NOT NULL DEFAULT 'chat',
    provider_id TEXT,
    provider_type TEXT,
    model_id TEXT,
    input_tokens INTEGER NOT NULL DEFAULT 0,
    output_tokens INTEGER NOT NULL DEFAULT 0,
    cached_tokens INTEGER NOT NULL DEFAULT 0,
    computed_cost_usd REAL,
    priced INTEGER NOT NULL DEFAULT 0,
    request_id TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_usage_events_tenant ON usage_events(tenant_id, created_at);
  CREATE INDEX IF NOT EXISTS idx_usage_events_conv ON usage_events(conversation_id);
  CREATE INDEX IF NOT EXISTS idx_usage_events_unpriced ON usage_events(priced);
`);

// tenants: minimal registry (Phase 1.0 — identity only). usage_events.tenant_id
// is a SOFT link by convention (no FK: SQLite can't ALTER ADD CONSTRAINT and the
// meter path must not throw on an unknown tenant). Phase 3 hardens this during
// the real isolation re-architecture.
await initTable("tenants table", `
  CREATE TABLE IF NOT EXISTS tenants (
    id TEXT PRIMARY KEY,
    name TEXT,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

// Seed the default tenant; also register the env tenant if one is set and
// distinct (so resolveTenantId()'s id always has a registry home). Backfill is a
// SEPARATE try/catch so a seed failure never skips the backfill (and vice versa).
try {
  await ensureTenant(db, { id: DEFAULT_TENANT_ID, name: "Default (operator)" });
  const envTenant = process.env.CROW_TENANT_ID;
  if (envTenant && envTenant !== DEFAULT_TENANT_ID) {
    await ensureTenant(db, { id: envTenant, name: envTenant });
  }
} catch (e) {
  console.error("[init-db] tenant seed skipped:", e.message);
}
// Backfill legacy NULL usage_events rows to 'default' (they predate tagging and
// were the operator's). Always targets 'default', even on an env-tenant instance.
try {
  await db.execute({
    sql: `UPDATE usage_events SET tenant_id = ? WHERE tenant_id IS NULL`,
    args: [DEFAULT_TENANT_ID],
  });
} catch (e) {
  console.error("[init-db] tenant backfill skipped:", e.message);
}

// Migration: add attachments column to chat_messages if missing
try {
  await db.execute("SELECT attachments FROM chat_messages LIMIT 0");
} catch {
  try {
    await db.execute("ALTER TABLE chat_messages ADD COLUMN attachments TEXT");
    console.log("[init-db] Added attachments column to chat_messages");
  } catch (err) {
    console.error("[init-db] chat_messages migration failed:", err.message);
  }
}

// Podcast tables and Media tables are now bundle add-ons.
// They self-initialize via init-tables.js in their respective bundles.
// Existing tables from prior installs are preserved (IF NOT EXISTS).


// --- Songbook Tables ---

await initTable("songbook_setlists table", `
  CREATE TABLE IF NOT EXISTS songbook_setlists (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    visibility TEXT DEFAULT 'private',
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

await initTable("songbook_setlist_items table", `
  CREATE TABLE IF NOT EXISTS songbook_setlist_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    setlist_id INTEGER NOT NULL,
    post_id INTEGER NOT NULL,
    position INTEGER NOT NULL DEFAULT 0,
    key_override TEXT,
    notes TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (setlist_id) REFERENCES songbook_setlists(id) ON DELETE CASCADE,
    FOREIGN KEY (post_id) REFERENCES blog_posts(id) ON DELETE CASCADE
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_setlist_items_unique
    ON songbook_setlist_items(setlist_id, post_id);
`);

// --- Blog Comments (forward-compatibility stub — tools/UI in separate spec) ---

await initTable("blog_comments table", `
  CREATE TABLE IF NOT EXISTS blog_comments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    post_id INTEGER NOT NULL,
    contact_id INTEGER,
    author_name TEXT,
    content TEXT NOT NULL,
    status TEXT DEFAULT 'pending' CHECK(status IN ('pending', 'approved', 'hidden')),
    nostr_event_id TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (post_id) REFERENCES blog_posts(id) ON DELETE CASCADE,
    FOREIGN KEY (contact_id) REFERENCES contacts(id) ON DELETE SET NULL
  );

  CREATE INDEX IF NOT EXISTS idx_blog_comments_post ON blog_comments(post_id);
  CREATE INDEX IF NOT EXISTS idx_blog_comments_status ON blog_comments(status);
`);

// --- Media tables removed — now self-initialized by the Media Hub bundle ---

/* REMOVED: media_sources, media_articles, media_articles_fts + triggers,
   media_article_states, media_feedback, media_audio_cache, media_briefings,
   media_playlists, media_playlist_items, media_smart_folders,
   media_digest_preferences, media_interest_profiles */

// --- Instance Registry ---

await initTable("crow_instances table", `
  CREATE TABLE IF NOT EXISTS crow_instances (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    crow_id TEXT NOT NULL,
    directory TEXT,
    hostname TEXT,
    tailscale_ip TEXT,
    gateway_url TEXT,
    sync_url TEXT,
    sync_profile TEXT DEFAULT 'full' CHECK(sync_profile IN ('full', 'memory-only', 'blog-only', 'custom')),
    topics TEXT,
    is_home INTEGER DEFAULT 0,
    auth_token_hash TEXT,
    last_seen_at TEXT,
    status TEXT DEFAULT 'active' CHECK(status IN ('active', 'offline', 'paused', 'revoked')),
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_instances_crow_id ON crow_instances(crow_id);
  CREATE INDEX IF NOT EXISTS idx_instances_status ON crow_instances(status);
  CREATE INDEX IF NOT EXISTS idx_instances_is_home ON crow_instances(is_home);
`);

await initTable("sync_conflicts table", `
  CREATE TABLE IF NOT EXISTS sync_conflicts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    table_name TEXT NOT NULL,
    row_id TEXT NOT NULL,
    winning_instance_id TEXT NOT NULL,
    losing_instance_id TEXT NOT NULL,
    winning_lamport_ts INTEGER NOT NULL,
    losing_lamport_ts INTEGER NOT NULL,
    winning_data TEXT NOT NULL,
    losing_data TEXT NOT NULL,
    resolved INTEGER DEFAULT 0,
    resolved_at TEXT,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_sync_conflicts_table ON sync_conflicts(table_name);
  CREATE INDEX IF NOT EXISTS idx_sync_conflicts_resolved ON sync_conflicts(resolved);
`);

// W4-1: surface the operation that caused the conflict so the recovery UI
// can label delete-conflicts distinctly and disable restore for insert-collisions.
await addColumnIfMissing("sync_conflicts", "op", "TEXT DEFAULT 'update'");

await initTable("sync_state table", `
  CREATE TABLE IF NOT EXISTS sync_state (
    instance_id TEXT PRIMARY KEY,
    local_counter INTEGER DEFAULT 0,
    last_applied_seq_per_peer TEXT DEFAULT '{}',
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

// --- Cross-host control plane (Phase 5-MVP) ---

// Add trusted column to crow_instances — gate for accepting cross-host actions.
// Default 0 so newly-registered instances cannot receive cross-host RPC until
// an operator promotes them (e.g. via `crow instance pair`).
await addColumnIfMissing("crow_instances", "trusted", "INTEGER DEFAULT 0");

// data_dir stores a peer's CROW_DATA_DIR so same-host instances (e.g. primary +
// MPA) can locate each other's DB files. registerInstance() writes this column,
// but it was never added to the schema — so new-instance registration (the
// instance-pair enroll INSERT path) failed fleet-wide with "no column named
// data_dir". Added here as an idempotent migration.
await addColumnIfMissing("crow_instances", "data_dir", "TEXT");

await initTable("cross_host_calls audit table", `
  CREATE TABLE IF NOT EXISTS cross_host_calls (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    source_instance_id TEXT,
    target_instance_id TEXT,
    direction TEXT NOT NULL CHECK(direction IN ('outbound', 'inbound')),
    action TEXT NOT NULL,
    bundle_id TEXT,
    actor TEXT,
    http_status INTEGER,
    hmac_valid INTEGER,
    timestamp_skew_ms INTEGER,
    nonce TEXT,
    error TEXT,
    request_id TEXT,
    at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_xhost_target ON cross_host_calls(target_instance_id, at DESC);
  CREATE INDEX IF NOT EXISTS idx_xhost_source ON cross_host_calls(source_instance_id, at DESC);
  CREATE INDEX IF NOT EXISTS idx_xhost_action ON cross_host_calls(action, at DESC);
`);

// --- Lamport timestamp columns for synced tables ---

await addColumnIfMissing("memories", "lamport_ts", "INTEGER DEFAULT 0");
await addColumnIfMissing("crow_context", "lamport_ts", "INTEGER DEFAULT 0");
await addColumnIfMissing("contacts", "lamport_ts", "INTEGER DEFAULT 0");
await addColumnIfMissing("shared_items", "lamport_ts", "INTEGER DEFAULT 0");
await addColumnIfMissing("messages", "lamport_ts", "INTEGER DEFAULT 0");
await addColumnIfMissing("relay_config", "lamport_ts", "INTEGER DEFAULT 0");
await addColumnIfMissing("crow_instances", "lamport_ts", "INTEGER DEFAULT 0");

// --- Scoped Settings: lamport_ts on dashboard_settings + dashboard_settings_overrides ---
// Rather than recreate dashboard_settings with a composite PK (which breaks
// every existing `ON CONFLICT(key)` upsert in first- and third-party bundle code),
// we keep dashboard_settings as PK(key) and store per-instance overrides in a
// sibling table. readSetting/writeSetting in registry.js merge the two.

await addColumnIfMissing("dashboard_settings", "lamport_ts", "INTEGER DEFAULT 0");

await initTable("dashboard_settings_overrides table", `
  CREATE TABLE IF NOT EXISTS dashboard_settings_overrides (
    key TEXT NOT NULL,
    instance_id TEXT NOT NULL,
    value TEXT NOT NULL,
    updated_at TEXT DEFAULT (datetime('now')),
    lamport_ts INTEGER DEFAULT 0,
    PRIMARY KEY (key, instance_id)
  );
  CREATE INDEX IF NOT EXISTS idx_dashboard_overrides_key ON dashboard_settings_overrides(key);
`);

// --- Fix-it Cards (2026-06-15): per-instance operational "noticed → one-click
// fix" items. LOCAL-ONLY, never synced (deliberately absent from
// sync-allowlist). UNIQUE(source,dedup_key) collapses retries into one card. ---
await initTable("fix_it_items table", `
  CREATE TABLE IF NOT EXISTS fix_it_items (
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    source           TEXT NOT NULL,
    dedup_key        TEXT NOT NULL,
    title            TEXT NOT NULL,
    why              TEXT,
    severity         TEXT NOT NULL DEFAULT 'warn'
                       CHECK (severity IN ('info','warn','urgent')),
    remedies         TEXT NOT NULL DEFAULT '[]',
    context          TEXT,
    status           TEXT NOT NULL DEFAULT 'pending'
                       CHECK (status IN ('pending','dismissed','resolved')),
    count            INTEGER NOT NULL DEFAULT 1,
    suppressed_until TEXT,
    created_at       TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE UNIQUE INDEX IF NOT EXISTS idx_fix_it_items_dedup ON fix_it_items(source, dedup_key);
  CREATE INDEX IF NOT EXISTS idx_fix_it_items_status ON fix_it_items(status);
`);
// --- Crow Messages gateway (2026-06-15): per-bot inbound authorization + invite
// tokens. LOCAL-ONLY (operational state, never synced). ACL is keyed on the
// x-only secp256k1 pubkey (verifiable from a signed inbound DM). ---
await initTable("bot_message_acl table", `
  CREATE TABLE IF NOT EXISTS bot_message_acl (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_id        TEXT NOT NULL,
    sender_pubkey TEXT NOT NULL,
    crow_id       TEXT,
    display_name  TEXT,
    added_via     TEXT NOT NULL DEFAULT 'invite'
                    CHECK (added_via IN ('invite','manual')),
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    UNIQUE(bot_id, sender_pubkey)
  );
  CREATE INDEX IF NOT EXISTS idx_bot_message_acl_bot ON bot_message_acl(bot_id);
`);
await initTable("bot_message_invites table", `
  CREATE TABLE IF NOT EXISTS bot_message_invites (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_id      TEXT NOT NULL,
    token       TEXT NOT NULL UNIQUE,
    expires_at  TEXT,
    max_uses    INTEGER,
    uses        INTEGER NOT NULL DEFAULT 0,
    revoked     INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_bot_message_invites_bot ON bot_message_invites(bot_id);
`);
// Persistent processed-event dedup for the crow-messages adapter: survives a
// host restart so a relay's 24h replay does NOT re-run pi turns for chat DMs the
// bot already answered. Pruned by age. LOCAL-ONLY.
await initTable("bot_message_seen table", `
  CREATE TABLE IF NOT EXISTS bot_message_seen (
    bot_id     TEXT NOT NULL,
    event_id   TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (bot_id, event_id)
  );
  CREATE INDEX IF NOT EXISTS idx_bot_message_seen_age ON bot_message_seen(created_at);
`);

// If a previous botched migration recreated dashboard_settings without PK(key),
// restore it. Detect by checking pragma + absence of the overrides table data
// (already populated means we already did it).
try {
  const { rows: cols } = await db.execute("PRAGMA table_info(dashboard_settings)");
  const keyCol = cols.find(c => c.name === "key");
  if (keyCol && keyCol.pk === 0) {
    // Previous broken shape — drop extra columns and restore PK(key)
    await db.executeMultiple(`
      CREATE TABLE IF NOT EXISTS dashboard_settings_restore (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at TEXT DEFAULT (datetime('now')),
        lamport_ts INTEGER DEFAULT 0
      );
      INSERT OR IGNORE INTO dashboard_settings_restore (key, value, updated_at, lamport_ts)
        SELECT key, value, updated_at, COALESCE(lamport_ts, 0) FROM dashboard_settings
        WHERE instance_id IS NULL;
      -- Move per-instance rows into the overrides table
      INSERT OR IGNORE INTO dashboard_settings_overrides (key, instance_id, value, updated_at, lamport_ts)
        SELECT key, instance_id, value, updated_at, COALESCE(lamport_ts, 0) FROM dashboard_settings
        WHERE instance_id IS NOT NULL;
      DROP INDEX IF EXISTS idx_dashboard_settings_global;
      DROP INDEX IF EXISTS idx_dashboard_settings_instance;
      DROP TABLE dashboard_settings;
      ALTER TABLE dashboard_settings_restore RENAME TO dashboard_settings;
    `);
    console.log("  Restored dashboard_settings PK(key); moved per-instance rows to dashboard_settings_overrides");
  }
} catch (err) {
  console.warn("  dashboard_settings restore note:", err.message);
}

// --- Contacts panel: new columns for profiles, manual contacts ---
await addColumnIfMissing("contacts", "avatar_url", "TEXT");
await addColumnIfMissing("contacts", "bio", "TEXT");
await addColumnIfMissing("contacts", "notes", "TEXT");
await addColumnIfMissing("contacts", "contact_type", "TEXT DEFAULT 'crow'");
await addColumnIfMissing("contacts", "email", "TEXT");
await addColumnIfMissing("contacts", "phone", "TEXT");
// NULL = normal contact; 'pending' = unaccepted message request; 'accepted' = accepted partial contact (L6).
await addColumnIfMissing("contacts", "request_status", "TEXT");

// --- Contact Groups ---
await initTable("contact_groups table", `
  CREATE TABLE IF NOT EXISTS contact_groups (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    color TEXT DEFAULT '#6366f1',
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now'))
  );
`);

await initTable("contact_group_members table", `
  CREATE TABLE IF NOT EXISTS contact_group_members (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id INTEGER NOT NULL REFERENCES contact_groups(id) ON DELETE CASCADE,
    contact_id INTEGER NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE UNIQUE INDEX IF NOT EXISTS idx_group_members_unique ON contact_group_members(group_id, contact_id);
`);

// --- Crow Messages rooms (phase 3a): a contact_group becomes a multi-party room
// when it carries a room_uid. Plain organizational groups (room_uid NULL) are
// unaffected. mode is validated in code ('addressed'|'always') — a CHECK can't be
// added to an existing table via ALTER, so it lives in rooms-store, not the column.
await addColumnIfMissing("contact_groups", "room_uid", "TEXT");
await addColumnIfMissing("contact_groups", "host_crow_id", "TEXT");
await addColumnIfMissing("contact_groups", "mode", "TEXT DEFAULT 'addressed'");
await db.execute(
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_contact_groups_room_uid ON contact_groups(room_uid) WHERE room_uid IS NOT NULL"
);

await initTable("room_messages table", `
  CREATE TABLE IF NOT EXISTS room_messages (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    group_id          INTEGER NOT NULL REFERENCES contact_groups(id) ON DELETE CASCADE,
    msg_uid           TEXT NOT NULL,
    sender_contact_id INTEGER REFERENCES contacts(id) ON DELETE SET NULL,
    sender_label      TEXT,
    author_kind       TEXT NOT NULL DEFAULT 'human' CHECK (author_kind IN ('human','bot')),
    content           TEXT NOT NULL,
    direction         TEXT NOT NULL CHECK (direction IN ('sent','received')),
    nostr_event_id    TEXT,
    is_read           INTEGER DEFAULT 0,
    created_at        TEXT DEFAULT (datetime('now'))
  );
  CREATE INDEX IF NOT EXISTS idx_room_messages_group ON room_messages(group_id, created_at);
  CREATE UNIQUE INDEX IF NOT EXISTS idx_room_messages_msg_uid ON room_messages(group_id, msg_uid);
`);

// --- Push Subscriptions (Web Push / PWA) ---

await initTable("push_subscriptions table", `
  CREATE TABLE IF NOT EXISTS push_subscriptions (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    endpoint TEXT NOT NULL UNIQUE,
    keys_json TEXT NOT NULL,
    platform TEXT NOT NULL DEFAULT 'web',
    device_name TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    last_seen TEXT DEFAULT (datetime('now'))
  );
`);

// --- Bundle Settings (PR 0: per-bundle config / safety toggles, DB-read at tool-call time) ---

await initTable("bundle_settings table", `
  CREATE TABLE IF NOT EXISTS bundle_settings (
    bundle_id TEXT NOT NULL,
    key TEXT NOT NULL,
    value TEXT,
    updated_at TEXT DEFAULT (datetime('now')),
    PRIMARY KEY (bundle_id, key)
  );

  CREATE INDEX IF NOT EXISTS idx_bundle_settings_bundle ON bundle_settings(bundle_id);
`);

// --- Install Consents (PR 0: server-validated consent tokens for privileged/consent_required bundles) ---

await initTable("install_consents table", `
  CREATE TABLE IF NOT EXISTS install_consents (
    token TEXT PRIMARY KEY,
    bundle_id TEXT NOT NULL,
    schema_version INTEGER NOT NULL DEFAULT 1,
    created_at INTEGER NOT NULL,
    expires_at INTEGER NOT NULL,
    consumed INTEGER NOT NULL DEFAULT 0
  );

  CREATE INDEX IF NOT EXISTS idx_install_consents_bundle ON install_consents(bundle_id);
  CREATE INDEX IF NOT EXISTS idx_install_consents_expires ON install_consents(expires_at);
`);

// --- CrowdSec Decisions Cache (PR 0: cross-process LAPI decision cache for gateway middleware) ---

await initTable("crowdsec_decisions_cache table", `
  CREATE TABLE IF NOT EXISTS crowdsec_decisions_cache (
    ip TEXT PRIMARY KEY,
    decision TEXT NOT NULL,
    expires_at INTEGER NOT NULL,
    cached_at INTEGER NOT NULL
  );

  CREATE INDEX IF NOT EXISTS idx_crowdsec_cache_expires ON crowdsec_decisions_cache(expires_at);
`);

// --- Rate limit buckets (F.0: SQLite-backed token buckets for federated-bundle MCP tools) ---

await initTable("rate_limit_buckets table", `
  CREATE TABLE IF NOT EXISTS rate_limit_buckets (
    tool_id TEXT NOT NULL,
    bucket_key TEXT NOT NULL,
    tokens REAL NOT NULL,
    refilled_at INTEGER NOT NULL,
    PRIMARY KEY (tool_id, bucket_key)
  );

  CREATE INDEX IF NOT EXISTS idx_rate_limit_buckets_refilled ON rate_limit_buckets(refilled_at);
`);

console.log("  ℹ semantic search uses BLOB embeddings (memory_embeddings_blob)");

// --- Phase 4 semantic memory tables (always created; BLOB fallback works without sqlite-vec) ---
// Per-content-type embedding tables. `vec` is a Float32Array serialized as BLOB.
// `model` + `dim` track the model that generated the vector so we can detect drift
// on model swap and re-embed via backfill.

await initTable("memory_embeddings_blob table (Phase 4)", `
  CREATE TABLE IF NOT EXISTS memory_embeddings_blob (
    memory_id INTEGER PRIMARY KEY REFERENCES memories(id) ON DELETE CASCADE,
    model TEXT NOT NULL,
    dim INTEGER NOT NULL,
    vec BLOB NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_memory_emb_model ON memory_embeddings_blob(model);
`);

await initTable("source_embeddings table (Phase 4)", `
  CREATE TABLE IF NOT EXISTS source_embeddings (
    source_id INTEGER PRIMARY KEY REFERENCES research_sources(id) ON DELETE CASCADE,
    model TEXT NOT NULL,
    dim INTEGER NOT NULL,
    vec BLOB NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_source_emb_model ON source_embeddings(model);
`);

await initTable("note_embeddings table (Phase 4)", `
  CREATE TABLE IF NOT EXISTS note_embeddings (
    note_id INTEGER PRIMARY KEY REFERENCES research_notes(id) ON DELETE CASCADE,
    model TEXT NOT NULL,
    dim INTEGER NOT NULL,
    vec BLOB NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_note_emb_model ON note_embeddings(model);
`);

await initTable("blog_post_embeddings table (Phase 4)", `
  CREATE TABLE IF NOT EXISTS blog_post_embeddings (
    post_id INTEGER PRIMARY KEY REFERENCES blog_posts(id) ON DELETE CASCADE,
    model TEXT NOT NULL,
    dim INTEGER NOT NULL,
    vec BLOB NOT NULL,
    created_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_blog_emb_model ON blog_post_embeddings(model);
`);

// --- Phase 5-full providers registry (operator-editable, instance-synced) ---
await initTable("providers table (Phase 5-full)", `
  CREATE TABLE IF NOT EXISTS providers (
    id TEXT PRIMARY KEY,
    base_url TEXT NOT NULL,
    api_key TEXT,
    host TEXT DEFAULT 'local',
    bundle_id TEXT,
    description TEXT,
    models TEXT NOT NULL DEFAULT '[]',
    disabled INTEGER DEFAULT 0,
    lamport_ts INTEGER DEFAULT 0,
    instance_id TEXT,
    provider_type TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_providers_host ON providers(host);
  CREATE INDEX IF NOT EXISTS idx_providers_bundle ON providers(bundle_id);
  CREATE INDEX IF NOT EXISTS idx_providers_enabled ON providers(disabled);
`);

// NOTE: the multi-agent orchestrator was retired (Plan B Part 2, 2026-06-14).
// Its two tables — orchestrator_events (run/lifecycle observability timeline)
// and orchestrator_role_overrides (preset per-agent provider overrides) — are
// no longer created here; existing hosts drop them via the guarded migration
// near the end of this file. GPU model lifecycle (refcounts) is in-memory in
// servers/shared/lifecycle.js and never needed a table.

// Seed 7 protected default sections (safe to re-run)
const seedSections = [
  {
    key: "identity",
    title: "Identity & Purpose",
    order: 0,
    content: `You are **Crow** — an AI-powered persistent memory and research assistant that works across every major AI platform.

Your core purpose:
- Maintain persistent memory across sessions and platforms
- Manage structured research projects with proper citations
- Connect to 15+ integrations (Gmail, Calendar, GitHub, Slack, Discord, Notion, Trello, Canvas, arXiv, Zotero, and more)
- Provide a seamless experience whether the user is on Claude, ChatGPT, Gemini, Grok, Cursor, or any MCP-compatible client

You are platform-agnostic. The user's data, memories, and research belong to *them*, not to any single AI platform.`,
  },
  {
    key: "memory_protocol",
    title: "Memory Protocol",
    order: 10,
    content: `**When to store memories:**
- User preferences, habits, and communication style
- Project context, decisions, and rationale
- Important facts about people, organizations, and relationships
- Goals, deadlines, and recurring tasks
- Anything the user explicitly asks you to remember

**How to store:**
- Use \`crow_store_memory\` with appropriate category (general, project, preference, person, process, decision, learning, goal)
- Set importance 1-10 based on long-term value (8+ for core preferences, 5 for general context)
- Add comma-separated tags for cross-referencing
- Include context about when/why the memory was stored

**When to recall:**
- Start of every session: \`crow_recall_by_context\` with the user's first message
- When the user asks about something previously discussed
- Before making suggestions — check if preferences are stored
- When context from a previous session would be helpful`,
  },
  {
    key: "research_protocol",
    title: "Research Protocol",
    order: 20,
    content: `**Managing research projects:**
- Create projects with \`crow_create_project\` for any multi-source research task
- Add sources with \`crow_add_source\` — always include APA citations
- Take structured notes with \`crow_add_note\` (types: note, quote, summary, analysis, question, insight)
- Generate bibliographies with \`crow_generate_bibliography\`

**Citation rules:**
- Every external source gets a citation — no exceptions
- Supported formats: APA (default), MLA, Chicago, web citation
- Use \`citation_format\` parameter on \`crow_add_source\` to select primary format
- \`crow_get_source\` shows all citation formats; \`crow_generate_bibliography\` accepts a \`format\` parameter
- Use retrieval dates for web sources
- Verify sources before marking as verified
- Cross-reference with Zotero when available

**Source verification:**
- Always record \`retrieval_method\` — note whether a source was found via AI search, direct URL, library database, or user-provided
- Prefer primary sources over AI-generated summaries
- All factual claims in research output must link to a stored, cited source
- When AI search surfaces a source, verify the URL is real before storing

**Source types:** web_article, academic_paper, book, interview, web_search, web_scrape, api_data, document, video, podcast, social_media, government_doc, dataset, other`,
  },
  {
    key: "session_protocol",
    title: "Session Protocol",
    order: 30,
    content: `**On session start:**
1. Recall relevant context with \`crow_recall_by_context\` using the user's first message
2. Check \`crow_check_notifications\` for pending reminders and alerts — mention any unread notifications to the user
3. Check \`crow_memory_stats\` for an overview of stored knowledge
4. Load language preference from memory
5. Consult the skills reference for routing

**During the session:**
- Store important information as it emerges
- Document external sources properly
- Monitor for friction signals (errors, corrections, repeated attempts)
- Adapt to the user's language and communication style

**On session end:**
- Store any unfinished work or pending items
- If friction occurred, note it for future improvement`,
  },
  {
    key: "transparency_rules",
    title: "Transparency Rules",
    order: 40,
    content: `Surface all autonomous actions so the user knows what Crow is doing behind the scenes.

**Tier 1 — FYI (routine actions, no response needed):**
Show a brief inline note when storing memories, recalling context, or performing background tasks.
Example: [crow: stored memory — "prefers dark mode" (preference, importance 8)]

**Tier 2 — Checkpoint (significant decisions, wait for user):**
Show a clear notice before taking actions that change state or involve multiple steps.
Example: [crow checkpoint: About to create research project "Climate Policy Analysis" with 3 sources. Proceed?]

**Platform-specific formatting:**
- Claude: Use *italic* for Tier 1, **bold** for Tier 2
- ChatGPT/Generic: Use [brackets] for both tiers
- Cursor/IDE: Minimal — only Tier 2 checkpoints`,
  },
  {
    key: "skills_reference",
    title: "Skills & Capabilities Reference",
    order: 50,
    content: `**Core capabilities and when to activate them:**

| User Intent | Skill | Tools |
|---|---|---|
| "remember", "recall", "what did we..." | memory-management | crow-memory |
| "research", "find papers", "cite" | research-pipeline | crow-projects, brave-search |
| "organize notes", "plan from notes" | ideation | crow-memory, crow-projects |
| "blog post", "publish", "write post" | blog | crow-blog, crow-storage |
| "share with", "send to", "invite" | sharing | crow-sharing |
| "message", "chat", "DM" | social | crow-sharing |
| "delete", "publish", "destructive action" | safety-guardrails | (checkpoint before action) |
| "upload file", "storage", "download" | storage | crow-storage |
| "schedule", "remind me", "recurring" | scheduling | crow-memory |
| "data backend", "connect database" | data-backends | crow-projects |
| "install", "add-on", "extension" | add-ons | (registry) |
| "teach me", "explain", "tutor" | tutoring | crow-memory |

**Compound workflows:** Daily briefing, meeting prep, research kickoff, team updates, project organization — combine multiple skills in sequence.

**Skill activation:** Say what you want naturally. The AI matches your intent to the right skill and activates it automatically. Use the \`session-start\` prompt for full workflow guidance.`,
  },
  {
    key: "writing_style",
    title: "Writing Style",
    order: 55,
    content: `## Writing Rules

### Banned Patterns
(Add patterns you want Crow to never use in any writing)

### Preferred Style
(Add your style preferences: tone, register, formatting)

### Context-Specific Rules
(Add rules for specific contexts: emails, reports, blog posts, etc.)`,
  },
  {
    key: "key_principles",
    title: "Key Principles",
    order: 60,
    content: `1. **Memory-first**: When in doubt, store it. Better to have it and not need it than to lose context.
2. **Always cite**: Every external source gets an APA citation — no exceptions.
3. **Verify before trusting**: Don't mark sources as verified until actually checked.
4. **Consistent tagging**: Use the same tags across memory and research for cross-referencing.
5. **Language adaptation**: Detect and adapt to the user's preferred language. All output in their language; internal files stay in English.
6. **Platform-agnostic**: Never assume which platform the user is on. Keep instructions and data portable.
7. **Transparency**: Surface what you're doing. Users should never be surprised by autonomous actions.`,
  },
];

for (const section of seedSections) {
  await db.execute({
    sql: `INSERT OR IGNORE INTO crow_context (section_key, section_title, content, sort_order) VALUES (?, ?, ?, ?)`,
    args: [section.key, section.title, section.content, section.order],
  });
}

// --- One-time theme migration (old keys → new unified keys) ---
try {
  const oldTheme = await db.execute({
    sql: "SELECT value FROM dashboard_settings WHERE key = 'blog_theme'",
    args: [],
  });
  const oldDashTheme = await db.execute({
    sql: "SELECT value FROM dashboard_settings WHERE key = 'dashboard_theme'",
    args: [],
  });

  // Only migrate if new keys don't exist yet
  const newKeys = await db.execute({
    sql: "SELECT key FROM dashboard_settings WHERE key = 'blog_theme_mode'",
    args: [],
  });

  if (newKeys.rows.length === 0) {
    // Migrate blog_theme
    if (oldTheme.rows.length > 0) {
      const val = oldTheme.rows[0].value;
      if (val === "light") {
        await db.execute({
          sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('blog_theme_mode', 'light', datetime('now')) ON CONFLICT(key) DO UPDATE SET value = 'light', updated_at = datetime('now')",
          args: [],
        });
      }
      if (val === "serif") {
        await db.execute({
          sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('blog_theme_serif', 'true', datetime('now')) ON CONFLICT(key) DO UPDATE SET value = 'true', updated_at = datetime('now')",
          args: [],
        });
      }
    }

    // Migrate dashboard_theme
    if (oldDashTheme.rows.length > 0 && oldDashTheme.rows[0].value === "light") {
      await db.execute({
        sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('blog_theme_dashboard_mode', 'light', datetime('now')) ON CONFLICT(key) DO UPDATE SET value = 'light', updated_at = datetime('now')",
        args: [],
      });
    }
    console.log("Theme migration complete (old keys preserved for backward compat).");
  }
} catch (err) {
  // Non-fatal — table may not exist on first init
  console.warn("Theme migration skipped:", err.message);
}


// --- Bot framework tables (Phase 7.2 + 7.4 + 7.5 + 7.6) ---
// 2026-05-12: state surface for the bot framework that lives inside the
// MPA orchestrator. bot_conversations holds per-conversation state-machine
// rows; bot_registry is the single source of truth for what bots exist;
// bot_preferences is per-user-per-bot config; bot_runs is the audit trail.
// All four tables are MPA-scoped — primary instances on grackle/crow will
// also create them (IF NOT EXISTS), but only MPA's gateway will populate them.

await initTable("bot_conversations table", `
  CREATE TABLE IF NOT EXISTS bot_conversations (
    id              TEXT PRIMARY KEY,
    bot_id          TEXT NOT NULL,
    user_email      TEXT NOT NULL,
    subject_anchor  TEXT NOT NULL,
    gmail_thread_id TEXT,
    gmail_label     TEXT,
    google_doc_id   TEXT,
    status          TEXT NOT NULL,
    current_step    TEXT NOT NULL,
    payload         TEXT NOT NULL,
    last_user_msg_at TEXT,
    next_action_at  TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_bot_conv_next_action
    ON bot_conversations(bot_id, next_action_at)
    WHERE status IN ('pending','awaiting-user','drafting');

  CREATE INDEX IF NOT EXISTS idx_bot_conv_thread
    ON bot_conversations(gmail_thread_id);
`);

await initTable("bot_registry table", `
  CREATE TABLE IF NOT EXISTS bot_registry (
    bot_id          TEXT PRIMARY KEY,
    display_name    TEXT NOT NULL,
    description     TEXT,
    email_alias     TEXT NOT NULL,
    gmail_label     TEXT NOT NULL,
    tick_cron       TEXT NOT NULL,
    preset_name     TEXT NOT NULL,
    enabled         INTEGER NOT NULL DEFAULT 1,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );
`);

await initTable("bot_preferences table", `
  CREATE TABLE IF NOT EXISTS bot_preferences (
    bot_id      TEXT NOT NULL,
    user_email  TEXT NOT NULL,
    key         TEXT NOT NULL,
    value       TEXT NOT NULL,
    updated_at  TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (bot_id, user_email, key)
  );
`);

await initTable("bot_runs table", `
  CREATE TABLE IF NOT EXISTS bot_runs (
    run_id          TEXT PRIMARY KEY,
    bot_id          TEXT NOT NULL,
    conversation_id TEXT,
    started_at      TEXT NOT NULL DEFAULT (datetime('now')),
    ended_at        TEXT,
    status          TEXT NOT NULL,
    error           TEXT,
    tokens_used     INTEGER,
    created_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_bot_runs_bot
    ON bot_runs(bot_id, started_at DESC);

  CREATE INDEX IF NOT EXISTS idx_bot_runs_conv
    ON bot_runs(conversation_id);
`);

// bot_jobs — async background work for a pi bot (Plan B Part 1). The gateway
// (or the bot cron scheduler) INSERTs a 'queued' row; the pi-bots host polls,
// atomically claims one ('queued'->'running' with worker_pid), runs the bot pi
// detached on the goal, captures the result, and delivers it (deliver_to JSON:
// channel reply / Crow memory / poll). This table IS the cross-process IPC
// channel — the gateway and scripts/pi-bots/ open the SAME crow.db. journal_mode
// is RAM-dependent (WAL on >2 GiB hosts, DELETE on ≤2 GiB); a single
// UPDATE...RETURNING claim is atomic in BOTH modes (writers serialize). Pollers
// stay coarse (>=60s) to bound lock contention. DDL lives in
// pi-bots/bot-jobs-schema.mjs (also lazy-ensured by the runner + gateway).
await initTable("bot_jobs table", BOT_JOBS_DDL);



// --- Phase 8 job-search bot tables (2026-05-12) ---
// job_candidates: dedup'd normalized job postings from all three ingestion
//   pathways (ed-jobs-scraper, gmail, direct site scrapes). The id is
//   sha256(normalize(employer) + '|' + normalize(title) + '|' + normalize(url)).
// job_search_sites: registry of direct-scrape source pages (Tier 1/2/3),
//   their scrape strategy, and last-run health. Auto-disables after 3
//   consecutive errors (handled by the ingest-sites pipeline).

await initTable("job_candidates table", `
  CREATE TABLE IF NOT EXISTS job_candidates (
    id              TEXT PRIMARY KEY,
    source          TEXT NOT NULL,
    source_ref      TEXT,
    employer        TEXT NOT NULL,
    title           TEXT NOT NULL,
    url             TEXT NOT NULL,
    location        TEXT,
    remote          INTEGER,
    salary_min      INTEGER,
    salary_max      INTEGER,
    posted_at       TEXT,
    description     TEXT,
    raw_payload     TEXT,
    status          TEXT NOT NULL DEFAULT 'new',
    match_score     REAL,
    match_notes     TEXT,
    user_priority   INTEGER,
    shown_in_digest_id TEXT,
    application_id  TEXT,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_job_cand_status_score
    ON job_candidates(status, match_score DESC);

  CREATE INDEX IF NOT EXISTS idx_job_cand_employer
    ON job_candidates(employer);

  CREATE INDEX IF NOT EXISTS idx_job_cand_source
    ON job_candidates(source, created_at DESC);
`);

await initTable("job_search_sites table", `
  CREATE TABLE IF NOT EXISTS job_search_sites (
    id              TEXT PRIMARY KEY,
    name            TEXT NOT NULL,
    source_type     TEXT NOT NULL,
    url             TEXT NOT NULL,
    scrape_strategy TEXT NOT NULL,
    tier            INTEGER NOT NULL,
    enabled         INTEGER NOT NULL DEFAULT 1,
    last_run_at     TEXT,
    last_status     TEXT,
    consecutive_errors INTEGER NOT NULL DEFAULT 0,
    created_at      TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at      TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_job_sites_tier_enabled
    ON job_search_sites(tier, enabled);
`);

// --- Bot Builder tables (F3: moved from scripts/init-pi-bots.mjs) ---
// Full current shape: pi_bot_defs.project_id and bot_sessions.model/escalated
// are in the CREATE body here (init-pi-bots.mjs adds them via guarded ALTER on
// pre-F3 DBs). CREATE ... IF NOT EXISTS — a no-op on the live MPA crow.db.
// init-pi-bots.mjs remains the MPA-only JSON->column project_id backfill + guard.
await initTable("pi_bot_defs table", `
  CREATE TABLE IF NOT EXISTS pi_bot_defs (
    bot_id        TEXT PRIMARY KEY,
    display_name  TEXT NOT NULL,
    definition    TEXT,
    enabled       INTEGER NOT NULL DEFAULT 1,
    project_id    INTEGER,
    created_at    TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_pi_bot_defs_enabled ON pi_bot_defs (enabled);
  CREATE INDEX IF NOT EXISTS idx_pi_bot_defs_project ON pi_bot_defs (project_id);
`);

await initTable("bot_sessions table", `
  CREATE TABLE IF NOT EXISTS bot_sessions (
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_id            TEXT NOT NULL,
    pi_session_id     TEXT,
    pi_session_dir    TEXT,
    gateway_type      TEXT,
    gateway_thread_id TEXT,
    project_id        INTEGER,
    card_id           INTEGER,
    plan_path         TEXT,
    status            TEXT NOT NULL DEFAULT 'active'
                        CHECK (status IN ('active','waiting-user','stopped','done','error')),
    control           TEXT NOT NULL DEFAULT 'run'
                        CHECK (control IN ('run','stop')),
    model             TEXT,
    escalated         INTEGER DEFAULT 0,
    created_at        TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_bot_sessions_bot_thread
    ON bot_sessions (bot_id, gateway_thread_id);
  CREATE INDEX IF NOT EXISTS idx_bot_sessions_status
    ON bot_sessions (status);
`);

await initTable("bot_skill_events table", `
  CREATE TABLE IF NOT EXISTS bot_skill_events (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    bot_id      TEXT NOT NULL,
    skill_name  TEXT NOT NULL,
    action      TEXT NOT NULL
                  CHECK (action IN ('propose','create','patch','reject','downgrade')),
    mode        TEXT,
    model       TEXT,
    flags_json  TEXT,
    created_at  TEXT NOT NULL DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_bot_skill_events_bot_skill
    ON bot_skill_events (bot_id, skill_name);
  CREATE INDEX IF NOT EXISTS idx_bot_skill_events_bot_time
    ON bot_skill_events (bot_id, created_at);
`);

// --- Nav groups migration (W3-6 2026-06-11: spine-aligned groups) ---
// Replaces the old Core/Content/Media/Education/Tools/System defaults with the
// new Home/Agents/Connections/Workspace/System spine. Only fires if the stored
// nav_groups (id,name) pairs exactly match the old defaults — i.e. the user
// never customized them. Customized configs are left untouched.
try {
  const { OLD_NAV_DEFAULTS_2026_06 } = await import(
    "../servers/gateway/dashboard/nav-registry.js"
  );

  const storedGroupsRow = await db.execute({
    sql: "SELECT value FROM dashboard_settings WHERE key = 'nav_groups'",
    args: [],
  });
  const migrationFlagRow = await db.execute({
    sql: "SELECT value FROM dashboard_settings WHERE key = 'nav_migration_w3_6_v1'",
    args: [],
  });

  if (migrationFlagRow.rows.length === 0 && storedGroupsRow.rows.length > 0) {
    const stored = JSON.parse(storedGroupsRow.rows[0].value);
    // Deep-match on (id, name) pairs — ignoring collapsed and order.
    const oldSet = new Map(OLD_NAV_DEFAULTS_2026_06.groups.map((g) => [g.id, g.name]));
    const storedSet = new Map(stored.map((g) => [g.id, g.name]));
    const isDefaultConfig =
      oldSet.size === storedSet.size &&
      [...oldSet.entries()].every(([id, name]) => storedSet.get(id) === name);

    if (isDefaultConfig) {
      // Unmodified config — replace both keys with new spine-aligned defaults.
      const newGroups = [
        { id: "home", name: "Home", collapsed: false },
        { id: "agents", name: "Agents", collapsed: false },
        { id: "connections", name: "Connections", collapsed: false },
        { id: "workspace", name: "Workspace", collapsed: false },
        { id: "system", name: "System", collapsed: true },
      ];
      const newAssignments = {
        nest: "home",
        "bot-builder": "agents",
        "bot-board": "agents",
        skills: "agents",
        orchestrator: "agents",
        connect: "connections",
        contacts: "connections",
        messages: "connections",
        fediverse: "connections",
        memory: "workspace",
        projects: "workspace",
        blog: "workspace",
        files: "workspace",
        extensions: "workspace",
        settings: "system",
        "design-system": "system",
      };
      await db.execute({
        sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('nav_groups', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        args: [JSON.stringify(newGroups)],
      });
      await db.execute({
        sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('nav_panel_assignments', ?, datetime('now')) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        args: [JSON.stringify(newAssignments)],
      });
      console.log("Nav migration W3-6: replaced default groups with spine-aligned defaults.");
    } else {
      console.log("Nav migration W3-6: customized nav config detected — leaving groups untouched.");
    }

    // Mark the migration as run regardless of outcome.
    await db.execute({
      sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('nav_migration_w3_6_v1', '1', datetime('now')) ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = excluded.updated_at",
      args: [],
    });
  } else if (migrationFlagRow.rows.length > 0) {
    // Migration already ran — nothing to do.
  } else {
    // No stored nav_groups yet — fresh install, new defaults seeded by resolveNavGroups.
    await db.execute({
      sql: "INSERT INTO dashboard_settings (key, value, updated_at) VALUES ('nav_migration_w3_6_v1', '1', datetime('now')) ON CONFLICT(key) DO UPDATE SET value = '1', updated_at = excluded.updated_at",
      args: [],
    });
  }
} catch (err) {
  console.warn("Nav migration W3-6 skipped:", err.message);
}

// --- Late schema migrations (2026-06-12) ---
// These ALTERs target tables whose CREATE statements appear ABOVE but after
// the early-migration block near the top of this file. Running them up there
// warned "no such table" on fresh databases and left the columns MISSING on
// new installs (existing fleet DBs got them because their tables already
// existed). They live here, after every CREATE, so fresh and upgraded
// databases converge on the same schema.
await addColumnIfMissing("research_notes", "lamport_ts", "INTEGER DEFAULT 0");
await addColumnIfMissing("contacts", "feed_key", "TEXT");
await addColumnIfMissing("glasses_photos", "minio_key", "TEXT");
// LLM consolidation (Phase 1): cloud-provider tag + per-message model recording.
await addColumnIfMissing("providers", "provider_type", "TEXT");
await addColumnIfMissing("providers", "gpu_policy", "TEXT");
await addColumnIfMissing("chat_messages", "model_id", "TEXT");
await addColumnIfMissing("chat_messages", "thread_id", "INTEGER");
// Polish #2 (2026-05-12): user_priority gates the drafter's per-tick choice
// when the user replies "yes to spring isd" on a Monday digest. NULL = no
// explicit pick; convention is `1 = user-picked this week`.
await addColumnIfMissing("job_candidates", "user_priority", "INTEGER");
// Project Space M0 uuid/origin for the late-created project-scoped tables.
await addUuidColumn("research_notes");
await addUuidColumn("storage_files");
// storage_files.project_id (FK target project_spaces) — Files panel filter +
// crow_project_get file counts. NULL = global/unscoped (legacy preserved).
await addColumnIfMissing(
  "storage_files",
  "project_id",
  "INTEGER REFERENCES project_spaces(id) ON DELETE SET NULL"
);

// --- W2-5B3b (2026-06-12): drop the dormant research_projects table ---
// Preconditions enforced per host, every init-db run, until the drop happens:
//   1. every rp row is mirrored in project_spaces (zero unmirrored), and
//   2. no live DDL still references research_projects (old child-table FKs
//      must have been rebuilt to project_spaces first — B2 migrations above).
// If either check fails the table is KEPT and a warning names the blocker;
// user data is absolute, so we never drop an unmirrored row.
try {
  const rpThere = (await db.execute({
    sql: "SELECT 1 FROM sqlite_master WHERE type='table' AND name='research_projects'",
  })).rows.length > 0;
  if (rpThere) {
    const unmirrored = Number((await db.execute({
      sql: "SELECT COUNT(*) AS c FROM research_projects WHERE id NOT IN (SELECT id FROM project_spaces)",
    })).rows[0].c);
    const ddlRefs = Number((await db.execute({
      sql: "SELECT COUNT(*) AS c FROM sqlite_master WHERE name != 'research_projects' AND sql LIKE '%REFERENCES research_projects%'",
    })).rows[0].c);
    if (unmirrored === 0 && ddlRefs === 0) {
      await db.execute({ sql: "DROP TABLE research_projects" });
      console.log("  ✓ B3b: dropped dormant research_projects (all rows mirrored in project_spaces)");
    } else {
      console.warn(`  ⚠ B3b: keeping research_projects (unmirrored=${unmirrored}, ddlRefs=${ddlRefs}) — resolve before retirement`);
    }
  }
} catch (err) {
  console.warn("  ⚠ B3b drop check failed (table kept):", err.message);
}

// --- Plan B Part 2 (2026-06-14): orchestrator teardown DB cleanup ---
// The multi-agent orchestrator was retired; pi (Bot Builder) handles all
// foreground + background work. Drop its two tables and purge its legacy
// schedule rows. Guarded + idempotent: safe to re-run every init-db.
//   - orchestrator_events: observability timeline, no FK refs, disposable.
//   - orchestrator_role_overrides: synced table — its instance-sync allowlist
//     entry is removed in the same commit (servers/sharing/instance-sync.js).
//   - schedules: delete the legacy 'pipeline:%' rows (MPA pipelines + the old
//     pipeline:bot:* trackers — Q1 confirmed disposable by the operator,
//     archived at ~/crow-archives/orchestrator-retirement-2026-06-14/) but
//     PRESERVE 'pipeline:botcron:%' (the new pi-bot cron, which deliberately
//     namespaces under the gateway-scheduler-protected pipeline: prefix).
try {
  await db.execute({ sql: "DROP TABLE IF EXISTS orchestrator_events" });
  await db.execute({ sql: "DROP TABLE IF EXISTS orchestrator_role_overrides" });
  const purged = Number((await db.execute({
    sql: "SELECT COUNT(*) AS c FROM schedules WHERE task LIKE 'pipeline:%' AND task NOT LIKE 'pipeline:botcron:%'",
  })).rows[0].c);
  if (purged > 0) {
    await db.execute({
      sql: "DELETE FROM schedules WHERE task LIKE 'pipeline:%' AND task NOT LIKE 'pipeline:botcron:%'",
    });
    console.log(`  ✓ orchestrator teardown: dropped event/role tables, purged ${purged} legacy pipeline schedule(s)`);
  } else {
    console.log("  ✓ orchestrator teardown: dropped event/role tables (no legacy pipeline schedules)");
  }
} catch (err) {
  console.warn("  ⚠ orchestrator teardown cleanup failed:", err.message);
}

// --- Roster auto-advertise (Theme 12, 2026-06-15) ---
// contacts.origin distinguishes auto-materialized advertised bots ('advertised')
// from manual/invite contacts (NULL). bot_message_invites.kind tags the
// reusable paired-roster invite ('paired-roster') so it is reused, not re-minted.
await addColumnIfMissing("contacts", "origin", "TEXT");          // NULL=manual/invite, 'advertised'
await addColumnIfMissing("bot_message_invites", "kind", "TEXT"); // NULL=normal, 'paired-roster'

// --- Cross-instance bot directory (phase 2, 2026-06-16) ---
// contacts.is_bot marks a contact that is a Crow Messages bot (vs a human), so
// the UI can badge it and the future group phase can treat "add a bot" and
// "add a person" uniformly. Backfill the reliably-known bots (origin='advertised').
await addColumnIfMissing("contacts", "is_bot", "INTEGER DEFAULT 0");
await db.execute({ sql: "UPDATE contacts SET is_bot = 1 WHERE origin = 'advertised' AND is_bot = 0" });

console.log("Database initialized successfully (local file)");
db.close();
