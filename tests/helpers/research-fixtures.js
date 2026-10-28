// Shared research-table fixtures for the fetch-before-cite work.
//
// makePre0013Db: the research_sources / research_notes shape every current instance carries
// before migration 0013 (FK → project_spaces, plus the columns init-db adds by ALTER), with the
// sources FTS index and its triggers. makeOldFkDb: the same tables in their pre-W2-5-B2 shape,
// whose project_id FKs still point at research_projects (init-db's rebuild must run first).
//
// Both seed the same rows: sources 1-3 (verified = 1, 1, 0) and one note on source 1. Rows carry
// project_id NULL so no project table is needed; a test that wants a project adds its own.
// The FK parent tables (project_spaces / research_projects, data_backends) are deliberately NOT
// created, so init-db can still build them in full on the fixture; until it has, write to a
// fixture through openFixtureDb (foreign_keys OFF), since SQLite refuses an INSERT whose FK parent
// table does not exist. Synchronous, better-sqlite3 only. The makers return the path given.
import Database from "better-sqlite3";

const SOURCE_TYPES = `'web_article', 'academic_paper', 'book', 'interview',
      'web_search', 'web_scrape', 'api_data', 'document',
      'video', 'podcast', 'social_media', 'government_doc',
      'dataset', 'other'`;

function sourcesDdl(projectTable) {
  return `
    CREATE TABLE research_sources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER,
      title TEXT NOT NULL,
      source_type TEXT NOT NULL CHECK(source_type IN (
      ${SOURCE_TYPES}
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
      FOREIGN KEY (project_id) REFERENCES ${projectTable}(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_sources_project ON research_sources(project_id);
    CREATE INDEX IF NOT EXISTS idx_sources_type ON research_sources(source_type);
    CREATE INDEX IF NOT EXISTS idx_sources_verified ON research_sources(verified);
    ALTER TABLE research_sources ADD COLUMN backend_id INTEGER REFERENCES data_backends(id) ON DELETE SET NULL;
    ALTER TABLE research_sources ADD COLUMN uuid TEXT;
    ALTER TABLE research_sources ADD COLUMN origin_instance_id TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_research_sources_uuid ON research_sources(uuid);

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
  `;
}

function notesDdl(projectTable) {
  return `
    CREATE TABLE research_notes (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      project_id INTEGER,
      source_id INTEGER,
      title TEXT,
      content TEXT NOT NULL,
      note_type TEXT DEFAULT 'note' CHECK(note_type IN ('note', 'quote', 'summary', 'analysis', 'question', 'insight')),
      tags TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      FOREIGN KEY (project_id) REFERENCES ${projectTable}(id) ON DELETE SET NULL,
      FOREIGN KEY (source_id) REFERENCES research_sources(id) ON DELETE SET NULL
    );
    CREATE INDEX IF NOT EXISTS idx_notes_project ON research_notes(project_id);
    CREATE INDEX IF NOT EXISTS idx_notes_source ON research_notes(source_id);
    ALTER TABLE research_notes ADD COLUMN lamport_ts INTEGER DEFAULT 0;
    ALTER TABLE research_notes ADD COLUMN updated_at TEXT;
    ALTER TABLE research_notes ADD COLUMN uuid TEXT;
    ALTER TABLE research_notes ADD COLUMN origin_instance_id TEXT;
    CREATE UNIQUE INDEX IF NOT EXISTS idx_research_notes_uuid ON research_notes(uuid);
  `;
}

function seed(db) {
  const src = db.prepare(`INSERT INTO research_sources (id, title, source_type, url, citation_apa, verified, uuid)
                          VALUES (?, ?, 'web_article', ?, ?, ?, ?)`);
  src.run(1, "First source", "https://example.com/one", "First. (2026). example.com.", 1, "u-src-1");
  src.run(2, "Second source", "https://example.com/two", "Second. (2026). example.com.", 1, "u-src-2");
  src.run(3, "Third source", "https://example.com/three", "Third. (2026). example.com.", 0, "u-src-3");
  db.prepare(`INSERT INTO research_notes (id, source_id, title, content, note_type, uuid)
              VALUES (1, 1, 'A note', 'Something the first source said.', 'note', 'u-note-1')`).run();
}

function build(path, projectTable) {
  const db = new Database(path);
  try {
    db.pragma("foreign_keys = OFF");
    db.exec(sourcesDdl(projectTable));
    db.exec(notesDdl(projectTable));
    seed(db);
  } finally {
    db.close();
  }
  return path;
}

/** The current (pre-0013) research tables, FK → project_spaces. */
export function makePre0013Db(path) {
  return build(path, "project_spaces");
}

/** The pre-W2-5-B2 research tables, FK → research_projects. */
export function makeOldFkDb(path) {
  return build(path, "research_projects");
}

/** A connection with foreign_keys OFF, for writing to a fixture init-db has not yet run on. */
export function openFixtureDb(path) {
  const db = new Database(path);
  db.pragma("foreign_keys = OFF");
  return db;
}
