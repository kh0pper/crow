import Database from "better-sqlite3";
import { resolve, dirname } from "path";
import { fileURLToPath } from "url";
import { mkdirSync } from "fs";

const __dirname = dirname(fileURLToPath(import.meta.url));
const DB_PATH = process.env.CROW_DB_PATH || resolve(__dirname, "../data/crow.db");

mkdirSync(dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma("journal_mode = WAL");
db.pragma("foreign_keys = ON");

// --- Persistent Memory Tables ---

db.exec(`
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

  CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(
    content, context, tags, source, category,
    content=memories,
    content_rowid=id
  );

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

db.exec(`
  CREATE TABLE IF NOT EXISTS research_projects (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    description TEXT,
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

  CREATE VIRTUAL TABLE IF NOT EXISTS sources_fts USING fts5(
    title, authors, abstract, content_summary, full_text, tags, citation_apa,
    content=research_sources,
    content_rowid=id
  );

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

db.exec(`
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

console.log("Database initialized successfully at:", DB_PATH);
db.close();
