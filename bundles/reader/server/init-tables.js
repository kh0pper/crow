/**
 * Reader — table initialization.
 *
 * Idempotent (CREATE TABLE IF NOT EXISTS / CREATE INDEX IF NOT EXISTS
 * everywhere). Safe to re-run on every server start.
 */

async function initTable(db, label, sql) {
  try {
    await db.executeMultiple(sql);
  } catch (err) {
    console.error(`[reader init] ${label}:`, err.message);
    throw err;
  }
}

export async function initReaderTables(db) {
  await initTable(db, "reader_documents", `
    CREATE TABLE IF NOT EXISTS reader_documents (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      title TEXT,
      source_type TEXT CHECK(source_type IN ('upload','url','drive','mcp')),
      source_ref TEXT,
      original_path TEXT,
      original_mime TEXT,
      archived_html_path TEXT,
      extraction_status TEXT DEFAULT 'pending'
        CHECK(extraction_status IN ('pending','ok','partial','failed')),
      extraction_diagnostics TEXT,
      language TEXT,
      tags TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_reader_documents_updated
      ON reader_documents(updated_at DESC);
  `);

  await initTable(db, "reader_sections", `
    CREATE TABLE IF NOT EXISTS reader_sections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL REFERENCES reader_documents(id) ON DELETE CASCADE,
      section_number INTEGER NOT NULL,
      title TEXT,
      paragraphs_json TEXT NOT NULL,
      UNIQUE(document_id, section_number)
    );
  `);

  await initTable(db, "reader_annotations", `
    CREATE TABLE IF NOT EXISTS reader_annotations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL REFERENCES reader_documents(id) ON DELETE CASCADE,
      section_id INTEGER REFERENCES reader_sections(id) ON DELETE SET NULL,
      kind TEXT CHECK(kind IN ('highlight','comment')),
      quote TEXT NOT NULL,
      prefix TEXT,
      suffix TEXT,
      para_hint INTEGER,
      page_hint INTEGER,
      color TEXT DEFAULT 'yellow',
      comment_md TEXT,
      author TEXT DEFAULT 'user' CHECK(author IN ('user','agent')),
      memory_id INTEGER,
      orphaned INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_reader_annotations_doc
      ON reader_annotations(document_id);
  `);

  await initTable(db, "reader_progress", `
    CREATE TABLE IF NOT EXISTS reader_progress (
      document_id INTEGER NOT NULL,
      section_number INTEGER NOT NULL DEFAULT 1,
      paragraph INTEGER NOT NULL DEFAULT 0,
      total_paragraphs INTEGER,
      audio_time REAL,
      updated_at TEXT DEFAULT (datetime('now')),
      PRIMARY KEY (document_id, section_number)
    );
  `);

  await initTable(db, "reader_chunks", `
    CREATE TABLE IF NOT EXISTS reader_chunks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      document_id INTEGER NOT NULL REFERENCES reader_documents(id) ON DELETE CASCADE,
      section_id INTEGER REFERENCES reader_sections(id) ON DELETE CASCADE,
      chunk_index INTEGER NOT NULL,
      text TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS reader_chunk_embeddings (
      chunk_id INTEGER PRIMARY KEY REFERENCES reader_chunks(id) ON DELETE CASCADE,
      model TEXT,
      dim INTEGER,
      vec BLOB,
      created_at TEXT DEFAULT (datetime('now'))
    );
  `);

  await initTable(db, "reader_documents FTS", `
    CREATE VIRTUAL TABLE IF NOT EXISTS reader_documents_fts USING fts5(
      title, tags, source_ref,
      content=reader_documents, content_rowid=id
    );
  `);
  await initTable(db, "reader_documents FTS triggers", `
    CREATE TRIGGER IF NOT EXISTS reader_documents_ai AFTER INSERT ON reader_documents BEGIN
      INSERT INTO reader_documents_fts(rowid, title, tags, source_ref)
      VALUES (new.id, new.title, new.tags, new.source_ref);
    END;
    CREATE TRIGGER IF NOT EXISTS reader_documents_ad AFTER DELETE ON reader_documents BEGIN
      INSERT INTO reader_documents_fts(reader_documents_fts, rowid, title, tags, source_ref)
      VALUES ('delete', old.id, old.title, old.tags, old.source_ref);
    END;
    CREATE TRIGGER IF NOT EXISTS reader_documents_au AFTER UPDATE ON reader_documents BEGIN
      INSERT INTO reader_documents_fts(reader_documents_fts, rowid, title, tags, source_ref)
      VALUES ('delete', old.id, old.title, old.tags, old.source_ref);
      INSERT INTO reader_documents_fts(rowid, title, tags, source_ref)
      VALUES (new.id, new.title, new.tags, new.source_ref);
    END;
  `);

  await initTable(db, "reader_annotations FTS", `
    CREATE VIRTUAL TABLE IF NOT EXISTS reader_annotations_fts USING fts5(
      quote, comment_md,
      content=reader_annotations, content_rowid=id
    );
  `);
  await initTable(db, "reader_annotations FTS triggers", `
    CREATE TRIGGER IF NOT EXISTS reader_annotations_ai AFTER INSERT ON reader_annotations BEGIN
      INSERT INTO reader_annotations_fts(rowid, quote, comment_md)
      VALUES (new.id, new.quote, new.comment_md);
    END;
    CREATE TRIGGER IF NOT EXISTS reader_annotations_ad AFTER DELETE ON reader_annotations BEGIN
      INSERT INTO reader_annotations_fts(reader_annotations_fts, rowid, quote, comment_md)
      VALUES ('delete', old.id, old.quote, old.comment_md);
    END;
    CREATE TRIGGER IF NOT EXISTS reader_annotations_au AFTER UPDATE ON reader_annotations BEGIN
      INSERT INTO reader_annotations_fts(reader_annotations_fts, rowid, quote, comment_md)
      VALUES ('delete', old.id, old.quote, old.comment_md);
      INSERT INTO reader_annotations_fts(rowid, quote, comment_md)
      VALUES (new.id, new.quote, new.comment_md);
    END;
  `);
}
