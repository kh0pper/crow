/**
 * Shared bot .mcp.json regeneration (M3b sessionDir rule). Used by the Bot
 * Builder's regen_mcp action and the F4a Layer 3 federation patch endpoint, so
 * both write the bot's MCP config to the exact path the bridge will run from.
 */
import { writeBotMcp } from "../../../../scripts/pi-bots/mcp_writer.mjs";
import { resolveCrowHome } from "../../../../scripts/pi-bots/ext_registry.mjs";
import { mcpConfigDelivery } from "../../../../scripts/pi-bots/mcp-delivery.mjs";
import { worldRootFor } from "../../../../scripts/pi-bots/world-root.mjs";
import { addSkillToolsGuarded } from "../../../../scripts/pi-bots/skill-tools.mjs";

/**
 * Resolve the sessionDir pi runs from — the bot's world root, by the same
 * rule the bridge uses (worldRootFor): project workspace wins, then
 * def.session_dir, then <crowHome>/pi-bots/<botId>.
 */
export async function resolveBotSessionDir(db, botId, def, projectId, crowHome = resolveCrowHome()) {
  let workspaceDir = null;
  if (projectId != null) {
    const ws = (await db.execute({
      sql: "SELECT workspace_dir FROM project_spaces WHERE id=?",
      args: [projectId],
    })).rows[0];
    workspaceDir = (ws && ws.workspace_dir) || null;
  }
  return worldRootFor({ workspaceDir, def, crowHome, botId });
}

/**
 * Regenerate the bot's .mcp.json from its current def+project. Returns
 * writeBotMcp's result WITHOUT the built config (`json` carries signed actor
 * headers and bearer tokens; callers only report path/servers/warnings).
 * S6-CROW: in fd delivery mode nothing is written — the bridge builds and
 * pipes the config per turn — so this validates the selection, removes any
 * stale on-disk copy, and returns path: null.
 */
export async function regenerateBotMcp(db, botId, opts = {}) {
  const row = (await db.execute({
    sql: "SELECT definition, project_id FROM pi_bot_defs WHERE bot_id=?",
    args: [botId],
  })).rows[0];
  if (!row) throw new Error("bot_not_found");
  const stored = JSON.parse(row.definition || "{}");
  const crowHome = resolveCrowHome();
  // the same repo-skill tool union a spawn applies (bot-world.mjs), so a
  // regenerated config matches what the bot runs with
  let def = stored;
  try { def = (await addSkillToolsGuarded(stored, { crowHome, repoSkillsDir: opts.repoSkillsDir })).def; }
  catch (e) { console.warn("[bot-mcp-regen] skill tools skipped: " + ((e && e.message) || e)); }
  const sessionDir = await resolveBotSessionDir(db, botId, def, row.project_id, crowHome);
  const r = writeBotMcp(def, { sessionDir, crowHome, write: mcpConfigDelivery() === "file" });
  const { json: _omit, ...safe } = r;
  return safe;
}
