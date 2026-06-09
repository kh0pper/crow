/**
 * Shared bot .mcp.json regeneration (M3b sessionDir rule). Used by the Bot
 * Builder's regen_mcp action and the F4a Layer 3 federation patch endpoint, so
 * both write the bot's MCP config to the exact path the bridge will run from.
 */
import { writeBotMcp } from "../../../../scripts/pi-bots/mcp_writer.mjs";
import { resolveCrowHome } from "../../../../scripts/pi-bots/ext_registry.mjs";

/** Resolve the sessionDir pi runs from: project workspace wins over def.session_dir. */
export async function resolveBotSessionDir(db, botId, def, projectId) {
  let sessionDir = def.session_dir;
  if (projectId != null) {
    const ws = (await db.execute({
      sql: "SELECT workspace_dir FROM project_spaces WHERE id=?",
      args: [projectId],
    })).rows[0];
    if (ws && ws.workspace_dir) sessionDir = ws.workspace_dir + "/bots/" + botId;
  }
  return sessionDir;
}

/** Regenerate the bot's .mcp.json from its current def+project. Returns writeBotMcp's result. */
export async function regenerateBotMcp(db, botId) {
  const row = (await db.execute({
    sql: "SELECT definition, project_id FROM pi_bot_defs WHERE bot_id=?",
    args: [botId],
  })).rows[0];
  if (!row) throw new Error("bot_not_found");
  const def = JSON.parse(row.definition || "{}");
  const sessionDir = await resolveBotSessionDir(db, botId, def, row.project_id);
  return writeBotMcp(def, { sessionDir, crowHome: resolveCrowHome() });
}
