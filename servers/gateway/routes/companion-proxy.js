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
 *
 * ⚠ COOKIES — the same rule as /proxy/<id>/ (routes/extension-proxy.js).
 * `/companion/*` is a third-party app on the DASHBOARD's origin: the browser
 * sends it every Crow cookie it holds, and the app's `Set-Cookie` lands on
 * that origin. So Crow's own cookies are stripped from the request (HTTP and
 * the WebSocket upgrade) and the app's `Set-Cookie`s are refused for a Crow
 * name and re-scoped under /companion/. One shared helper does both
 * (../proxy-cookie-filter.js) — see tests/companion-proxy-cookies.test.js.
 *
 * The WebSocket HANDSHAKE gets the stricter rule: EVERY `Set-Cookie` in the
 * upgrade's response (a 101, or an error response) is dropped, because that
 * header block never passes through `proxyRes` (see stripSetCookieFromHandshake).
 */

import { createProxyMiddleware } from "http-proxy-middleware";
import { validateRoomToken } from "../../sharing/server.js";
import { join } from "node:path";
import { resolveDataDir } from "../../db.js";
import { scopeProxySetCookieHeader, stripCrowCookiesForBackend, stripSetCookieFromHandshake } from "../proxy-cookie-filter.js";

const COMPANION_PORT = process.env.COMPANION_PORT || "12393";
const COMPANION_TARGET = `http://127.0.0.1:${COMPANION_PORT}`;
/** The mount the companion is served under; every backend cookie is scoped to it. */
const COMPANION_PATH = "/companion";

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
    ws: false,   // NEVER true: http-proxy-middleware 3 then subscribes its OWN catch-all
    //   server "upgrade" listener on the first proxied HTTP request, which proxies every later
    //   upgrade (any path, no cookie) before our own auth checks run. Upgrades go only through
    //   the explicit .upgrade() call after those checks (proxy.ws does not need this option).
    pathRewrite: { [`^${COMPANION_PATH}`]: "" },
    on: {
      // Crow's session/CSRF cookies never reach the companion backend: it is a
      // third-party app on the dashboard's origin, and `crow_session` is a live,
      // replayable dashboard session (queue item #51 — same rule as /proxy/<id>/).
      proxyReq: (proxyReq) => {
        stripCrowCookiesForBackend(proxyReq);
      },
      // The upgrade never passes through `proxyReq`; http-proxy emits
      // `proxyReqWs` for it (ONE handler — a second key would replace this).
      proxyReqWs: (proxyReq, req, socket) => {
        stripCrowCookiesForBackend(proxyReq);
        // The app's handshake response (a 101, or an error response to the
        // upgrade) never reaches `proxyRes`: http-proxy writes the upstream's
        // header block straight to the client socket. Filter the socket here,
        // before any of it is written, so a `Set-Cookie: crow_session=…` in the
        // 101 cannot land on the dashboard's origin.
        stripSetCookieFromHandshake(socket);
      },
      proxyRes: (proxyRes) => {
        // Allow embedding; companion serves its own frontend
        delete proxyRes.headers["x-frame-options"];
        delete proxyRes.headers["content-security-policy"];
        // The app may not set Crow's own cookie names on the dashboard's origin,
        // and its own cookies are re-scoped under /companion/ (shared rules).
        const kept = scopeProxySetCookieHeader(proxyRes.headers["set-cookie"], COMPANION_PATH);
        if (kept) proxyRes.headers["set-cookie"] = kept;
        else delete proxyRes.headers["set-cookie"];
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
      const dbPath = process.env.CROW_DB_PATH || join(resolveDataDir(), "crow.db");
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
  app.use(COMPANION_PATH, httpProxy);

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
