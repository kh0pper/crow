/**
 * F4a Layer 3 — owner-side cross-instance bot edit/run endpoints.
 *
 * Mounted under /dashboard/bot-federation/* behind federationVerifyMiddleware
 * (HMAC). Every handler re-checks botPeerManageable(db, botId) — the gate is
 * authoritative; the HMAC middleware only proves the caller is a known peer.
 * Secrets never cross the wire (redactDefForPeer); only allowlisted non-secret
 * fields are writable (applyPeerPatch). Under /dashboard → Funnel-blocked;
 * never add to PUBLIC_FUNNEL_PREFIXES.
 */
import { Router } from "express";
import { botPeerManageable } from "../bot-management-exposure.js";
import { redactDefForPeer, applyPeerPatch } from "../bot-federation.js";
import { regenerateBotMcp as defaultRegen } from "../dashboard/panels/bot-mcp-regen.js";

/** Factory so tests can inject db + regen. */
export function makeBotFederationHandlers({ db, regenerateBotMcp = defaultRegen }) {
  async function loadDef(botId) {
    const row = (await db.execute({
      sql: "SELECT definition, project_id FROM pi_bot_defs WHERE bot_id=?",
      args: [botId],
    })).rows[0];
    if (!row) return null;
    let def = {};
    try { def = JSON.parse(row.definition || "{}"); } catch { def = {}; }
    return { def, project_id: row.project_id };
  }

  return {
    async getDef(req, res) {
      const botId = req.params.botId;
      if (!(await botPeerManageable(db, botId))) return res.status(403).json({ error: "not_manageable" });
      const row = await loadDef(botId);
      if (!row) return res.status(404).json({ error: "bot_not_found" });
      return res.type("application/json").send(JSON.stringify({ bot_id: botId, definition: redactDefForPeer(row.def) }));
    },

    async patch(req, res) {
      const botId = req.params.botId;
      if (!(await botPeerManageable(db, botId))) return res.status(403).json({ error: "not_manageable" });
      const row = await loadDef(botId);
      if (!row) return res.status(404).json({ error: "bot_not_found" });
      const patch = (req.body && req.body.patch) || {};
      let merged;
      try { merged = applyPeerPatch(row.def, patch); }
      catch (e) { return res.status(400).json({ error: "field_not_patchable", detail: String(e.message || e) }); }
      const toolsChanged = Object.keys(patch).some((k) => k.startsWith("tools.") || k === "skills");
      await db.execute({
        sql: "UPDATE pi_bot_defs SET definition=?, updated_at=datetime('now') WHERE bot_id=?",
        args: [JSON.stringify(merged), botId],
      });
      let mcp = null;
      if (toolsChanged) { try { mcp = await regenerateBotMcp(db, botId); } catch (e) { mcp = { error: String(e.message || e) }; } }
      return res.json({ ok: true, regenerated: toolsChanged, mcp: mcp && mcp.path ? { path: mcp.path, servers: mcp.servers } : mcp });
    },

    async setEnabled(req, res) {
      const botId = req.params.botId;
      if (!(await botPeerManageable(db, botId))) return res.status(403).json({ error: "not_manageable" });
      const row = await loadDef(botId);
      if (!row) return res.status(404).json({ error: "bot_not_found" });
      const enabled = req.body && Number(req.body.enabled) ? 1 : 0;
      await db.execute({
        sql: "UPDATE pi_bot_defs SET enabled=?, updated_at=datetime('now') WHERE bot_id=?",
        args: [enabled, botId],
      });
      return res.json({ ok: true, enabled });
    },
  };
}

/** Build an Express router for the three routes (relative to the /dashboard mount). */
export function botFederationRouter({ createDbClient, verifyMiddleware }) {
  const router = Router();
  const wrap = (name) => async (req, res) => {
    const db = createDbClient();
    try { await makeBotFederationHandlers({ db })[name](req, res); }
    catch (err) { if (!res.headersSent) res.status(500).json({ error: "bot_federation_failed" }); }
    finally { db.close(); }
  };
  router.get("/bot-federation/def/:botId", verifyMiddleware, wrap("getDef"));
  router.post("/bot-federation/patch/:botId", verifyMiddleware, wrap("patch"));
  router.post("/bot-federation/enabled/:botId", verifyMiddleware, wrap("setEnabled"));
  return router;
}
