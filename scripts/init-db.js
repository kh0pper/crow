import { createDbClient, resolveDataDir, isSqliteVecAvailable } from "../servers/db.js";
import { mkdirSync } from "fs";
import { resolve } from "path";

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
  CREATE TABLE IF NOT EXISTS research_projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
    type TEXT DEFAULT 'research',
    status TEXT DEFAULT 'active' CHECK(status IN ('active', 'paused', 'completed', 'archived')),
    tags TEXT,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

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
    FOREIGN KEY (project_id) REFERENCES research_projects(id) ON DELETE SET NULL
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
    FOREIGN KEY (project_id) REFERENCES research_projects(id) ON DELETE CASCADE
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

await addColumnIfMissing("research_projects", "type", "TEXT DEFAULT 'research'");
await addColumnIfMissing("research_sources", "backend_id", "INTEGER REFERENCES data_backends(id) ON DELETE SET NULL");
await addColumnIfMissing("contacts", "feed_key", "TEXT");

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
    FOREIGN KEY (project_id) REFERENCES research_projects(id) ON DELETE SET NULL,
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
await addColumnIfMissing("chat_messages", "thread_id", "INTEGER");

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

await initTable("sync_state table", `
  CREATE TABLE IF NOT EXISTS sync_state (
    instance_id TEXT PRIMARY KEY,
    local_counter INTEGER DEFAULT 0,
    last_applied_seq_per_peer TEXT DEFAULT '{}',
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);

// --- Lamport timestamp columns for synced tables ---

await addColumnIfMissing("memories", "lamport_ts", "INTEGER DEFAULT 0");
await addColumnIfMissing("crow_context", "lamport_ts", "INTEGER DEFAULT 0");
await addColumnIfMissing("contacts", "lamport_ts", "INTEGER DEFAULT 0");
await addColumnIfMissing("shared_items", "lamport_ts", "INTEGER DEFAULT 0");
await addColumnIfMissing("messages", "lamport_ts", "INTEGER DEFAULT 0");
await addColumnIfMissing("relay_config", "lamport_ts", "INTEGER DEFAULT 0");
await addColumnIfMissing("crow_instances", "lamport_ts", "INTEGER DEFAULT 0");

// --- Contacts panel: new columns for profiles, manual contacts ---
await addColumnIfMissing("contacts", "avatar_url", "TEXT");
await addColumnIfMissing("contacts", "bio", "TEXT");
await addColumnIfMissing("contacts", "notes", "TEXT");
await addColumnIfMissing("contacts", "contact_type", "TEXT DEFAULT 'crow'");
await addColumnIfMissing("contacts", "email", "TEXT");
await addColumnIfMissing("contacts", "phone", "TEXT");

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

// --- Optional: sqlite-vec virtual table for semantic search ---
const hasVec = await isSqliteVecAvailable(db);
if (hasVec) {
  await initTable("memory_embeddings virtual table (sqlite-vec)", `
    CREATE VIRTUAL TABLE IF NOT EXISTS memory_embeddings USING vec0(
      memory_id INTEGER PRIMARY KEY,
      embedding FLOAT[1536]
    );
  `);
  console.log("  ✓ sqlite-vec available — semantic search enabled");
} else {
  console.log("  ℹ sqlite-vec not available — using FTS5 only (semantic search disabled)");
}

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

console.log("Database initialized successfully (local file)");
db.close();
