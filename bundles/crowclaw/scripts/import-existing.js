#!/usr/bin/env node

/**
 * CrowClaw — Import Existing Grackle Bot
 *
 * Imports the existing Grackle OpenClaw bot into the CrowClaw database:
 * 1. Bot definition from ~/.openclaw/ (non-secret fields only)
 * 2. Workspace files from ~/.openclaw/workspace/
 * 3. Skills from ~/.openclaw/skills/
 * 4. Kevin and Dayane user profiles
 *
 * Usage: node scripts/import-existing.js
 */

import { createDbClient } from "../server/db.js";
import { initCrowClawTables } from "../server/init-tables.js";
import { readFileSync, readdirSync, existsSync, statSync } from "node:fs";
import { resolve, join } from "node:path";
import { homedir } from "node:os";

const home = homedir();
const CONFIG_DIR = resolve(home, ".openclaw");
const WORKSPACE_DIR = resolve(CONFIG_DIR, "workspace");
const SKILLS_DIR = resolve(CONFIG_DIR, "skills");

async function main() {
  const db = createDbClient();
  await initCrowClawTables(db);

  // Check if bot already imported
  const existing = await db.execute({ sql: "SELECT id FROM crowclaw_bots WHERE name = 'grackle'", args: [] });
  if (existing.rows.length > 0) {
    console.log(`Grackle bot already exists (ID: ${existing.rows[0].id}). Skipping bot creation.`);
    console.log("To re-import, delete the bot first: DELETE FROM crowclaw_bots WHERE name = 'grackle'");
    return;
  }

  // 1. Import bot definition
  console.log("Importing Grackle bot definition...");
  const result = await db.execute({
    sql: `INSERT INTO crowclaw_bots
          (name, display_name, status, deploy_mode, config_dir, workspace_dir,
           service_unit, gateway_port, ai_source, primary_model, safety_policy_json)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [
      "grackle",
      "Grackle",
      "running",
      "native",
      CONFIG_DIR,
      WORKSPACE_DIR,
      "openclaw-gateway.service",
      18789,
      "custom",
      "zai/glm-5",
      JSON.stringify({
        content_moderation: { enabled: true, provider: "openai", thresholds: { hate: 0.7, violence: 0.8, "self-harm": 0.5 }, action: "block_and_log" },
        exec_security: "allowlist",
        exec_denylist: ["rm -rf", "dd", "mkfs", "curl | sh", "wget | sh"],
        rate_limits: { messages_per_minute: 10, tool_calls_per_minute: 30 },
        network: { fetch_guard: "strict", allow_bots: false, group_policy: "allowlist" },
        pii_redaction: { enabled: true, patterns: ["ssn", "credit_card", "phone"] },
      }),
    ],
  });
  const botId = Number(result.lastInsertRowid);
  console.log(`  Bot created (ID: ${botId})`);

  // Log the import as a deployment
  await db.execute({
    sql: "INSERT INTO crowclaw_deployments (bot_id, action, status, details) VALUES (?, 'import', 'completed', 'Imported existing Grackle bot')",
    args: [botId],
  });

  // 2. Import workspace files (markdown files only, skip directories)
  console.log("Importing workspace files...");
  if (existsSync(WORKSPACE_DIR)) {
    const files = readdirSync(WORKSPACE_DIR);
    let imported = 0;
    for (const file of files) {
      const filePath = join(WORKSPACE_DIR, file);
      if (!statSync(filePath).isFile()) continue;
      if (!file.endsWith(".md") && !file.endsWith(".json") && !file.endsWith(".csv")) continue;

      try {
        const content = readFileSync(filePath, "utf8");
        await db.execute({
          sql: `INSERT INTO crowclaw_workspace_files (bot_id, file_name, content, lamport_ts)
                VALUES (?, ?, ?, 1)
                ON CONFLICT(bot_id, file_name) DO UPDATE SET content = ?, lamport_ts = lamport_ts + 1`,
          args: [botId, file, content, content],
        });
        imported++;
      } catch (err) {
        console.warn(`  Warning: Could not import ${file}: ${err.message}`);
      }
    }
    console.log(`  Imported ${imported} workspace files`);
  }

  // 3. Import skills
  console.log("Importing skills...");
  if (existsSync(SKILLS_DIR)) {
    const skills = readdirSync(SKILLS_DIR);
    let imported = 0;
    for (const skill of skills) {
      const skillPath = join(SKILLS_DIR, skill);
      if (!statSync(skillPath).isDirectory()) continue;

      await db.execute({
        sql: `INSERT INTO crowclaw_skills (bot_id, skill_name, source_path, deployed_at)
              VALUES (?, ?, ?, datetime('now'))
              ON CONFLICT(bot_id, skill_name) DO UPDATE SET source_path = ?, deployed_at = datetime('now')`,
        args: [botId, skill, skillPath, skillPath],
      });
      imported++;
    }
    console.log(`  Imported ${imported} skills`);
  }

  // 4. Create user profiles
  console.log("Creating user profiles...");

  // Kevin
  await db.execute({
    sql: `INSERT INTO crowclaw_user_profiles
          (bot_id, platform, platform_user_id, display_name, language, tts_voice, timezone, persona_notes, is_owner)
          VALUES (?, 'discord', '857700998370033704', 'Kevin', 'en', 'en-US-BrianNeural', 'America/Chicago', 'Bot owner. English speaker. Software developer.', 1)`,
    args: [botId],
  });
  console.log("  Created Kevin profile (owner)");

  // Dayane
  await db.execute({
    sql: `INSERT INTO crowclaw_user_profiles
          (bot_id, platform, platform_user_id, display_name, language, tts_voice, timezone, persona_notes, is_owner)
          VALUES (?, 'discord', '1066168340629950464', 'Dayane', 'es', 'es-MX-DaliaNeural', 'America/Chicago', 'Spanish speaker. Responds in Spanish.', 0)`,
    args: [botId],
  });
  console.log("  Created Dayane profile");

  console.log("\nImport complete!");
  console.log(`Bot ID: ${botId}`);
  console.log(`Config dir: ${CONFIG_DIR}`);
  console.log(`Service: openclaw-gateway.service`);
}

main().catch(err => {
  console.error("Import failed:", err);
  process.exit(1);
});
