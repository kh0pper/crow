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
import { auditCrossHostCall } from "../../shared/cross-host-auth.js";
import { getOrCreateLocalInstanceId } from "../instance-registry.js";

/** Factory so tests can inject db + regen. */
export function makeBotFederationHandlers({ db, regenerateBotMcp = defaultRegen, auditFn = auditCrossHostCall }) {
  async function loadDef(botId) {
    const row = (await db.execute({
      sql: "SELECT definition, project_id FROM pi_bot_defs WHERE bot_id=?",
      args: [botId],
    })).rows[0];
    if (!row) return null;
    let def = {};
    try { def = JSON.parse(row.definition || "{}"); } catch { def = {}; }
    return { def };
  }

  async function audit(req, action, botId, httpStatus, error) {
    let localId = null;
    try { localId = getOrCreateLocalInstanceId(); } catch { /* best-effort */ }
    const source = req.headers?.["x-crow-source"] || null;
    try {
      await auditFn(db, {
        sourceInstanceId: source,
        targetInstanceId: localId,
        direction: "inbound",
        action,
        bundleId: botId,
        actor: source ? `instance:${source}` : null,
        httpStatus,
        error: error || null,
      });
    } catch { /* audit must never break the path */ }
  }

  return {
    async getDef(req, res) {
      const botId = req.params.botId;
      if (!(await botPeerManageable(db, botId))) {
        await audit(req, "federation.bot.def", botId, 403, "not_manageable");
        return res.status(403).json({ error: "not_manageable" });
      }
      const row = await loadDef(botId);
      if (!row) {
        await audit(req, "federation.bot.def", botId, 404, "bot_not_found");
        return res.status(404).json({ error: "bot_not_found" });
      }
      await audit(req, "federation.bot.def", botId, 200, null);
      return res.type("application/json").send(JSON.stringify({ bot_id: botId, definition: redactDefForPeer(row.def) }));
    },

    async patch(req, res) {
      const botId = req.params.botId;
      if (!(await botPeerManageable(db, botId))) {
        await audit(req, "federation.bot.patch", botId, 403, "not_manageable");
        return res.status(403).json({ error: "not_manageable" });
      }
      const row = await loadDef(botId);
      if (!row) {
        await audit(req, "federation.bot.patch", botId, 404, "bot_not_found");
        return res.status(404).json({ error: "bot_not_found" });
      }
      const patch = (req.body && req.body.patch) || {};
      let merged;
      try { merged = applyPeerPatch(row.def, patch); }
      catch (e) {
        await audit(req, "federation.bot.patch", botId, 400, "field_not_patchable");
        return res.status(400).json({ error: "field_not_patchable", detail: String(e.message || e) });
      }
      const toolsChanged = Object.keys(patch).some((k) => k.startsWith("tools.") || k === "skills");
      await db.execute({
        sql: "UPDATE pi_bot_defs SET definition=?, updated_at=datetime('now') WHERE bot_id=?",
        args: [JSON.stringify(merged), botId],
      });
      let mcp = null;
      if (toolsChanged) {
        try { mcp = await regenerateBotMcp(db, botId); }
        catch (e) {
          console.warn("[bot-federation] mcp regen failed for", botId, ":", e.message);
          mcp = { error: String(e.message || e) };
        }
      }
      await audit(req, "federation.bot.patch", botId, 200, null);
      return res.json({ ok: true, regenerated: toolsChanged, mcp: mcp && mcp.path ? { path: mcp.path, servers: mcp.servers } : mcp });
    },

    async setEnabled(req, res) {
      const botId = req.params.botId;
      if (!(await botPeerManageable(db, botId))) {
        await audit(req, "federation.bot.enabled", botId, 403, "not_manageable");
        return res.status(403).json({ error: "not_manageable" });
      }
      const row = await loadDef(botId);
      if (!row) {
        await audit(req, "federation.bot.enabled", botId, 404, "bot_not_found");
        return res.status(404).json({ error: "bot_not_found" });
      }
      const enabled = req.body && Number(req.body.enabled) ? 1 : 0;
      await db.execute({
        sql: "UPDATE pi_bot_defs SET enabled=?, updated_at=datetime('now') WHERE bot_id=?",
        args: [enabled, botId],
      });
      await audit(req, "federation.bot.enabled", botId, 200, null);
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
