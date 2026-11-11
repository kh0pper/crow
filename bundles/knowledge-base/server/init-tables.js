/**
 * Knowledge Base Bundle — Table Initialization
 *
 * Creates all KB-related tables and indexes.
 * Safe to re-run (uses CREATE TABLE IF NOT EXISTS everywhere).
 *
 * kb_articles also gets ITS VERSION-HISTORY TRIGGERS here (the version history
 * design; implementation plan Task 7). The table is BUNDLE-OWNED, so migration
 * 0025 cannot install them on a fresh install: it runs before this bundle creates
 * the table, logs the skip with that reason and applies the rest of its types.
 * This is the same ensure path every other covered type gets — the trigger SQL
 * comes from servers/shared/history/covered.js (`triggerSql("kb_article")`)
 * through the app root, so a bundle copy and the migration cannot drift, and
 * CREATE TRIGGER IF NOT EXISTS makes a re-run a no-op.
 *
 * A TABLE THIS FUNCTION JUST CREATED NEEDS NO BASELINE (it has no rows). ONE THAT
 * ALREADY HELD ARTICLES DOES, AND THE ORDER MATTERS: this runs on EVERY init, and
 * the triggers may be absent on a table that is already populated — a host that
 * installed the bundle before this task, a store restored from a backup taken
 * before 0025, an operator who dropped a trigger. Installing the triggers first
 * would let the very next save be captured as an item's only version while its
 * earlier value was never stored (and 0025's per-item baseline would then skip it
 * forever). So when a trigger is missing, the baseline runs FIRST and both go in
 * ONE transaction (BEGIN IMMEDIATE), exactly as 0025's own install does: no other
 * connection can observe the half-installed state. The baseline is per item, so
 * re-running it writes nothing.
 *
 * If crow.db has never had history installed (0024 or 0025 deferred), the trigger
 * install is skipped: a trigger with no item_versions to write into would fail
 * every article save.
 */
import { appImport } from "./app-root.js";

async function initTable(db, label, sql) {
  try {
    await db.executeMultiple(sql);
  } catch (err) {
    console.error(`Failed to initialize ${label}:`, err.message);
    throw err;
  }
}

/** The three capture trigger names for kb_articles (covered.js's naming). */
const ARTICLE_TRIGGERS = ["hist_kb_articles_ai", "hist_kb_articles_au", "hist_kb_articles_ad"];

/**
 * Install the kb_article capture triggers, baselining existing articles FIRST.
 *
 * Never fatal: an article that cannot be versioned is worth more than a bundle
 * that refuses to start, and the reason is logged so "history is off for the KB"
 * is visible rather than silent.
 */
async function ensureArticleHistory(db) {
  try {
    const { rows } = await db.execute({
      sql: "SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('kb_articles', 'item_versions', 'item_versions_erase')",
    });
    const tables = new Set(rows.map((r) => r.name));
    if (!tables.has("kb_articles")) return;
    if (!tables.has("item_versions") || !tables.has("item_versions_erase")) {
      return; // the history migration has not applied here: nothing to write into yet
    }
    const present = new Set(
      (await db.execute({
        sql: `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name IN (${ARTICLE_TRIGGERS.map(() => "?").join(", ")})`,
        args: ARTICLE_TRIGGERS,
      })).rows.map((r) => r.name),
    );
    if (ARTICLE_TRIGGERS.every((name) => present.has(name))) return; // already installed

    // One definition of both halves, from covered.js (through the app root, so the
    // bundle copy and the migration cannot drift).
    const { COVERED, baselineSql, triggerSql } = await appImport("servers/shared/history/covered.js");
    // BEGIN IMMEDIATE, not a bare sequence of statements: the baseline and the
    // triggers must land together (see the header), and a deferred transaction can
    // upgrade to a write lock halfway through and see a competing save.
    await db.execute("BEGIN IMMEDIATE");
    try {
      await db.execute(baselineSql("kb_article", COVERED.kb_article));
      for (const sql of triggerSql("kb_article")) await db.execute(sql);
      await db.execute("COMMIT");
    } catch (err) {
      try {
        await db.execute("ROLLBACK");
      } catch {
        /* the failure below is the one worth reporting */
      }
      throw err;
    }
  } catch (err) {
    console.warn(`[knowledge-base] article history triggers were not installed: ${err.message}`);
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

  // The version-history capture triggers for kb_articles (see the header). After
  // the table and its FTS triggers, so a failure here can never cost the article
  // index; nothing else in this file depends on them.
  await ensureArticleHistory(db);

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
