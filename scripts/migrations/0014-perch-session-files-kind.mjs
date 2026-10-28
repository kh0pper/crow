// scripts/migrations/0014-perch-session-files-kind.mjs
//
// perch_session_files.kind + .turn_anchor (live browser tile): a turn's final
// browser screenshot is stored like a file the bot sent, but marked
// kind='browser_shot' so a bot can never fake a tile by sending a file with a
// look-alike name (sent files keep the default kind='file'), and turn_anchor
// (the turn's first browser toolCallId) lets a reload place the frozen tile in
// its turn rather than at the top.
//
// ADDITIVE columns with no SCHEMA_GENERATION bump — the 0006 rail: a co-hosted
// instance converging onto the new code on its own restart never re-runs
// init-db, so this adds the columns independently. The history reader also
// tolerates their absence (an instance restarted before it migrated).
//
// Guarded additive ALTERs, idempotent, absent-table tolerant.
import Database from "better-sqlite3";
import { addColumnIfMissing } from "./0006-bot-sessions-archived.mjs";

export const id = "0014-perch-session-files-kind";

export function run({ dbPath, log = () => {} }) {
  const results = [];
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 10000");
  try {
    // DDL matches init-db.js's own addColumnIfMissing calls verbatim (beside
    // the perch_session_files CREATE) — one shape, two rails.
    for (const [col, ddl] of [["kind", "TEXT NOT NULL DEFAULT 'file'"], ["turn_anchor", "TEXT"]]) {
      const r = addColumnIfMissing(db, "perch_session_files", col, ddl);
      log(`  perch_session_files.${col}: ${r}`);
      results.push(r);
    }
  } finally {
    db.close();
  }
  // perch_session_files is created by 0007 (earlier in the same run) and by
  // init-db, whose CREATE body carries both columns. An absent table here is
  // not expected; defer rather than record, so the columns land on a later
  // boot if 0007's table ever appears after this ran.
  if (results.includes("absent")) return { deferred: true, results };
  return { applied: true, results };
}
