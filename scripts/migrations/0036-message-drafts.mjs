// scripts/migrations/0036-message-drafts.mjs
//
// Crow Messages' drafts: message_drafts (one row per draft of a message to one conversation — a
// contact or a room — with the body, the version an autosave compares against, and the sealed
// recipient set) and message_draft_audit (one row per create, edit, send and discard: ids and hashes
// only, never the text). A bot's message is ALWAYS a draft in v1, so this table is the door every
// bot message comes through. Times are epoch ms. conversation_kind, origin, state and action carry no
// CHECK: servers/gateway/messages/drafts-store.js validates them in JS. No foreign keys: a
// conversation lives in another table and the store removes one draft's rows itself. LOCAL ONLY:
// both names are in instance-sync's LOCAL_ONLY_TABLES, because a draft holds who a message is for and
// the words of it, and neither leaves the instance that wrote them.
//
// NUMBERING: 0034 and 0035 belong to the Reports stack (Recurring Reports, in flight in its own PRs
// when this landed), so the drafts migration was renumbered past them rather than claiming a number
// that would collide with it. The runner applies a migration by its `id`, in file-name order, and
// never requires the numbers to be contiguous — 0012 is another gap — so leaving 0034/0035 to Reports
// costs nothing here and the two branches merge without a prefix collision.
//
// ADDITIVE, no SCHEMA_GENERATION bump: init-db.js carries the same DDL as MESSAGE_DRAFTS_DDL
// (servers/shared/message-drafts-schema.js) on its own rail, so a co-hosted instance converging on
// its own restart gets it too. DDL only: there is nothing to backfill, and no schema object or row is
// removed.
import Database from "better-sqlite3";
import {
  MESSAGE_DRAFTS_BOT_NAME_COLUMN,
  MESSAGE_DRAFTS_DDL,
  MESSAGE_DRAFT_TABLES,
} from "../../servers/shared/message-drafts-schema.js";

export const id = "0036-message-drafts";

// rollbackSafe: two new local-only tables and four indexes only; older code never reads them.
export const rollbackSafe = true;

export function run({ dbPath, log = () => {} }) {
  const db = new Database(dbPath);
  db.pragma("busy_timeout = 10000");
  try {
    db.exec(MESSAGE_DRAFTS_DDL);
    // CREATE TABLE/INDEX IF NOT EXISTS, so a re-run after a partial apply finds whatever is already
    // there and says the same thing.
    for (const table of MESSAGE_DRAFT_TABLES) log(`  ${table}: ensured`);
    // An install that made the table from an earlier build of this branch (before bot_name was part
    // of the shape) gets the column here: CREATE TABLE IF NOT EXISTS never adds one. Same guarded
    // ADD COLUMN the init-db rail runs, from the same constant.
    const columns = db.prepare("PRAGMA table_info(message_drafts)").all().map((c) => c.name);
    if (!columns.includes(MESSAGE_DRAFTS_BOT_NAME_COLUMN.column)) {
      db.exec(MESSAGE_DRAFTS_BOT_NAME_COLUMN.ddl);
    }
    log(`  ${MESSAGE_DRAFTS_BOT_NAME_COLUMN.column} column: ensured`);
    return { applied: true, results: [...MESSAGE_DRAFT_TABLES.map((t) => `${t}: ensured`), "bot_name: ensured"] };
  } finally {
    db.close();
  }
}