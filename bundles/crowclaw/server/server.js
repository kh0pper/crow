/**
 * CrowClaw MCP Server
 *
 * OpenClaw bot management: create, configure, deploy, monitor bots.
 * 20 MCP tools organized into Bot Lifecycle, Monitoring, User Profiles,
 * and Workspace & Skills groups.
 *
 * Factory function: createCrowClawServer(dbPath?, options?)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { createDbClient } from "./db.js";
import { generateToken, validateToken, shouldSkipGates } from "./confirm.js";
import {
  createBot, configureBot, deployBot, startBot, stopBot, restartBot, deleteBot,
  getBotStatus, getBotLogs, getBotHealth, getBot,
} from "./bot-manager.js";
import {
  createProfile, updateProfile, listProfiles, deleteProfile,
} from "./profile-manager.js";
import {
  listTemplates, updateWorkspaceFile, getWorkspaceFile, listWorkspaceFiles,
  listBotSkills, deploySkill, removeSkill,
} from "./workspace-manager.js";
import { logSafetyEvent, getSafetyEvents } from "./safety-manager.js";

export function createCrowClawServer(dbPath, options = {}) {
  const server = new McpServer(
    { name: "crow-crowclaw", version: "1.0.0" },
    options.instructions ? { instructions: options.instructions } : undefined
  );

  const db = createDbClient(dbPath);

  // ===================================================================
  // Bot Lifecycle (7 tools)
  // ===================================================================

  // --- crow_create_bot ---
  server.tool(
    "crow_create_bot",
    "Create a new OpenClaw bot definition.",
    {
      name: z.string().min(1).max(50).describe("Unique bot name (lowercase, no spaces — used in service name)"),
      display_name: z.string().max(100).optional().describe("Human-friendly display name"),
      deploy_mode: z.enum(["native", "docker"]).optional().describe("Deploy as systemd service or Docker (default: native)"),
      language: z.string().max(10).optional().describe("Primary language code (e.g., 'en', 'es')"),
      gateway_port: z.number().int().min(1024).max(65535).optional().describe("Gateway HTTP port (default: 18789)"),
      ai_source: z.enum(["custom", "byoai"]).optional().describe("AI source: 'byoai' uses Crow AI profiles (default), 'custom' for manual config"),
    },
    async ({ name, display_name, deploy_mode, language, gateway_port, ai_source }) => {
      try {
        const result = await createBot(db, {
          name, displayName: display_name, deployMode: deploy_mode,
          language, gatewayPort: gateway_port, aiSource: ai_source,
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // --- crow_configure_bot ---
  server.tool(
    "crow_configure_bot",
    "Update a bot's openclaw.json config by dot-path. Warns on security downgrades.",
    {
      bot_id: z.number().int().describe("Bot ID"),
      path: z.string().describe("Dot-separated config path (e.g., 'discord.allowFrom')"),
      value: z.any().describe("New value to set"),
    },
    async ({ bot_id, path, value }) => {
      try {
        const result = await configureBot(db, { botId: bot_id, path, value });
        let text = `Updated ${path}: ${JSON.stringify(result.oldValue)} -> ${JSON.stringify(result.newValue)}`;
        if (result.securityWarning) text += `\n\nWARNING: ${result.securityWarning}`;
        return { content: [{ type: "text", text }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // --- crow_deploy_bot ---
  server.tool(
    "crow_deploy_bot",
    "Deploy a bot's config to disk — creates directories, writes systemd unit, runs security audit. Requires confirmation.",
    {
      bot_id: z.number().int().describe("Bot ID"),
      discord_token: z.string().optional().describe("Discord bot token (only needed for first deploy)"),
      confirm_token: z.string().optional().describe("Confirmation token from preview call"),
    },
    async ({ bot_id, discord_token, confirm_token }) => {
      try {
        const bot = await getBot(db, bot_id);
        if (!bot) return { content: [{ type: "text", text: `Bot ID ${bot_id} not found` }], isError: true };

        // Confirm gate
        if (!shouldSkipGates() && !confirm_token) {
          const token = generateToken("deploy", bot_id);
          return {
            content: [{
              type: "text",
              text: `Deploy bot "${bot.name}" to ${bot.config_dir}?\nThis will create/overwrite config files and systemd unit.\n\nCall again with confirm_token: "${token}" to proceed.`,
            }],
          };
        }
        if (confirm_token && !shouldSkipGates()) {
          if (!validateToken(confirm_token, "deploy", bot_id)) {
            return { content: [{ type: "text", text: "Invalid or expired confirmation token." }], isError: true };
          }
        }

        const result = await deployBot(db, { botId: bot_id, discordToken: discord_token });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // --- crow_start_bot ---
  server.tool(
    "crow_start_bot",
    "Start a bot's systemd service.",
    { bot_id: z.number().int().describe("Bot ID") },
    async ({ bot_id }) => {
      try {
        const result = await startBot(db, bot_id);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // --- crow_stop_bot ---
  server.tool(
    "crow_stop_bot",
    "Stop a bot's systemd service.",
    { bot_id: z.number().int().describe("Bot ID") },
    async ({ bot_id }) => {
      try {
        const result = await stopBot(db, bot_id);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // --- crow_restart_bot ---
  server.tool(
    "crow_restart_bot",
    "Restart a bot's systemd service.",
    { bot_id: z.number().int().describe("Bot ID") },
    async ({ bot_id }) => {
      try {
        const result = await restartBot(db, bot_id);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // --- crow_delete_bot ---
  server.tool(
    "crow_delete_bot",
    "Delete a bot — stops service, archives config, removes from DB. Requires confirmation.",
    {
      bot_id: z.number().int().describe("Bot ID"),
      confirm_token: z.string().optional().describe("Confirmation token from preview call"),
    },
    async ({ bot_id, confirm_token }) => {
      try {
        const bot = await getBot(db, bot_id);
        if (!bot) return { content: [{ type: "text", text: `Bot ID ${bot_id} not found` }], isError: true };

        if (!shouldSkipGates() && !confirm_token) {
          const token = generateToken("delete", bot_id);
          return {
            content: [{
              type: "text",
              text: `DELETE bot "${bot.name}"? This will stop the service, archive config to ${bot.config_dir}-archive-*.tar.gz, and remove from DB.\n\nCall again with confirm_token: "${token}" to proceed.`,
            }],
          };
        }
        if (confirm_token && !shouldSkipGates()) {
          if (!validateToken(confirm_token, "delete", bot_id)) {
            return { content: [{ type: "text", text: "Invalid or expired confirmation token." }], isError: true };
          }
        }

        const result = await deleteBot(db, bot_id);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ===================================================================
  // Monitoring (3 tools)
  // ===================================================================

  // --- crow_bot_status ---
  server.tool(
    "crow_bot_status",
    "Get bot status, uptime, memory, connected platforms. Returns all bots if no bot_id.",
    { bot_id: z.number().int().optional().describe("Bot ID (omit for all bots)") },
    async ({ bot_id }) => {
      try {
        const result = await getBotStatus(db, bot_id);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // --- crow_bot_logs ---
  server.tool(
    "crow_bot_logs",
    "Tail journalctl logs for a bot.",
    {
      bot_id: z.number().int().describe("Bot ID"),
      lines: z.number().int().min(1).max(500).optional().describe("Number of lines (default: 50)"),
      since: z.string().optional().describe("Journalctl --since value (e.g., '1 hour ago')"),
    },
    async ({ bot_id, lines, since }) => {
      try {
        const logs = await getBotLogs(db, bot_id, { lines, since });
        return { content: [{ type: "text", text: logs }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // --- crow_bot_health ---
  server.tool(
    "crow_bot_health",
    "Deep health check: HTTP endpoint, systemd service state, Discord connection.",
    { bot_id: z.number().int().describe("Bot ID") },
    async ({ bot_id }) => {
      try {
        const result = await getBotHealth(db, bot_id);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ===================================================================
  // User Profiles (4 tools)
  // ===================================================================

  // --- crow_create_user_profile ---
  server.tool(
    "crow_create_user_profile",
    "Register a user profile for a bot (platform, language, voice, timezone, persona).",
    {
      bot_id: z.number().int().describe("Bot ID"),
      platform: z.string().describe("Platform (e.g., 'discord', 'telegram')"),
      platform_user_id: z.string().describe("User's platform ID"),
      display_name: z.string().optional().describe("Display name"),
      language: z.string().max(10).optional().describe("Language code (default: 'en')"),
      tts_voice: z.string().optional().describe("TTS voice name (e.g., 'en-US-BrianNeural')"),
      timezone: z.string().optional().describe("Timezone (e.g., 'America/Chicago')"),
      persona_notes: z.string().optional().describe("Notes about this user for persona adaptation"),
      is_owner: z.boolean().optional().describe("Whether this user is the bot owner"),
    },
    async ({ bot_id, platform, platform_user_id, display_name, language, tts_voice, timezone, persona_notes, is_owner }) => {
      try {
        const result = await createProfile(db, {
          botId: bot_id, platform, platformUserId: platform_user_id,
          displayName: display_name, language, ttsVoice: tts_voice,
          timezone, personaNotes: persona_notes, isOwner: is_owner,
        });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // --- crow_update_user_profile ---
  server.tool(
    "crow_update_user_profile",
    "Update user profile; regenerates VOICE_LANGMAP and USER-PROFILES.md.",
    {
      profile_id: z.number().int().describe("Profile ID"),
      display_name: z.string().optional(),
      language: z.string().max(10).optional(),
      tts_voice: z.string().optional(),
      timezone: z.string().optional(),
      persona_notes: z.string().optional(),
      is_owner: z.boolean().optional(),
    },
    async ({ profile_id, ...updates }) => {
      try {
        const result = await updateProfile(db, { profileId: profile_id, displayName: updates.display_name, language: updates.language, ttsVoice: updates.tts_voice, timezone: updates.timezone, personaNotes: updates.persona_notes, isOwner: updates.is_owner ? 1 : 0 });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // --- crow_list_user_profiles ---
  server.tool(
    "crow_list_user_profiles",
    "List user profiles for a bot.",
    { bot_id: z.number().int().describe("Bot ID") },
    async ({ bot_id }) => {
      try {
        const profiles = await listProfiles(db, bot_id);
        return { content: [{ type: "text", text: JSON.stringify(profiles, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // --- crow_delete_user_profile ---
  server.tool(
    "crow_delete_user_profile",
    "Remove a user profile. Requires confirmation.",
    {
      profile_id: z.number().int().describe("Profile ID"),
      confirm_token: z.string().optional().describe("Confirmation token from preview call"),
    },
    async ({ profile_id, confirm_token }) => {
      try {
        if (!shouldSkipGates() && !confirm_token) {
          const token = generateToken("delete_profile", profile_id);
          return {
            content: [{
              type: "text",
              text: `Delete user profile ${profile_id}? This will regenerate VOICE_LANGMAP and USER-PROFILES.md.\n\nCall again with confirm_token: "${token}" to proceed.`,
            }],
          };
        }
        if (confirm_token && !shouldSkipGates()) {
          if (!validateToken(confirm_token, "delete_profile", profile_id)) {
            return { content: [{ type: "text", text: "Invalid or expired confirmation token." }], isError: true };
          }
        }

        const result = await deleteProfile(db, profile_id);
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // ===================================================================
  // Workspace & Skills (6 tools)
  // ===================================================================

  // --- crow_list_workspace_templates ---
  server.tool(
    "crow_list_workspace_templates",
    "List available workspace file templates.",
    {},
    async () => {
      try {
        const templates = listTemplates();
        return { content: [{ type: "text", text: JSON.stringify(templates, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // --- crow_update_workspace_file ---
  server.tool(
    "crow_update_workspace_file",
    "Write or update a workspace file (stored in DB, rendered to disk).",
    {
      bot_id: z.number().int().describe("Bot ID"),
      file_name: z.string().describe("File name (e.g., 'SOUL.md', 'USER.md')"),
      content: z.string().describe("File content"),
    },
    async ({ bot_id, file_name, content }) => {
      try {
        const result = await updateWorkspaceFile(db, { botId: bot_id, fileName: file_name, content });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // --- crow_get_workspace_file ---
  server.tool(
    "crow_get_workspace_file",
    "Read a workspace file's content.",
    {
      bot_id: z.number().int().describe("Bot ID"),
      file_name: z.string().describe("File name"),
    },
    async ({ bot_id, file_name }) => {
      try {
        const content = await getWorkspaceFile(db, bot_id, file_name);
        if (content === null) {
          return { content: [{ type: "text", text: `File "${file_name}" not found for bot ${bot_id}` }], isError: true };
        }
        return { content: [{ type: "text", text: content }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // --- crow_list_bot_skills ---
  server.tool(
    "crow_list_bot_skills",
    "List skills deployed to a bot.",
    { bot_id: z.number().int().describe("Bot ID") },
    async ({ bot_id }) => {
      try {
        const skills = await listBotSkills(db, bot_id);
        return { content: [{ type: "text", text: JSON.stringify(skills, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // --- crow_deploy_skill ---
  server.tool(
    "crow_deploy_skill",
    "Deploy a skill to a bot from a source path (e.g., ~/casa-nueva/skills/*).",
    {
      bot_id: z.number().int().describe("Bot ID"),
      skill_name: z.string().describe("Skill name (directory name)"),
      source_path: z.string().describe("Absolute path to skill source"),
    },
    async ({ bot_id, skill_name, source_path }) => {
      try {
        const result = await deploySkill(db, { botId: bot_id, skillName: skill_name, sourcePath: source_path });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  // --- crow_remove_skill ---
  server.tool(
    "crow_remove_skill",
    "Remove a skill from a bot. Requires confirmation.",
    {
      bot_id: z.number().int().describe("Bot ID"),
      skill_name: z.string().describe("Skill name to remove"),
      confirm_token: z.string().optional().describe("Confirmation token from preview call"),
    },
    async ({ bot_id, skill_name, confirm_token }) => {
      try {
        if (!shouldSkipGates() && !confirm_token) {
          const token = generateToken("remove_skill", `${bot_id}:${skill_name}`);
          return {
            content: [{
              type: "text",
              text: `Remove skill "${skill_name}" from bot ${bot_id}? This deletes the skill files from the bot's config directory.\n\nCall again with confirm_token: "${token}" to proceed.`,
            }],
          };
        }
        if (confirm_token && !shouldSkipGates()) {
          if (!validateToken(confirm_token, "remove_skill", `${bot_id}:${skill_name}`)) {
            return { content: [{ type: "text", text: "Invalid or expired confirmation token." }], isError: true };
          }
        }

        const result = await removeSkill(db, { botId: bot_id, skillName: skill_name });
        return { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] };
      } catch (err) {
        return { content: [{ type: "text", text: `Error: ${err.message}` }], isError: true };
      }
    }
  );

  return server;
}
