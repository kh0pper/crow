#!/usr/bin/env node
/**
 * Crow Bot Builder — skill provenance + audit (self-learning, plan §B5).
 *
 * Thin accessors over the bot_skill_events table (DDL in scripts/init-pi-bots.mjs).
 * This table is the SOURCE OF TRUTH for "which bot authored which skill", which
 * gates auto-mode patching (a bot may only patch a skill it created), AND the
 * guaranteed audit sink that works even for NULL-project bots (where the project
 * audit_log helper no-ops).
 *
 * Connection convention mirrors appendAuditBridge in bridge.mjs: each call opens
 * a short-lived better-sqlite3 connection with busy_timeout only (NO journal_mode
 * pragma — crow.db stays in DELETE; a stray WAL flip is the documented
 * SQLITE_BUSY trap). recordSkillEvent is best-effort and never throws (an audit
 * write must never break a turn); read helpers fail closed (return [] / false / 0).
 */
import Database from "better-sqlite3";
import { botsDbPath } from "./instance-paths.mjs";

const HOME = "/home/kh0pp";
const CROW_DB = botsDbPath();

function db() { const d = new Database(CROW_DB); d.pragma("busy_timeout = 10000"); return d; }

/** Author/audit a skill event. action ∈ propose|create|patch|reject|downgrade.
 *  Best-effort: any failure is swallowed (never breaks the caller's turn). */
export function recordSkillEvent(ev) {
  try {
    const c = db();
    c.prepare(
      `INSERT INTO bot_skill_events (bot_id, skill_name, action, mode, model, flags_json)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).run(
      String(ev.bot_id),
      String(ev.skill_name),
      String(ev.action),
      ev.mode == null ? null : String(ev.mode),
      ev.model == null ? null : String(ev.model),
      ev.flags == null ? null : (typeof ev.flags === "string" ? ev.flags : JSON.stringify(ev.flags))
    );
    c.close();
    return true;
  } catch {
    return false; // never throw — this is an audit sink
  }
}

/** True iff this bot AUTO-authored the named skill — the eligibility check for
 *  an auto-mode in-place patch. Requires action='create' AND mode='auto': an
 *  operator-approved skill (mode='operator') confers NO auto-patch rights (plan
 *  §B2.3 — auto may patch only what it itself auto-authored, never operator- or
 *  repo-authored skills). Fail-closed (false on error) so an auto patch is
 *  refused if provenance can't be confirmed. */
export function botAuthoredSkill(bot_id, skill_name) {
  try {
    const c = db();
    const row = c.prepare(
      `SELECT 1 FROM bot_skill_events
        WHERE bot_id=? AND skill_name=? AND action='create' AND mode='auto' LIMIT 1`
    ).get(String(bot_id), String(skill_name));
    c.close();
    return !!row;
  } catch {
    return false;
  }
}

/** Number of DISTINCT skills this bot has CREATED (for the B3 per-bot cap). */
export function countAuthoredSkills(bot_id) {
  try {
    const c = db();
    const row = c.prepare(
      `SELECT count(DISTINCT skill_name) n FROM bot_skill_events
        WHERE bot_id=? AND action='create'`
    ).get(String(bot_id));
    c.close();
    return row ? Number(row.n) : 0;
  } catch {
    return 0;
  }
}

/** Recent events for a bot — the operator "what did my bot write?" feed. */
export function listBotSkillEvents(bot_id, limit = 50) {
  try {
    const c = db();
    const rows = c.prepare(
      `SELECT id, skill_name, action, mode, model, flags_json, created_at
         FROM bot_skill_events WHERE bot_id=?
        ORDER BY id DESC LIMIT ?`
    ).all(String(bot_id), Math.max(1, Math.min(500, Number(limit) || 50)));
    c.close();
    return rows;
  } catch {
    return [];
  }
}

// CLI (offline checks): record/authored/count/list
if (import.meta.url === "file://" + process.argv[1]) {
  const [cmd, a, b] = process.argv.slice(2);
  if (cmd === "authored") { console.log(botAuthoredSkill(a, b)); process.exit(0); }
  if (cmd === "count") { console.log(countAuthoredSkills(a)); process.exit(0); }
  if (cmd === "list") { console.log(JSON.stringify(listBotSkillEvents(a, b), null, 2)); process.exit(0); }
  console.error("usage: skill_provenance.mjs authored <bot> <skill> | count <bot> | list <bot> [limit]");
  process.exit(1);
}
