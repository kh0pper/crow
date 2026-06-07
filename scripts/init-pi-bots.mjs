#!/usr/bin/env node
/**
 * Crow Bot Builder — Phase 1 substrate migration.
 *
 * Creates the TWO NEW tables the Bot Builder owns. This is deliberately a
 * SEPARATE script (NOT scripts/init-db.js) so it can never touch the 3
 * production MPA bots (bot_registry / presets / pipelines / schedules /
 * bot_conversations). Idempotent — safe to re-run.
 *
 *   pi_bot_defs  — GUI-defined pi bot definitions (engine, models, tools,
 *                  gateways, project_id, permission_policy, triggers, prompt)
 *   bot_sessions — one row per (bot, gateway thread) live pi session; the
 *                  bridge's runtime authority for status + stop control
 *
 * Single-authority-per-fact (plan §1): bot_sessions.status = runtime state
 * (owner: bridge), tasks_items.status = board state (owner: tasks tool),
 * the plan file = work content. No triple source of truth.
 *
 * DB: the live MPA crow.db. We open with better-sqlite3 directly (like
 * router_dispatch.mjs / router_tasks_smoke.mjs) and set ONLY busy_timeout —
 * we deliberately DO NOT touch journal_mode (the gateway keeps crow.db in
 * DELETE; a stray journal_mode pragma from a transient connection is exactly
 * the WAL-flip / SQLITE_BUSY trap, see memory crowdb-wal-flip-new-consumers).
 *
 * Usage:  node scripts/init-pi-bots.mjs            (apply)
 *         node scripts/init-pi-bots.mjs --check     (report only, no DDL)
 */

import Database from "/home/kh0pp/crow/node_modules/better-sqlite3/lib/index.js";

const DB_PATH = process.env.CROW_DB_PATH || "/home/kh0pp/.crow-mpa/data/crow.db";
const CHECK_ONLY = process.argv.includes("--check");

const db = new Database(DB_PATH);
db.pragma("busy_timeout = 10000");
db.pragma("foreign_keys = ON");

const tableExists = (name) =>
  !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);

// --- Guard: never run if the production substrate looks wrong ---
const prodBots = db.prepare("SELECT count(*) c FROM bot_registry").get().c;
if (prodBots < 1) {
  console.error(`REFUSING: bot_registry has ${prodBots} rows — not the live MPA db? (DB_PATH=${DB_PATH})`);
  process.exit(2);
}

const before = { pi_bot_defs: tableExists("pi_bot_defs"), bot_sessions: tableExists("bot_sessions"), bot_skill_events: tableExists("bot_skill_events") };

if (CHECK_ONLY) {
  console.log(`[init-pi-bots] CHECK DB=${DB_PATH} bot_registry=${prodBots}`);
  console.log(`  pi_bot_defs exists=${before.pi_bot_defs}  bot_sessions exists=${before.bot_sessions}  bot_skill_events exists=${before.bot_skill_events}`);
  if (before.bot_sessions) {
    const c = db.prepare("PRAGMA table_info(bot_sessions)").all().map((x) => x.name);
    console.log(`  bot_sessions.model=${c.includes("model")} bot_sessions.escalated=${c.includes("escalated")}`);
  }
  process.exit(0);
}

