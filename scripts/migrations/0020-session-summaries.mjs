// scripts/migrations/0020-session-summaries.mjs
//
// Session summaries (R1.2 PR 4): a finished bot session keeps a short summary
// on its own row, and the summary is also stored as a memory that must stay
// filed under its project on every paired instance.
//
//   bot_sessions.summary        TEXT  the summary text
//   bot_sessions.summary_at     TEXT  when it was written (indexed: the
//                                     briefing reads "summaries since X")
//   bot_sessions.summary_flags  TEXT  JSON, e.g. {"outside_content":true}
//   bot_sessions.briefing       TEXT  the briefing block a Perch session was
//                                     started with (the source of truth: the
//                                     engine rewrites the system prompt file
//                                     from it on every spawn and wake)
//   bot_sessions.briefing_rank  TEXT  the privacy rank ("0" this box, "1"
//                                     another box, "2" the cloud) it was built for
//   memories.project_uuid       TEXT  the project's portable id. project_id is
//                                     a local FK (project_spaces ids are
//                                     per-instance), so instance sync nulls it
//                                     on the wire and the receiver maps
//                                     project_uuid back to its own project.
//
// ADDITIVE columns with no SCHEMA_GENERATION bump: the 0006 rail. A co-hosted
// instance converging onto the new code on its own restart never re-runs
// init-db, so this adds the columns independently. The DDL matches init-db.js
// (CREATE body + guarded ALTER for bot_sessions, guarded ALTER for memories)
// and init-pi-bots.mjs (guarded ALTER) verbatim: one shape, three rails.
//
// Guarded additive ALTERs, idempotent, absent-table tolerant.
import Database from "better-sqlite3";
import { addColumnIfMissing } from "./0006-bot-sessions-archived.mjs";

export const id = "0020-session-summaries";

export const COLUMNS = Object.freeze([
  ["bot_sessions", "summary", "TEXT"],
  ["bot_sessions", "summary_at", "TEXT"],
  ["bot_sessions", "summary_flags", "TEXT"],
  ["bot_sessions", "briefing", "TEXT"],
  ["bot_sessions", "briefing_rank", "TEXT"],
  ["memories", "project_uuid", "TEXT"],
]);

export const SUMMARY_AT_INDEX_SQL =
  "CREATE INDEX IF NOT EXISTS idx_bot_sessions_summary_at ON bot_sessions (summary_at)";

// One memory per session summary (source = "session-summary:<threadId>"): the
// job's upsert relies on it. Thread ids are per-instance and unique, so the
// same source on two instances is the same memory (it syncs as an update).
// Same DDL as init-db.js.
export const SUMMARY_SOURCE_INDEX_SQL =
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_memories_session_summary_source ON memories(source) WHERE source LIKE 'session-summary:%'";

export function run({ dbPath, log = () => {} }) {
  const results = [];
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 10000");
  try {
    for (const [table, col, ddl] of COLUMNS) {
      const r = addColumnIfMissing(db, table, col, ddl);
      log(`  ${table}.${col}: ${r}`);
      results.push(r);
    }
    const hasSessions = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='bot_sessions'").get();
    if (hasSessions) db.prepare(SUMMARY_AT_INDEX_SQL).run();
    const memCols = db.prepare("PRAGMA table_info(memories)").all().map((c) => c.name);
    if (memCols.includes("source")) {
      // A store that somehow holds duplicate summary sources keeps booting;
      // the upsert still finds the oldest row by source.
      try { db.prepare(SUMMARY_SOURCE_INDEX_SQL).run(); }
      catch (e) { log(`  idx_memories_session_summary_source: not created (${e.message})`); }
    }
  } finally {
    db.close();
  }
  // Both tables are core crow.db (init-db creates them, and adds these columns
  // itself when it does). An absent table here defers rather than records, so
  // the columns land on a later boot if a table appears after this ran.
  if (results.includes("absent")) return { deferred: true, results };
  return { applied: true, results };
}
