/**
 * Knowledge Base Bundle — Table Initialization
 *
 * Creates all KB-related tables and indexes.
 * Safe to re-run (uses CREATE TABLE IF NOT EXISTS everywhere).
 */

async function initTable(db, label, sql) {
  try {
    await db.executeMultiple(sql);
  } catch (err) {
    console.error(`Failed to initialize ${label}:`, err.message);
    throw err;
  }
}

/**
 * Initialize all knowledge base tables in the database.
 * @param {object} db - @libsql/client database instance
 */
export async function initKbTables(db) {
  await initTable(db, "kb_collections", `
    CREATE TABLE IF NOT EXISTS kb_collections (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      slug TEXT NOT NULL UNIQUE,
      name TEXT NOT NULL,
      description TEXT,
      default_language TEXT DEFAULT 'en',
      languages TEXT DEFAULT 'en,es',
      visibility TEXT DEFAULT 'private' CHECK(visibility IN ('private', 'public', 'peers', 'lan')),
      lan_enabled INTEGER DEFAULT 0,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);

  await initTable(db, "kb_categories", `
    CREATE TABLE IF NOT EXISTS kb_categories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      collection_id INTEGER NOT NULL REFERENCES kb_collections(id) ON DELETE CASCADE,
      slug TEXT NOT NULL,
      sort_order INTEGER DEFAULT 0,
      icon TEXT,
      UNIQUE(collection_id, slug)
    );

    CREATE INDEX IF NOT EXISTS idx_kb_categories_collection ON kb_categories(collection_id);
  `);

  await initTable(db, "kb_category_names", `
    CREATE TABLE IF NOT EXISTS kb_category_names (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      category_id INTEGER NOT NULL REFERENCES kb_categories(id) ON DELETE CASCADE,
      language TEXT NOT NULL,
      name TEXT NOT NULL,
      UNIQUE(category_id, language)
    );

    CREATE INDEX IF NOT EXISTS idx_kb_category_names_category ON kb_category_names(category_id);
  `);

  await initTable(db, "kb_articles", `
    CREATE TABLE IF NOT EXISTS kb_articles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      collection_id INTEGER NOT NULL REFERENCES kb_collections(id) ON DELETE CASCADE,
      category_id INTEGER REFERENCES kb_categories(id) ON DELETE SET NULL,
      pair_id TEXT NOT NULL,
      language TEXT NOT NULL DEFAULT 'en',
      slug TEXT NOT NULL,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      excerpt TEXT,
      author TEXT,
      status TEXT DEFAULT 'draft' CHECK(status IN ('draft', 'published', 'archived')),
      tags TEXT,
      last_verified_at TEXT,
      verified_by TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now')),
      published_at TEXT,
      UNIQUE(collection_id, slug, language),
      UNIQUE(pair_id, language)
    );

    CREATE INDEX IF NOT EXISTS idx_kb_articles_collection ON kb_articles(collection_id);
    CREATE INDEX IF NOT EXISTS idx_kb_articles_pair ON kb_articles(pair_id);
    CREATE INDEX IF NOT EXISTS idx_kb_articles_category ON kb_articles(category_id);
    CREATE INDEX IF NOT EXISTS idx_kb_articles_status ON kb_articles(status);
    CREATE INDEX IF NOT EXISTS idx_kb_articles_language ON kb_articles(language);
  `);

  await initTable(db, "kb_articles FTS index", `
    CREATE VIRTUAL TABLE IF NOT EXISTS kb_articles_fts USING fts5(
      title, content, excerpt, tags,
      content=kb_articles,
      content_rowid=id
    );
  `);

  await initTable(db, "kb_articles FTS triggers", `
    CREATE TRIGGER IF NOT EXISTS kb_articles_ai AFTER INSERT ON kb_articles BEGIN
      INSERT INTO kb_articles_fts(rowid, title, content, excerpt, tags)
      VALUES (new.id, new.title, new.content, new.excerpt, new.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS kb_articles_ad AFTER DELETE ON kb_articles BEGIN
      INSERT INTO kb_articles_fts(kb_articles_fts, rowid, title, content, excerpt, tags)
      VALUES ('delete', old.id, old.title, old.content, old.excerpt, old.tags);
    END;

    CREATE TRIGGER IF NOT EXISTS kb_articles_au AFTER UPDATE ON kb_articles BEGIN
      INSERT INTO kb_articles_fts(kb_articles_fts, rowid, title, content, excerpt, tags)
      VALUES ('delete', old.id, old.title, old.content, old.excerpt, old.tags);
      INSERT INTO kb_articles_fts(rowid, title, content, excerpt, tags)
      VALUES (new.id, new.title, new.content, new.excerpt, new.tags);
    END;
  `);

  await initTable(db, "kb_resources", `
    CREATE TABLE IF NOT EXISTS kb_resources (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      article_id INTEGER NOT NULL REFERENCES kb_articles(id) ON DELETE CASCADE,
      name TEXT NOT NULL,
      phone TEXT,
      address TEXT,
      website TEXT,
      hours TEXT,
      eligibility TEXT,
      notes TEXT,
      sort_order INTEGER DEFAULT 0,
      last_verified_at TEXT,
      verified_by TEXT,
      flagged INTEGER DEFAULT 0,
      flag_reason TEXT,
      flagged_at TEXT,
      created_at TEXT DEFAULT (datetime('now')),
      updated_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_kb_resources_article ON kb_resources(article_id);
    CREATE INDEX IF NOT EXISTS idx_kb_resources_flagged ON kb_resources(flagged);
  `);

  await initTable(db, "kb_review_log", `
    CREATE TABLE IF NOT EXISTS kb_review_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      resource_id INTEGER REFERENCES kb_resources(id) ON DELETE SET NULL,
      article_id INTEGER REFERENCES kb_articles(id) ON DELETE SET NULL,
      action TEXT NOT NULL,
      details TEXT,
      reviewed_by TEXT,
      created_at TEXT DEFAULT (datetime('now'))
    );

    CREATE INDEX IF NOT EXISTS idx_kb_review_log_resource ON kb_review_log(resource_id);
    CREATE INDEX IF NOT EXISTS idx_kb_review_log_article ON kb_review_log(article_id);
  `);
}
