#!/usr/bin/env node
/**
 * HISTORICAL — one-time Phase 1 (May 2026) bring-up fixture. NOT part of the
 * product install path and NOT maintained: it bakes the original operator's
 * instance paths, Gmail addresses, and a pre-Item-4 bot def
 * (spawn_env.PI_PROVIDER, non-empty gateways) that the Bot Builder no longer
 * generates (defaultDefinition ships gateways:[] and no PI_PROVIDER since
 * PR #184). Kept only as a record of the v0.1 seed data shape. Do not run on
 * a fresh install; create bots through the Bot Builder panel instead.
 *
 * Crow Bot Builder — Phase 1 setup fixture (idempotent).
 *
 * Stands up the minimal v0.1 data the bridge + GUI operate on:
 *   1. a project_spaces row in crow.db (B3b: research_projects was dropped)
 *   2. one test card in tasks.db (the LIVE kanban) scoped by project_id
 *      (cross-DB SOFT link — app-level only, NEVER a SQL join, per §4)
 *   3. the per-card plan file at <session_dir>/plans/<card_id>.md
 *   4. the seed pi_bot_def (exactly what the Phase-2 GUI form will write):
 *      one bot, local model, fixed tool allowlist, default-deny bash,
 *      Gmail gateway, external-send draft-only, one project_id.
 *
 * Card status uses ONLY the tasks_items CHECK vocab {pending,in_progress,
 * done,cancelled}. Direct INSERTs (better-sqlite3, busy_timeout only, NO
 * journal_mode pragma — memory crowdb-wal-flip-new-consumers). Re-runnable:
 * keyed on stable names/markers; never duplicates, never touches the 3
 * production MPA bots.
 *
 * Usage: node scripts/pi-bots-phase1-setup.mjs [--check]
 */
import Database from "better-sqlite3";
import { mkdirSync, writeFileSync, existsSync } from "node:fs";
import { dirname } from "node:path";

const CROW_DB = process.env.CROW_DB_PATH || "/home/kh0pp/.crow-mpa/data/crow.db";
const TASKS_DB = process.env.CROW_TASKS_DB_PATH || "/home/kh0pp/.crow-mpa/data/tasks.db";
const CHECK_ONLY = process.argv.includes("--check");

const BOT_ID = "research-scout";
const PROJECT_NAME = "Bot Builder v0.1 — Research Scout";
const SESSION_DIR = `/home/kh0pp/.crow-mpa/pi-bots/${BOT_ID}`;
const CARD_TITLE = "v0.1 demo: research a topic, summarize, reply";

function openDb(p) {
  const d = new Database(p);
  d.pragma("busy_timeout = 10000");
  return d;
}

const crow = openDb(CROW_DB);
const tasks = openDb(TASKS_DB);

// --- guards: right DBs, production intact ---
const prodBots = crow.prepare("SELECT count(*) c FROM bot_registry").get().c;
if (prodBots < 1) { console.error(`REFUSING: bot_registry=${prodBots} — wrong crow.db?`); process.exit(2); }
if (!crow.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='pi_bot_defs'").get()) {
  console.error("REFUSING: pi_bot_defs missing — run scripts/init-pi-bots.mjs first"); process.exit(2);
}

// 1. project space (idempotent by name; B3a/B3b 2026-06-12 — research_projects was retired
//    and dropped, so this seeds project_spaces)
let proj = crow.prepare("SELECT id FROM project_spaces WHERE name=?").get(PROJECT_NAME);
if (!proj && !CHECK_ONLY) {
  const info = crow.prepare(
    "INSERT INTO project_spaces (slug, name, description, type, status, tags) VALUES (?,?,?,?,?,?)"
  ).run("bot-builder-v01-demo", PROJECT_NAME, "Crow Bot Builder v0.1 thin-slice demo project.", "research", "active", "bot-builder,v0.1");
  proj = { id: info.lastInsertRowid };
}
const projectId = proj ? proj.id : null;

// 2. test card in tasks.db (idempotent by title+project_id)
let card = projectId != null
  ? tasks.prepare("SELECT id,status FROM tasks_items WHERE title=? AND project_id=?").get(CARD_TITLE, projectId)
  : null;
if (!card && projectId != null && !CHECK_ONLY) {
  const info = tasks.prepare(
    `INSERT INTO tasks_items (title, description, status, priority, phase, owner, tags, project_id)
     VALUES (?,?,?,?,?,?,?,?)`
  ).run(
    CARD_TITLE,
    "Read the plan file. Research the topic it names, write a 4-6 sentence summary, " +
      "record it in the plan file under '## Result', then reply over the gateway.",
    "pending", 3, "v0.1", "bot:research-scout", "bot-builder,v0.1", projectId
  );
  card = { id: info.lastInsertRowid, status: "pending" };
}
const cardId = card ? card.id : null;

