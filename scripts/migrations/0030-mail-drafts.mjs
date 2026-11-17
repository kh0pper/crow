// scripts/migrations/0030-mail-drafts.mjs
//
// Crow Mail's draft card tables (plan 3): mail_drafts (one row per draft card), mail_draft_revisions
// (immutable versions of it), mail_draft_voice (the voice note for a revision) and mail_draft_comments
// (the person's line-by-line comments). Times are epoch ms written by the draft store's own clock, so
// a test's fake clock moves them. mode, state, tap_action and the other value lists carry no CHECK:
// the store validates them in JS. No foreign keys: the store removes one draft's rows itself. LOCAL
// ONLY: every name is in instance-sync's LOCAL_ONLY_TABLES, because a draft and a voice note hold the
// recipients, the body and the operator's speech, and never leave the instance holding them.
//
// ADDITIVE, no SCHEMA_GENERATION bump: init-db.js carries the same DDL as MAIL_DRAFTS_DDL
// (servers/shared/mail-schema.js) on its own rail, so a co-hosted instance converging on its own
// restart gets it too. DDL only: there is nothing to backfill, and no schema object or row is
// removed. 0027's MAIL_DDL is untouched — these tables are a separate constant, because 0027 executes
// MAIL_DDL and its approved shape stays exactly as it is.
import Database from "better-sqlite3";
import { MAIL_DRAFTS_DDL, MAIL_DRAFT_TABLES } from "../../servers/shared/mail-schema.js";

export const id = "0030-mail-drafts";

// rollbackSafe: four new local-only tables and three indexes only; older code never reads them.
export const rollbackSafe = true;

export function run({ dbPath, log = () => {} }) {
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 10000");
  try {
    db.exec(MAIL_DRAFTS_DDL);
    // CREATE TABLE/INDEX IF NOT EXISTS, so a re-run after a partial apply finds whatever is already
    // there and says the same thing.
    for (const table of MAIL_DRAFT_TABLES) log(`  ${table}: ensured`);
    return { applied: true, results: MAIL_DRAFT_TABLES.map((t) => `${t}: ensured`) };
  } finally {
    db.close();
  }
}