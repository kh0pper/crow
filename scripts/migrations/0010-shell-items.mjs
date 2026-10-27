// scripts/migrations/0010-shell-items.mjs
//
// shell_items: which project a Perch thread, an artifact or a Workspace file belongs to.
// project_id NULL means Unassigned; there is deliberately no foreign key, so deleting a project
// can never cascade an item away.
//
// ADDITIVE, no SCHEMA_GENERATION bump: init-db.js carries the same DDL (one shape, two rails, the
// 0005/0009 story), so a co-hosted instance converging on its own restart gets it too.
import { existsSync } from "node:fs";
import Database from "better-sqlite3";
import { resolveSqlitePath } from "../pi-bots/instance-paths.mjs";
import { ACTIVE_PROJECT_WHERE, deriveArtifactProject } from "../../servers/shared/shell-items.js";

export const id = "0010-shell-items";

// Byte-for-byte the block in scripts/init-db.js ("shell_items table").
export const SHELL_ITEMS_DDL = `
  CREATE TABLE IF NOT EXISTS shell_items (
    item_kind    TEXT NOT NULL CHECK (item_kind IN ('perch_thread','artifact','workspace_file')),
    item_ref     TEXT NOT NULL,
    project_id   INTEGER,
    card_id      INTEGER,
    set_by       TEXT NOT NULL CHECK (set_by IN ('backfill','origin','operator')),
    seen_version INTEGER,
    seen_at      TEXT,
    created_at   TEXT NOT NULL DEFAULT (datetime('now')),
    updated_at   TEXT NOT NULL DEFAULT (datetime('now')),
    PRIMARY KEY (item_kind, item_ref),
    CHECK (item_kind != 'perch_thread' OR card_id IS NULL)
  );
  CREATE INDEX IF NOT EXISTS idx_shell_items_project ON shell_items(project_id, item_kind);
  CREATE INDEX IF NOT EXISTS idx_shell_items_card ON shell_items(card_id) WHERE card_id IS NOT NULL;
`;

const hasTable = (db, name) => !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

/**
 * tasks.db is optional and read-only: any failure (missing, locked, unreadable, no tasks_items)
 * means "no card projects", and never throws.
 */
function openTasks(tasksDbPath, log) {
  try {
    const real = resolveSqlitePath(tasksDbPath);
    if (!real || !existsSync(real)) return null;
    const tdb = new Database(real, { readonly: true, fileMustExist: true, timeout: 2000 });
    try {
      if (!tdb.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='tasks_items'").get()) {
        tdb.close();
        return null;
      }
    } catch (e) {
      tdb.close();
      throw e;
    }
    return tdb;
  } catch (e) {
    log(`  shell_items backfill: no card projects (${e.code || e.message})`);
    return null;
  }
}

