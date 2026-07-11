/**
 * boot/peer-public-api.js — backend reload endpoint, peer relay endpoints,
 * contact discovery endpoints.
 *
 * relayDb is passed in deps (created in index.js per C1 — before module 1).
 * deps: { authMiddleware, relayDb, loadDynamicBackends }
 */

import { createRelayHandlers } from "../../sharing/relay.js";

export async function mountPeerPublicApi(app, deps) {
  const { authMiddleware, relayDb, loadDynamicBackends } = deps;

  // --- Backend Reload Endpoint (admin-only) ---
  const reloadHandler = async (req, res) => {
    try {
      await loadDynamicBackends();
      res.json({ status: "ok", message: "Dynamic backends reloaded" });
    } catch (err) {
      res.status(500).json({ status: "error", message: err.message });
    }
  };

  if (authMiddleware) {
    app.post("/api/reload-backends", authMiddleware, reloadHandler);
  } else {
    app.post("/api/reload-backends", reloadHandler);
  }

  // --- Peer Relay Endpoints ---
  const relayHandlers = createRelayHandlers(relayDb);

  if (authMiddleware) {
    app.post("/relay/store", authMiddleware, relayHandlers.store);
    app.get("/relay/fetch", authMiddleware, relayHandlers.fetch);
  } else {
    app.post("/relay/store", relayHandlers.store);
    app.get("/relay/fetch", relayHandlers.fetch);
  }

  // --- Contact Discovery Endpoints (public, opt-in) ---
  app.get("/discover/profile", async (req, res) => {
    try {
      const setting = await relayDb.execute({
        sql: "SELECT value FROM dashboard_settings WHERE key = 'discovery_enabled'",
        args: [],
      });
      if (!setting.rows.length || setting.rows[0].value !== "true") {
        return res.status(404).json({ error: "Discovery not enabled" });
      }
      const { loadOrCreateIdentity } = await import("../../sharing/identity.js");
      const identity = loadOrCreateIdentity();
      const nameSetting = await relayDb.execute({
        sql: "SELECT value FROM dashboard_settings WHERE key = 'discovery_name'",
        args: [],
      });
      res.json({
        crow_discovery: true,
        crow_id: identity.crowId,
        display_name: nameSetting.rows[0]?.value || null,
        // Identity fields are ed25519Pubkey/secp256k1Pubkey (identity.js) —
        // the *Public spellings shipped undefined pubkeys for months (twin of
        // the #165 identity-fields fix).
        ed25519_pubkey: identity.ed25519Pubkey,
        secp256k1_pubkey: identity.secp256k1Pubkey,
      });
    } catch (err) {
      res.status(500).json({ error: "Discovery unavailable" });
    }
  });

  // Find a user by email hash (privacy-preserving contact discovery)
  app.get("/discover/find", async (req, res) => {
    try {
      const { hash } = req.query;
      if (!hash || hash.length !== 64) {
        return res.status(400).json({ error: "Missing or invalid hash parameter (expected SHA-256 hex)" });
      }

      // Check if this instance has opted into discovery with a matching email hash
      const emailHash = await relayDb.execute({
        sql: "SELECT value FROM dashboard_settings WHERE key = 'discovery_email_hash'",
        args: [],
      });

      if (!emailHash.rows.length || emailHash.rows[0].value !== hash) {
        return res.json({ found: false });
      }

      const { loadOrCreateIdentity } = await import("../../sharing/identity.js");
      const identity = loadOrCreateIdentity();
      const nameSetting = await relayDb.execute({
        sql: "SELECT value FROM dashboard_settings WHERE key = 'discovery_name'",
        args: [],
      });

      res.json({
        found: true,
        crow_id: identity.crowId,
        display_name: nameSetting.rows[0]?.value || null,
      });
    } catch (err) {
      res.status(500).json({ error: "Discovery unavailable" });
    }
  });
}
