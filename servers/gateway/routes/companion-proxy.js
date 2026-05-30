/**
 * Companion WebSocket + HTTP Reverse Proxy
 *
 * Proxies the AI companion (Open-LLM-VTuber) through the gateway so it's
 * accessible via the same HTTPS hostname — no extra ports needed.
 *
 *   /companion/*         →  http://127.0.0.1:{COMPANION_PORT}/*
 *   /companion/client-ws →  ws://127.0.0.1:{COMPANION_PORT}/client-ws (WebSocket)
 *   /client-ws           →  ws://127.0.0.1:{COMPANION_PORT}/client-ws (WebSocket)
 *
 * WebSocket connections with ?room=X&token=Y are validated against active
 * room tokens. Connections without tokens are allowed (household mode).
 * Invalid tokens are rejected with 403.
 */

import { createProxyMiddleware } from "http-proxy-middleware";
import { validateRoomToken } from "../../sharing/server.js";

const COMPANION_PORT = process.env.COMPANION_PORT || "12393";
const COMPANION_TARGET = `http://127.0.0.1:${COMPANION_PORT}`;

/**
 * Set up companion proxy routes and WebSocket upgrade handler.
 *
 * @param {import('express').Express} app
 * @param {import('http').Server} server
 */
export default function setupCompanionProxy(app, server) {
  const httpProxy = createProxyMiddleware({
    target: COMPANION_TARGET,
    changeOrigin: true,
    ws: true,
    pathRewrite: { "^/companion": "" },
    on: {
      proxyRes: (proxyRes) => {
        // Allow embedding; companion serves its own frontend
        delete proxyRes.headers["x-frame-options"];
        delete proxyRes.headers["content-security-policy"];
      },
    },
    onError: (err, req, res) => {
      if (!res || res.headersSent) return;
      res.status(502).json({
        error: "Companion is not running",
        hint: `Expected on port ${COMPANION_PORT}`,
      });
    },
  });

  // Per-device kiosk config (Part 3). The injected companion frontend calls this
  // with ?device=<id> to learn which bot/avatar/persona preset to show and which
  // companion_features to toggle. Registered BEFORE the proxy so it isn't
  // forwarded to OLVV. Read-only; the device registry lives in dashboard_settings.
  app.get("/companion/device-config", async (req, res) => {
    const deviceId = String(req.query.device || "").trim();
    if (!deviceId) return res.status(400).json({ error: "device query param required" });
    try {
      const { default: Database } = await import("better-sqlite3");
      const dbPath = process.env.CROW_DB_PATH || `${process.env.HOME}/.crow/data/crow.db`;
      const db = new Database(dbPath, { readonly: true });
      let devices = [];
      try {
        const row = db.prepare("SELECT value FROM dashboard_settings WHERE key = ?").get("meta_glasses_devices");
        devices = row ? JSON.parse(row.value || "[]") : [];
      } catch { devices = []; }
      const dev = devices.find((d) => String(d.id) === deviceId) || null;
      db.close();
      if (!dev) return res.status(404).json({ error: "device not found" });
      const botId = dev.bound_bot_id || null;
      const slug = botId ? String(botId).toLowerCase().replace(/ /g, "_").replace(/\./g, "_") : null;
      res.json({
        device_id: dev.id,
        device_kind: dev.device_kind || "glasses",
        bot_id: botId,
        character_preset: slug ? `crow_bot_${slug}` : null,
        companion_features: dev.companion_features || null,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // HTTP proxy for companion frontend
  app.use("/companion", httpProxy);

  // WebSocket upgrade handler — validate room tokens before proxying
  server.on("upgrade", (req, socket, head) => {
    const url = req.url || "";

    // Match /companion/client-ws or /client-ws (companion JS generates relative URLs)
    const isCompanionWs =
      url.startsWith("/companion/client-ws") || url.startsWith("/client-ws");
    if (!isCompanionWs) return; // Let other upgrade handlers (MCP SSE, extensions) handle it

    // Validate room token if provided
    const params = new URL(url, "http://localhost").searchParams;
    const room = params.get("room");
    const token = params.get("token");

    if (room && token) {
      const result = validateRoomToken(room, token);
      if (!result) {
        socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
        socket.destroy();
        return;
      }
    }
    // No token = household mode (allowed)

    // Rewrite path for /companion/client-ws → /client-ws
    if (url.startsWith("/companion/")) {
      req.url = url.replace("/companion", "");
    }

    httpProxy.upgrade(req, socket, head);
  });

  console.log(`  [proxy] Companion UI: /companion/ → ${COMPANION_TARGET}`);
}