/** Best effort: files existing threads and artifacts under the project they would derive today. */
function backfill(db, tasksDbPath, log) {
  const results = [];
  const live = new Set(db.prepare(`SELECT id FROM project_spaces WHERE ${ACTIVE_PROJECT_WHERE}`).all().map((r) => r.id));
  const tdb = openTasks(tasksDbPath, log);
  let cardProject = () => null;
  if (tdb) {
    const q = tdb.prepare("SELECT project_id FROM tasks_items WHERE id = ?");
    cardProject = (cardId) => {
      if (cardId === null || cardId === undefined) return null;
      try {
        const r = q.get(cardId);
        return r && live.has(Number(r.project_id)) ? Number(r.project_id) : null;
      } catch {
        return null;
      }
    };
  }
  try {
    // 1. Threads: the newest perch-live session of each thread (session's project, else the bot's).
    const liveSql = `(SELECT id FROM project_spaces WHERE ${ACTIVE_PROJECT_WHERE})`;
    const threads = db.prepare(`
      INSERT OR IGNORE INTO shell_items (item_kind, item_ref, project_id, set_by)
      SELECT 'perch_thread', s.gateway_thread_id,
             COALESCE(CASE WHEN s.project_id IN ${liveSql} THEN s.project_id END,
                      CASE WHEN d.project_id IN ${liveSql} THEN d.project_id END),
             'backfill'
        FROM bot_sessions s LEFT JOIN pi_bot_defs d ON d.bot_id = s.bot_id
       WHERE s.kind = 'perch-live' AND s.gateway_thread_id IS NOT NULL
         AND s.id = (SELECT MAX(id) FROM bot_sessions WHERE gateway_thread_id = s.gateway_thread_id)`).run();
    results.push(`threads: ${threads.changes}`);

    // 2. The thread's card, when tasks.db could be read, beats the session and the bot.
    if (tdb) {
      const newest = db.prepare(`
        SELECT s.gateway_thread_id AS ref, s.card_id FROM bot_sessions s
         WHERE s.kind = 'perch-live' AND s.gateway_thread_id IS NOT NULL AND s.card_id IS NOT NULL
           AND s.id = (SELECT MAX(id) FROM bot_sessions WHERE gateway_thread_id = s.gateway_thread_id)`).all();
      const set = db.prepare("UPDATE shell_items SET project_id = ? WHERE item_kind = 'perch_thread' AND item_ref = ? AND set_by = 'backfill'");
      for (const r of newest) {
        const p = cardProject(r.card_id);
        if (p !== null) set.run(p, r.ref);
      }
    }

    // 3. Artifacts: origin card's project, else the origin thread's, else the creating bot's.
    if (hasTable(db, "artifacts")) {
      const botProject = db.prepare("SELECT project_id FROM pi_bot_defs WHERE bot_id = ?");
      const threadProject = db.prepare("SELECT project_id FROM shell_items WHERE item_kind = 'perch_thread' AND item_ref = ?");
      const put = db.prepare("INSERT OR IGNORE INTO shell_items (item_kind, item_ref, project_id, card_id, set_by) VALUES ('artifact', ?, ?, ?, 'backfill')");
      let n = 0;
      for (const a of db.prepare("SELECT id, created_by_bot, origin_session, origin_card FROM artifacts WHERE deleted_at IS NULL").all()) {
        const project = deriveArtifactProject({
          cardProjectId: cardProject(a.origin_card),
          threadProjectId: a.origin_session ? (threadProject.get(a.origin_session)?.project_id ?? null) : null,
          botProjectId: a.created_by_bot ? (botProject.get(a.created_by_bot)?.project_id ?? null) : null,
          liveProjectIds: live,
        });
        n += put.run(a.id, project, a.origin_card ?? null).changes;
      }
      results.push(`artifacts: ${n}`);
    } else {
      results.push("artifacts: absent");
    }
    // 4. Workspace files: no local record exists, so they start Unassigned.
  } finally {
    if (tdb) tdb.close();
  }
  return results;
}

export function run({ dbPath, tasksDbPath, log = () => {} }) {
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 10000");
  const results = [];
  try {
    db.exec(SHELL_ITEMS_DDL);
    results.push("shell_items: ensured");
    log("  shell_items: ensured");

    // The DDL is committed above. No backfill error ever fails the migration: a later read derives
    // the same values.
    try {
      const missing = ["bot_sessions", "pi_bot_defs", "project_spaces"].filter((t) => !hasTable(db, t));
      if (missing.length) {
        for (const t of missing) results.push(`${t}: absent`);
        log(`  shell_items backfill: skipped (absent: ${missing.join(", ")})`);
      } else {
        db.transaction(() => results.push(...backfill(db, tasksDbPath, log)))();
        log(`  shell_items backfill: ${results.filter((r) => /^(threads|artifacts):/.test(r)).join(", ")}`);
      }
    } catch (e) {
      log(`  shell_items backfill: skipped (${e.message})`);
      results.push(`backfill: skipped (${e.message})`);
    }
  } finally {
    db.close();
  }
  return { applied: true, results };
}