const DDL = [
  `CREATE TABLE IF NOT EXISTS pi_bot_defs (
     bot_id        TEXT PRIMARY KEY,
     display_name  TEXT NOT NULL,
     definition    TEXT,                 -- JSON: engine/models/tools/gateways/project_id/permission_policy/triggers/system_prompt/skills/session_dir
     enabled       INTEGER NOT NULL DEFAULT 1,
     created_at    TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at    TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  `CREATE TABLE IF NOT EXISTS bot_sessions (
     id                INTEGER PRIMARY KEY AUTOINCREMENT,
     bot_id            TEXT NOT NULL,
     pi_session_id     TEXT,
     pi_session_dir    TEXT,
     gateway_type      TEXT,
     gateway_thread_id TEXT,
     project_id        INTEGER,
     card_id           INTEGER,
     plan_path         TEXT,
     status            TEXT NOT NULL DEFAULT 'active'
                          CHECK (status IN ('active','waiting-user','stopped','done','error')),
     control           TEXT NOT NULL DEFAULT 'run'
                          CHECK (control IN ('run','stop')),
     created_at        TEXT NOT NULL DEFAULT (datetime('now')),
     updated_at        TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  // Resolve a session by (bot, gateway thread) — the bridge's hot path.
  `CREATE INDEX IF NOT EXISTS idx_bot_sessions_bot_thread
     ON bot_sessions (bot_id, gateway_thread_id)`,
  `CREATE INDEX IF NOT EXISTS idx_bot_sessions_status
     ON bot_sessions (status)`,
  `CREATE INDEX IF NOT EXISTS idx_pi_bot_defs_enabled
     ON pi_bot_defs (enabled)`,
  // Self-learning provenance + guaranteed audit sink (plan §B5). This is the
  // SOURCE OF TRUTH for "which bot authored which skill" — auto-mode patch
  // eligibility (a bot may only patch a skill it created) reads it. It is also
  // the audit record that works for NULL-project bots, where the project
  // audit_log helper no-ops. One row per propose/create/patch/reject/downgrade.
  `CREATE TABLE IF NOT EXISTS bot_skill_events (
     id          INTEGER PRIMARY KEY AUTOINCREMENT,
     bot_id      TEXT NOT NULL,
     skill_name  TEXT NOT NULL,
     action      TEXT NOT NULL
                   CHECK (action IN ('propose','create','patch','reject','downgrade')),
     mode        TEXT,                 -- 'propose' | 'auto' | 'operator'
     model       TEXT,                 -- model the review pass ran on, if any
     flags_json  TEXT,                 -- JSON array of guardrail-phrase flags, if any
     created_at  TEXT NOT NULL DEFAULT (datetime('now'))
   )`,
  // Authorship + history lookups: "did bot X author skill Y?" and the per-bot feed.
  `CREATE INDEX IF NOT EXISTS idx_bot_skill_events_bot_skill
     ON bot_skill_events (bot_id, skill_name)`,
  `CREATE INDEX IF NOT EXISTS idx_bot_skill_events_bot_time
     ON bot_skill_events (bot_id, created_at)`,
];

const tx = db.transaction(() => { for (const sql of DDL) db.prepare(sql).run(); });
tx();

// --- Phase 3.0 migration (plan POST-REVIEW REVISIONS, Round 1 — R1).
// Additive, idempotent, and run OUTSIDE the DDL transaction above so a benign
// re-run (this script runs on every deploy) can NEVER roll back the
// CREATE/INDEX block. SQLite has no `ADD COLUMN IF NOT EXISTS`, so each
// column is guarded by a PRAGMA table_info presence check. The
// `CREATE TABLE IF NOT EXISTS bot_sessions` body is intentionally left
// UNCHANGED — fresh and pre-existing installs converge through this same
// guarded ALTER (schema evolution is ALTER-driven going forward). Opened
// busy_timeout-only (no journal_mode pragma); ADD COLUMN does not rebuild
// the table so the status/control CHECK constraints + foreign_keys=ON are
// unaffected.
const migAdded = [];
if (tableExists("bot_sessions")) {
  const have = db.prepare("PRAGMA table_info(bot_sessions)").all().map((c) => c.name);
  if (!have.includes("model")) {
    db.prepare("ALTER TABLE bot_sessions ADD COLUMN model TEXT").run();
    migAdded.push("model");
  }
  if (!have.includes("escalated")) {
    db.prepare("ALTER TABLE bot_sessions ADD COLUMN escalated INTEGER DEFAULT 0").run();
    migAdded.push("escalated");
  }
}
console.log(`  bot_sessions migration: ${migAdded.length ? "added [" + migAdded.join(",") + "]" : "no-op (model,escalated already present)"}`);

// --- Project Space Phase 1, M3 migration (2026-05-26) ---
// Promote pi_bot_defs.definition.project_id (JSON field) to a real column.
// One backfill from JSON, then new code paths read/write the column directly
// (no dual-write window — see plan §M3). Same guarded-ALTER pattern as
// model/escalated above. NULL = no project linked (matches existing JSON
// semantics for legacy bots with project_id absent).
const piBotDefsMigAdded = [];
if (tableExists("pi_bot_defs")) {
  const have = db.prepare("PRAGMA table_info(pi_bot_defs)").all().map((c) => c.name);
  if (!have.includes("project_id")) {
    db.prepare("ALTER TABLE pi_bot_defs ADD COLUMN project_id INTEGER").run();
    piBotDefsMigAdded.push("project_id");
  }
  // Backfill the column from JSON for any rows where the column is NULL
  // but the JSON has a project_id. Idempotent: SET WHERE column IS NULL.
  // If a row was already migrated (column set), this is a no-op for that row.
  // If a bot was hand-edited to remove project_id from JSON, the column
  // stays at whatever it had — that's intentional (column is now authoritative).
  const backfill = db.prepare(`
    UPDATE pi_bot_defs
       SET project_id = CAST(json_extract(definition, '$.project_id') AS INTEGER)
     WHERE project_id IS NULL
       AND definition IS NOT NULL
       AND json_extract(definition, '$.project_id') IS NOT NULL
  `).run();
  if (backfill.changes > 0) piBotDefsMigAdded.push(`backfill:${backfill.changes}`);
  if (!have.includes("idx_pi_bot_defs_project")) {
    db.prepare("CREATE INDEX IF NOT EXISTS idx_pi_bot_defs_project ON pi_bot_defs(project_id)").run();
  }
}
console.log(`  pi_bot_defs migration: ${piBotDefsMigAdded.length ? "applied [" + piBotDefsMigAdded.join(",") + "]" : "no-op (project_id column + backfill already present)"}`);

const after = { pi_bot_defs: tableExists("pi_bot_defs"), bot_sessions: tableExists("bot_sessions"), bot_skill_events: tableExists("bot_skill_events") };
const cols = (t) => db.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name).join(",");

console.log(`[init-pi-bots] DB=${DB_PATH}  bot_registry=${prodBots} (production untouched)`);
console.log(`  pi_bot_defs : ${before.pi_bot_defs ? "existed" : "CREATED"}  cols=[${cols("pi_bot_defs")}]`);
console.log(`  bot_sessions: ${before.bot_sessions ? "existed" : "CREATED"}  cols=[${cols("bot_sessions")}]`);
console.log(`  bot_skill_events: ${before.bot_skill_events ? "existed" : "CREATED"}  cols=[${cols("bot_skill_events")}]`);
console.log(`  rows: pi_bot_defs=${db.prepare("SELECT count(*) c FROM pi_bot_defs").get().c}` +
            ` bot_sessions=${db.prepare("SELECT count(*) c FROM bot_sessions").get().c}`);
console.log("INIT-PI-BOTS OK");
db.close();
