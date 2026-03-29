/**
 * CrowClaw — Workspace File Manager
 *
 * CRUD for bot workspace files (SOUL.md, USER.md, AGENTS.md, etc.)
 * Source of truth is the DB; files are rendered to disk on update.
 */

import { writeFileSync, existsSync, readdirSync } from "node:fs";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import { dirname } from "node:path";
import { getBot } from "./bot-manager.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const TEMPLATES_DIR = resolve(__dirname, "..", "templates", "workspace");

/**
 * List available workspace templates.
 */
export function listTemplates() {
  if (!existsSync(TEMPLATES_DIR)) return [];
  return readdirSync(TEMPLATES_DIR).filter(f => f.endsWith(".md") || f.endsWith(".json"));
}

/**
 * Get a workspace file's content (from DB).
 */
export async function getWorkspaceFile(db, botId, fileName) {
  const { rows } = await db.execute({
    sql: "SELECT content FROM crowclaw_workspace_files WHERE bot_id = ? AND file_name = ?",
    args: [botId, fileName],
  });
  return rows[0]?.content || null;
}

/**
 * Update a workspace file (DB + disk).
 */
export async function updateWorkspaceFile(db, { botId, fileName, content }) {
  const bot = await getBot(db, botId);
  if (!bot) throw new Error(`Bot ID ${botId} not found`);

  await db.execute({
    sql: `INSERT INTO crowclaw_workspace_files (bot_id, file_name, content, lamport_ts)
          VALUES (?, ?, ?, 1)
          ON CONFLICT(bot_id, file_name) DO UPDATE SET content = ?, lamport_ts = lamport_ts + 1`,
    args: [botId, fileName, content, content],
  });

  // Render to disk
  if (bot.workspace_dir && existsSync(bot.workspace_dir)) {
    writeFileSync(resolve(bot.workspace_dir, fileName), content);
  }

  return { updated: true, fileName, botId };
}

/**
 * List workspace files for a bot.
 */
export async function listWorkspaceFiles(db, botId) {
  const { rows } = await db.execute({
    sql: "SELECT file_name, is_template, lamport_ts FROM crowclaw_workspace_files WHERE bot_id = ? ORDER BY file_name",
    args: [botId],
  });
  return rows;
}

/**
 * List deployed skills for a bot.
 */
export async function listBotSkills(db, botId) {
  const { rows } = await db.execute({
    sql: "SELECT * FROM crowclaw_skills WHERE bot_id = ? ORDER BY skill_name",
    args: [botId],
  });
  return rows;
}

/**
 * Deploy a skill to a bot — copy from source, register in DB.
 */
export async function deploySkill(db, { botId, skillName, sourcePath }) {
  const bot = await getBot(db, botId);
  if (!bot) throw new Error(`Bot ID ${botId} not found`);

  if (!existsSync(sourcePath)) {
    throw new Error(`Skill source not found: ${sourcePath}`);
  }

  // Copy skill to bot's skills directory
  const skillsDir = resolve(bot.config_dir, "skills");
  if (!existsSync(skillsDir)) {
    const { mkdirSync } = await import("node:fs");
    mkdirSync(skillsDir, { recursive: true });
  }

  const { cpSync } = await import("node:fs");
  const destPath = resolve(skillsDir, skillName);
  cpSync(sourcePath, destPath, { recursive: true });

  await db.execute({
    sql: `INSERT INTO crowclaw_skills (bot_id, skill_name, source_path, deployed_at)
          VALUES (?, ?, ?, datetime('now'))
          ON CONFLICT(bot_id, skill_name) DO UPDATE SET source_path = ?, deployed_at = datetime('now')`,
    args: [botId, skillName, sourcePath, sourcePath],
  });

  return { deployed: true, skillName, destPath };
}

/**
 * Remove a skill from a bot.
 */
export async function removeSkill(db, { botId, skillName }) {
  const bot = await getBot(db, botId);
  if (!bot) throw new Error(`Bot ID ${botId} not found`);

  // Remove from disk
  const skillPath = resolve(bot.config_dir, "skills", skillName);
  if (existsSync(skillPath)) {
    const { rmSync } = await import("node:fs");
    rmSync(skillPath, { recursive: true });
  }

  await db.execute({
    sql: "DELETE FROM crowclaw_skills WHERE bot_id = ? AND skill_name = ?",
    args: [botId, skillName],
  });

  return { removed: true, skillName };
}
