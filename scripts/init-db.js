import { createDbClient, resolveDataDir } from "../servers/db.js";
import { mkdirSync } from "fs";
import { resolve } from "path";

// Ensure data directory exists for local file mode
if (!process.env.TURSO_DATABASE_URL) {
  const dataDir = process.env.CROW_DB_PATH
    ? resolve(process.env.CROW_DB_PATH, "..")
    : resolveDataDir();
  mkdirSync(dataDir, { recursive: true });
}

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

// --- Cross-Platform Behavioral Context (crow.md) ---

await initTable("crow_context table", `
  CREATE TABLE IF NOT EXISTS crow_context (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    section_key TEXT NOT NULL UNIQUE,
    section_title TEXT NOT NULL,
    content TEXT NOT NULL,
    sort_order INTEGER DEFAULT 0,
    enabled INTEGER DEFAULT 1,
    updated_at TEXT DEFAULT (datetime('now'))
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
- Every external source gets an APA citation — no exceptions
- Use retrieval dates for web sources
- Verify sources before marking as verified
- Cross-reference with Zotero when available

**Source types:** web_article, academic_paper, book, interview, web_search, web_scrape, api_data, document, video, podcast, social_media, government_doc, dataset, other`,
  },
  {
    key: "session_protocol",
    title: "Session Protocol",
    order: 30,
    content: `**On session start:**
1. Recall relevant context with \`crow_recall_by_context\` using the user's first message
2. Check \`crow_memory_stats\` for an overview of stored knowledge
3. Load language preference from memory
4. Consult the skills reference for routing

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

| User Intent | Capability | Tools |
|---|---|---|
| "remember", "recall", "what did we..." | Memory management | crow-memory |
| "research", "find papers", "cite" | Research pipeline | crow-research, brave-search, arxiv |
| "email", "calendar", "schedule" | Google Workspace | google-workspace |
| "task", "board", "trello" | Project management | trello |
| "assignment", "canvas", "course" | Academic | canvas-lms |
| "wiki", "notion", "page" | Knowledge base | notion |
| "slack", "discord", "teams" | Messaging | slack, discord, teams |
| "repo", "issue", "PR", "github" | Development | github |
| "search", "look up", "find" | Web search | brave-search |
| "file", "document", "folder" | File management | filesystem |
| "citation", "zotero", "reference" | Bibliography | zotero |

**Compound workflows:** Daily briefing, meeting prep, research kickoff, team updates, project organization — combine multiple tools in sequence.`,
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

const tursoMode = process.env.TURSO_DATABASE_URL ? "Turso" : "local file";
console.log(`Database initialized successfully (${tursoMode})`);
db.close();
