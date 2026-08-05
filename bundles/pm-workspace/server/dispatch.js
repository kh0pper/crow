// Day-track delegation rail: enqueue a bot_jobs row for the pi-bots runtime,
// record dispatch telemetry, and gate result pickup behind the output scan.
// Kanban cards stay with the tasks bundle; callers pass card_id in.
import { statSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { loadRules, scanText, scanFiles, redact } from "./output-scan.js";
import { loadConfig } from "./config.js";

// Rules-path resolution (finding 11): the gateway child's process env never
// carries this key; loadConfig() reads it from $CROW_HOME/env/pm-workspace.env.
// process.env is the fallback for stdio wrappers and tests.
function resolveRulesPath() {
  try { const c = loadConfig(); if (c.PM_SCAN_RULES_FILE) return c.PM_SCAN_RULES_FILE; } catch {}
  return process.env.PM_SCAN_RULES_FILE || null;
}

// Mirror of scripts/pi-bots/bot-jobs-schema.mjs (the bundle cannot import
// across the repo boundary at runtime; keep in sync with that file).
const BOT_JOBS_DDL = `
  CREATE TABLE IF NOT EXISTS bot_jobs (
    job_id TEXT PRIMARY KEY, bot_id TEXT NOT NULL, goal TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'queued', deliver_to TEXT, source TEXT,
    schedule_id INTEGER, escalate INTEGER NOT NULL DEFAULT 0,
    attempts INTEGER NOT NULL DEFAULT 0, result TEXT, error TEXT,
    pi_session_id TEXT, tool_calls INTEGER, worker_pid INTEGER, claimed_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now')), started_at TEXT, ended_at TEXT
  )`;

// Keep in sync with the identical DDL string in init-tables.js.
const DISPATCH_DDL = `
  CREATE TABLE IF NOT EXISTS pm_bot_dispatches (
    dispatch_id INTEGER PRIMARY KEY AUTOINCREMENT,
    job_id TEXT NOT NULL UNIQUE,
    bot_id TEXT NOT NULL,
    duty TEXT NOT NULL,
    card_id INTEGER,
    model TEXT,
    verdict TEXT,
    scan_status TEXT,
    disposition TEXT,
    boundary_violation INTEGER NOT NULL DEFAULT 0,
    disposition_notes TEXT,
    dispatched_at TEXT NOT NULL DEFAULT (datetime('now')),
    disposition_at TEXT
  )`;

export async function ensureDispatchTables(db) {
  await db.execute(BOT_JOBS_DDL);
  await db.execute(DISPATCH_DDL);
}

function generateJobId() {
  return "job-" + Date.now().toString(36) + "-" + Math.random().toString(36).slice(2, 8);
}

function composeGoal({ dispatchTag, duty, goal, card_id }) {
  return [
    `DISPATCH ${dispatchTag} — duty: ${duty}` + (card_id ? ` — card #${card_id}` : ""),
    goal,
    "",
    "Deliverable contract:",
    "- Write your draft(s) under your session workspace outbox directory as NEW files",
    "  (never edit an existing shared file).",
    "- End your reply with one line per draft file: DRAFT_FILE: <absolute path>",
    "- Then a short self-contained summary of what you produced.",
  ].join("\n");
}

export async function dispatch(db, { bot_id, duty, goal, card_id = null, deliver = null }) {
  await ensureDispatchTables(db);
  const bot = (await db.execute({
    sql: "SELECT bot_id, definition FROM pi_bot_defs WHERE bot_id=? AND enabled=1", args: [bot_id],
  })).rows[0];
  if (!bot) throw new Error(`unknown or disabled bot: ${bot_id}`);
  let model = null;
  try { model = JSON.parse(bot.definition).models?.default || null; } catch {}
  const job_id = generateJobId();
  const deliver_to = deliver == null ? JSON.stringify({ kind: "poll" })
    : (typeof deliver === "string" ? deliver : JSON.stringify(deliver));
  const fullGoal = composeGoal({ dispatchTag: job_id, duty, goal, card_id });
  await db.execute({
    sql: "INSERT INTO bot_jobs (job_id, bot_id, goal, status, deliver_to, source) VALUES (?,?,?,'queued',?,?)",
    args: [job_id, bot_id, fullGoal, deliver_to, "chat"],
  });
  await db.execute({
    sql: "INSERT INTO pm_bot_dispatches (job_id, bot_id, duty, card_id, model) VALUES (?,?,?,?,?)",
    args: [job_id, bot_id, duty, card_id, model],
  });
  const dispatch_id = (await db.execute({
    sql: "SELECT dispatch_id FROM pm_bot_dispatches WHERE job_id=?", args: [job_id],
  })).rows[0].dispatch_id;
  return { job_id, dispatch_id };
}

function workspaceFilesSince(bot_id, startedAt) {
  const home = process.env.CROW_HOME || join(process.env.HOME || "", ".crow");
  const dir = join(home, "pi-bots", bot_id);
  const cutoff = Date.parse(String(startedAt).endsWith("Z") ? startedAt : startedAt + "Z");
  const out = [];
  const walk = (d) => {
    let entries = [];
    try { entries = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else { try { if (statSync(p).mtimeMs >= cutoff) out.push(p); } catch {} }
    }
  };
  if (!Number.isNaN(cutoff)) walk(dir);
  return out;
}

export async function result(db, { job_id }) {
  await ensureDispatchTables(db);
  const job = (await db.execute({ sql: "SELECT * FROM bot_jobs WHERE job_id=?", args: [job_id] })).rows[0];
  if (!job) throw new Error(`no such job: ${job_id}`);
  const rulesPath = resolveRulesPath();
  if (job.status !== "completed") {
    // Failed-job error text is bot output too (Safety measure 8) — scan it.
    let err = job.error || null;
    if (err && rulesPath) {
      const rules = loadRules(rulesPath);
      const f = scanText(err, rules);
      if (f.length) err = redact(err, f);
    }
    return { job_id, status: job.status, error: err };
  }
  if (!rulesPath) {
    await db.execute({ sql: "UPDATE pm_bot_dispatches SET scan_status='skipped' WHERE job_id=?", args: [job_id] });
    return { job_id, status: "completed", scan_status: "skipped", result: job.result, files: [] };
  }
  const rules = loadRules(rulesPath); // throws if set but unloadable: fail closed
  const textFindings = scanText(job.result || "", rules);
  const files = job.started_at ? workspaceFilesSince(job.bot_id, job.started_at) : [];
  const fileFindings = scanFiles(files, rules);
  const fileHits = Object.entries(fileFindings).filter(([, f]) => f.length > 0);
  const scan_status = textFindings.length || fileHits.length ? "findings" : "pass";
  await db.execute({ sql: "UPDATE pm_bot_dispatches SET scan_status=? WHERE job_id=?", args: [scan_status, job_id] });
  return {
    job_id, status: "completed", scan_status,
    result: scan_status === "pass" ? job.result : redact(job.result || "", textFindings),
    findings: { text: textFindings, files: Object.fromEntries(fileHits.map(([p, f]) => [p, f.map(x => x.name)])) },
    files,
  };
}

export async function disposition(db, { job_id, disposition: d, boundary_violation = false, notes = null }) {
  await ensureDispatchTables(db);
  if (!["accepted", "edited", "rejected"].includes(d)) throw new Error(`bad disposition: ${d}`);
  const r = await db.execute({
    sql: "UPDATE pm_bot_dispatches SET disposition=?, boundary_violation=?, disposition_notes=?, disposition_at=datetime('now') WHERE job_id=?",
    args: [d, boundary_violation ? 1 : 0, notes, job_id],
  });
  if (!r.rowsAffected) throw new Error(`no dispatch row for job: ${job_id}`);
  return { job_id, disposition: d };
}

export async function telemetry(db, { since = null }) {
  await ensureDispatchTables(db);
  // dispatched_at is sqlite datetime('now') format (space-separated, no
  // milliseconds, no Z); normalize caller ISO so comparison is lexicographic.
  const norm = since ? String(since).replace("T", " ").replace(/(\.\d+)?Z?$/, "") : null;
  const where = norm ? "WHERE dispatched_at >= ?" : "";
  const args = norm ? [norm] : [];
  const rows = (await db.execute({
    sql: `SELECT bot_id, disposition, boundary_violation FROM pm_bot_dispatches ${where}`, args,
  })).rows;
  const summarize = (subset) => {
    const decided = subset.filter((r) => r.disposition);
    const accepted = decided.filter((r) => r.disposition === "accepted").length;
    return {
      dispatched: subset.length,
      decided: decided.length,
      accepted,
      edited: decided.filter((r) => r.disposition === "edited").length,
      rejected: decided.filter((r) => r.disposition === "rejected").length,
      boundary_violations: subset.filter((r) => r.boundary_violation).length,
      accept_rate: decided.length ? accepted / decided.length : null,
    };
  };
  // Per-bot breakdown: the Gemma bake-off adds a second drafter into this
  // table, and surface flips cite these rows per bot (design Trust measurement).
  const per_bot = {};
  for (const r of rows) (per_bot[r.bot_id] ||= []).push(r);
  return {
    ...summarize(rows),
    per_bot: Object.fromEntries(Object.entries(per_bot).map(([b, rs]) => [b, summarize(rs)])),
  };
}
