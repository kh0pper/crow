/**
 * CrowClaw — User Profile Manager
 *
 * Manages per-user profiles for OpenClaw bots.
 * Generates VOICE_LANGMAP and USER-PROFILES.md on changes.
 */

import { writeFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { getBot } from "./bot-manager.js";

/**
 * Create a user profile for a bot.
 */
export async function createProfile(db, {
  botId, platform, platformUserId, displayName,
  language, ttsVoice, timezone, personaNotes, isOwner,
}) {
  const bot = await getBot(db, botId);
  if (!bot) throw new Error(`Bot ID ${botId} not found`);

  const result = await db.execute({
    sql: `INSERT INTO crowclaw_user_profiles
          (bot_id, platform, platform_user_id, display_name, language, tts_voice, timezone, persona_notes, is_owner)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    args: [botId, platform, platformUserId, displayName, language || "en", ttsVoice, timezone, personaNotes, isOwner ? 1 : 0],
  });

  await regenerateArtifacts(db, bot);

  return { id: Number(result.lastInsertRowid), botId, platform, platformUserId, displayName };
}

/**
 * Update an existing profile.
 */
export async function updateProfile(db, { profileId, ...updates }) {
  const profile = await db.execute({ sql: "SELECT * FROM crowclaw_user_profiles WHERE id = ?", args: [profileId] });
  if (!profile.rows[0]) throw new Error(`Profile ID ${profileId} not found`);
  const existing = profile.rows[0];

  const fields = [];
  const args = [];
  for (const [key, value] of Object.entries(updates)) {
    if (value !== undefined) {
      // Convert camelCase to snake_case
      const col = key.replace(/[A-Z]/g, m => `_${m.toLowerCase()}`);
      fields.push(`${col} = ?`);
      args.push(value);
    }
  }

  if (fields.length === 0) return { updated: false, reason: "No fields to update" };

  fields.push("lamport_ts = lamport_ts + 1");
  args.push(profileId);

  await db.execute({
    sql: `UPDATE crowclaw_user_profiles SET ${fields.join(", ")} WHERE id = ?`,
    args,
  });

  const bot = await getBot(db, existing.bot_id);
  if (bot) await regenerateArtifacts(db, bot);

  return { updated: true, profileId };
}

/**
 * List profiles for a bot.
 */
export async function listProfiles(db, botId) {
  const { rows } = await db.execute({
    sql: "SELECT * FROM crowclaw_user_profiles WHERE bot_id = ? ORDER BY is_owner DESC, display_name",
    args: [botId],
  });
  return rows;
}

/**
 * Delete a profile.
 */
export async function deleteProfile(db, profileId) {
  const profile = await db.execute({ sql: "SELECT * FROM crowclaw_user_profiles WHERE id = ?", args: [profileId] });
  if (!profile.rows[0]) throw new Error(`Profile ID ${profileId} not found`);
  const existing = profile.rows[0];

  await db.execute({ sql: "DELETE FROM crowclaw_user_profiles WHERE id = ?", args: [profileId] });

  const bot = await getBot(db, existing.bot_id);
  if (bot) await regenerateArtifacts(db, bot);

  return { deleted: true, displayName: existing.display_name };
}

/**
 * Regenerate VOICE_LANGMAP and USER-PROFILES.md after profile changes.
 */
async function regenerateArtifacts(db, bot) {
  const profiles = await listProfiles(db, bot.id);

  // Build VOICE_LANGMAP
  const langMap = {};
  for (const p of profiles) {
    if (p.language && p.tts_voice) {
      langMap[p.language] = p.tts_voice;
    }
  }

  // Generate USER-PROFILES.md
  const lines = ["# User Profiles\n"];
  for (const p of profiles) {
    lines.push(`## ${p.display_name || p.platform_user_id}`);
    lines.push(`- **Platform:** ${p.platform}`);
    lines.push(`- **User ID:** ${p.platform_user_id}`);
    lines.push(`- **Language:** ${p.language || "en"}`);
    lines.push(`- **TTS Voice:** ${p.tts_voice || "default"}`);
    lines.push(`- **Timezone:** ${p.timezone || "UTC"}`);
    if (p.persona_notes) lines.push(`- **Notes:** ${p.persona_notes}`);
    if (p.is_owner) lines.push(`- **Role:** Owner`);
    lines.push("");
  }

  const profilesMd = lines.join("\n");

  // Write to workspace dir if it exists
  if (bot.workspace_dir && existsSync(bot.workspace_dir)) {
    writeFileSync(resolve(bot.workspace_dir, "USER-PROFILES.md"), profilesMd);
  }

  // Store in DB
  await db.execute({
    sql: `INSERT INTO crowclaw_workspace_files (bot_id, file_name, content, lamport_ts)
          VALUES (?, 'USER-PROFILES.md', ?, 1)
          ON CONFLICT(bot_id, file_name) DO UPDATE SET content = ?, lamport_ts = lamport_ts + 1`,
    args: [bot.id, profilesMd, profilesMd],
  });

  return { voiceLangMap: langMap, profilesMd };
}
