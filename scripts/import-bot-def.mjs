#!/usr/bin/env node
// import-bot-def.mjs — apply a version-controlled bots/<bot_id>.json snapshot
// back into pi_bot_defs (UPSERT). Inverse of export-bot-def.mjs. Re-stringifies
// the expanded `definition` object. created_at/updated_at default in-DB.
//
// Usage: node scripts/import-bot-def.mjs <bot_id> [--check]
import Database from "/home/kh0pp/crow/node_modules/better-sqlite3/lib/index.js";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DB_PATH = process.env.CROW_DB_PATH || "/home/kh0pp/.crow-mpa/data/crow.db";
const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const botId = process.argv[2];
const checkOnly = process.argv.includes("--check");
if (!botId) { console.error("Usage: node scripts/import-bot-def.mjs <bot_id> [--check]"); process.exit(1); }

const path = join(REPO, "bots", `${botId}.json`);
const data = JSON.parse(readFileSync(path, "utf8"));
const definition = typeof data.definition === "string" ? data.definition : JSON.stringify(data.definition);

if (checkOnly) {
  console.log(`Would upsert bot_id='${data.bot_id}' (definition ${definition.length} chars, enabled=${data.enabled}, project_id=${data.project_id ?? "null"}) into ${DB_PATH}`);
  process.exit(0);
}

const db = new Database(DB_PATH);
db.pragma("busy_timeout = 10000");
db.prepare(`
  INSERT INTO pi_bot_defs (bot_id, display_name, definition, enabled, project_id, updated_at)
  VALUES (@bot_id, @display_name, @definition, @enabled, @project_id, datetime('now'))
  ON CONFLICT(bot_id) DO UPDATE SET
    display_name = excluded.display_name,
    definition   = excluded.definition,
    enabled      = excluded.enabled,
    project_id   = excluded.project_id,
    updated_at   = datetime('now')
`).run({
  bot_id: data.bot_id,
  display_name: data.display_name,
  definition,
  enabled: data.enabled ?? 1,
  project_id: data.project_id ?? null,
});
db.close();
console.log(`Imported ${botId} from ${path}`);
