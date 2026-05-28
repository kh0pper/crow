#!/usr/bin/env node
// export-bot-def.mjs — snapshot a pi_bot_defs row to bots/<bot_id>.json so the
// GUI-built bot definition (engine/models/tools/gateways/permission_policy/
// system_prompt/…) is version-controlled. `definition` is expanded to a nested
// object so prompt edits diff cleanly in git. Round-trips via import-bot-def.mjs.
//
// Usage: node scripts/export-bot-def.mjs <bot_id>
import Database from "/home/kh0pp/crow/node_modules/better-sqlite3/lib/index.js";
import { writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const DB_PATH = process.env.CROW_DB_PATH || "/home/kh0pp/.crow-mpa/data/crow.db";
const REPO = dirname(dirname(fileURLToPath(import.meta.url)));
const botId = process.argv[2];
if (!botId) { console.error("Usage: node scripts/export-bot-def.mjs <bot_id>"); process.exit(1); }

const db = new Database(DB_PATH, { readonly: true });
db.pragma("busy_timeout = 10000");
const row = db.prepare("SELECT bot_id, display_name, definition, enabled, project_id FROM pi_bot_defs WHERE bot_id = ?").get(botId);
db.close();
if (!row) { console.error(`No pi_bot_defs row for bot_id='${botId}'`); process.exit(2); }

// Expand the definition JSON for readable diffs.
let definition = row.definition;
try { definition = JSON.parse(row.definition); } catch { /* leave as string */ }

const out = {
  bot_id: row.bot_id,
  display_name: row.display_name,
  enabled: row.enabled,
  project_id: row.project_id,
  definition,
};
const dir = join(REPO, "bots");
mkdirSync(dir, { recursive: true });
const path = join(dir, `${botId}.json`);
writeFileSync(path, JSON.stringify(out, null, 2) + "\n");
console.log(`Exported ${botId} -> ${path}`);