// 3. plan file at <session_dir>/plans/<card_id>.md (idempotent — don't clobber)
const planPath = cardId != null ? `${SESSION_DIR}/plans/${cardId}.md` : null;
if (planPath && !CHECK_ONLY && !existsSync(planPath)) {
  mkdirSync(dirname(planPath), { recursive: true });
  writeFileSync(planPath,
`# Plan — card ${cardId}: ${CARD_TITLE}

**Project:** ${PROJECT_NAME} (crow.db project_spaces.id=${projectId})
**Owner bot:** ${BOT_ID}

## Goal
Research the topic below, summarize in 4–6 sentences, write the summary under
"## Result", advance this card pending → in_progress → done, then reply over
the gateway in the same thread.

## Topic
What is the Model Context Protocol (MCP) and why does a local-LLM bot use it?

## Steps
- [ ] Read this plan + the card via the tasks tools (scoped to project ${projectId})
- [ ] Research / compose the 4–6 sentence summary
- [ ] Write it under "## Result"
- [ ] tasks_update this card to in_progress, then done
- [ ] Reply over the gateway thread

## Result
_(the bot writes the summary here)_
`, "utf8");
}

// 4. seed pi_bot_def (exactly the Phase-2 GUI form's output)
const definition = {
  engine: "pi",
  models: { default: "crow-local/qwen3.6-35b-a3b" },          // S3-verified provider/model key
  tools: {
    pi_builtin: ["read", "edit", "write"],                     // default-deny bash
    crow_mcp: ["crow-tasks/tasks_list", "crow-tasks/tasks_get", "crow-tasks/tasks_update",
               "crow-tasks/tasks_complete", "crow-tasks/tasks_search"],
    pi_extensions: [], skills: [],
  },
  gateways: [{ type: "gmail", address: "kevin.hopper+pibot@maestro.press",
               allowlist: ["kevin.hopper1@gmail.com", "kevin.hopper@maestro.press"] }],
  project_id: projectId,                                       // soft link to crow.db project_spaces.id
  permission_policy: { bash: "deny",
                       write_paths: [SESSION_DIR],
                       external_send: "draft_only",
                       confirm: [] },
  triggers: { gateway: true },                                 // bridge own-timer cron added in a later phase
  system_prompt:
    "You are research-scout, a single-purpose Crow bot. You operate ONLY within " +
    "project " + projectId + "'s Kanban (the tasks_* tools, filtered by that project_id) " +
    "and your workspace " + SESSION_DIR + ". For the card you are told to do: read its " +
    "plan file, do the work, write results back into the plan file, advance the card " +
    "pending→in_progress→done via tasks_update, then reply in the same gateway thread. " +
    "Never send external email; never run bash. One card per request.",
  skills: [],
  session_dir: SESSION_DIR,
  // env the bridge MUST pass when spawning pi (WAL-flip guard, memory crowdb-wal-flip-new-consumers)
  spawn_env: { CROW_JOURNAL_MODE: "DELETE", PI_PROVIDER: "crow-local" },
};

let bot = crow.prepare("SELECT bot_id FROM pi_bot_defs WHERE bot_id=?").get(BOT_ID);
if (!CHECK_ONLY) {
  if (!bot) {
    crow.prepare("INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled) VALUES (?,?,?,1)")
      .run(BOT_ID, "Research Scout (v0.1)", JSON.stringify(definition));
  } else {
    crow.prepare("UPDATE pi_bot_defs SET definition=?, updated_at=datetime('now') WHERE bot_id=?")
      .run(JSON.stringify(definition), BOT_ID);
  }
}

// --- report ---
const finalProj = crow.prepare("SELECT id,name,status FROM project_spaces WHERE name=?").get(PROJECT_NAME);
const finalCard = projectId != null
  ? tasks.prepare("SELECT id,title,status,project_id FROM tasks_items WHERE title=? AND project_id=?").get(CARD_TITLE, projectId)
  : null;
const finalBot = crow.prepare("SELECT bot_id,display_name,enabled FROM pi_bot_defs WHERE bot_id=?").get(BOT_ID);
console.log(`[phase1-setup] ${CHECK_ONLY ? "CHECK" : "APPLY"}  bot_registry=${prodBots} (production untouched)`);
console.log(`  project_spaces: ${finalProj ? `id=${finalProj.id} "${finalProj.name}" (${finalProj.status})` : "MISSING"}`);
console.log(`  tasks_items card : ${finalCard ? `id=${finalCard.id} status=${finalCard.status} project_id=${finalCard.project_id}` : "MISSING"}`);
console.log(`  plan file        : ${planPath} ${planPath && existsSync(planPath) ? "(present)" : "(absent)"}`);
console.log(`  pi_bot_defs      : ${finalBot ? `${finalBot.bot_id} "${finalBot.display_name}" enabled=${finalBot.enabled}` : "MISSING"}`);
console.log("PHASE1-SETUP OK");
crow.close(); tasks.close();
