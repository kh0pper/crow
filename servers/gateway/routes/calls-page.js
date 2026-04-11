/**
 * Calls Page Routes & Room Management API
 *
 * Serves the standalone call page and provides REST endpoints
 * for room creation and info.
 *
 *   POST /api/rooms       — Create a room (optionally invite a contact)
 *   GET  /api/rooms/:code — Get room info (requires valid token)
 *   GET  /calls           — Standalone call page (requires room+token in URL)
 *   GET  /calls/scripts/* — Static scripts for the call page
 */

import { Router } from "express";
import { randomBytes } from "node:crypto";
import { existsSync } from "node:fs";
import { resolve as resolvePath } from "node:path";
import express from "express";
import { validateRoomToken } from "../../sharing/server.js";
import { getRoomInfo } from "./calls-signaling.js";

// Resolve calls bundle scripts directory
const BUNDLES_DIR = process.env.CROW_BUNDLES_DIR ||
  resolvePath(process.env.HOME || "", ".crow/bundles");
const CALLS_SCRIPTS_DIR = resolvePath(BUNDLES_DIR, "calls/scripts");

// Also check the repo bundles/ dir as fallback (development mode)
const REPO_CALLS_DIR = resolvePath(
  new URL(".", import.meta.url).pathname,
  "../../../bundles/calls/scripts"
);

function getScriptsDir() {
  if (existsSync(CALLS_SCRIPTS_DIR)) return CALLS_SCRIPTS_DIR;
  if (existsSync(REPO_CALLS_DIR)) return REPO_CALLS_DIR;
  return null;
}

/**
 * In-memory room store for rooms created via REST API.
 * These are separate from the sharing server's _activeRooms but use the
 * same token format and validation pattern. Rooms created here are also
 * registered in the sharing server's store so validateRoomToken works.
 */

// We import the _activeRooms setter from the sharing server indirectly.
// Since sendRoomInvite registers rooms, and validateRoomToken reads them,
// we need to register our rooms there too. We'll do this by importing
// a registration helper, or we'll create rooms that the signaling relay
// validates independently.

// For simplicity: rooms created via POST /api/rooms are registered in
// a local map AND the calls signaling relay accepts them. The signaling
// relay validates via validateRoomToken OR accepts if the room was created here.
const _callsRooms = new Map();

/**
 * Create a room for calls.
 * Returns { roomCode, token, callUrl }
 */
function createCallRoom(hostName) {
  const roomCode = randomBytes(6).toString("hex");
  const token = randomBytes(16).toString("hex");

  const gatewayUrl = process.env.CROW_GATEWAY_URL || "";
  const callUrl = gatewayUrl
    ? `${gatewayUrl}/calls?room=${roomCode}&token=${token}`
    : `/calls?room=${roomCode}&token=${token}`;

  _callsRooms.set(roomCode, {
    token,
    hostName: hostName || "Host",
    createdAt: Date.now(),
    callUrl,
  });

  // Clean up expired rooms (24h TTL)
  for (const [code, room] of _callsRooms) {
    if (Date.now() - room.createdAt > 24 * 60 * 60 * 1000) {
      _callsRooms.delete(code);
    }
  }

  return { roomCode, token, callUrl };
}

/**
 * Validate a call room token. Checks both the sharing server's rooms
 * (for companion-created rooms) and our own rooms.
 */
export function validateCallRoomToken(roomCode, token) {
  // Check sharing server's rooms first (companion-created rooms)
  const sharingResult = validateRoomToken(roomCode, token);
  if (sharingResult) return sharingResult;

  // Check calls-created rooms
  const room = _callsRooms.get(roomCode);
  if (!room) return null;
  if (room.token !== token) return null;
  if (Date.now() - room.createdAt > 24 * 60 * 60 * 1000) {
    _callsRooms.delete(roomCode);
    return null;
  }
  return { roomCode, hostName: room.hostName };
}

/**
 * Create Express router for calls page and API routes.
 *
 * @param {Function} dashboardAuth - Express middleware for dashboard auth
 */
export default function callsPageRouter(dashboardAuth) {
  const router = Router();

  // --- POST /api/rooms — Create a room ---
  router.post("/api/rooms", dashboardAuth, async (req, res) => {
    try {
      const { contactId, hostName } = req.body || {};

      const { roomCode, token, callUrl } = createCallRoom(hostName);

      // If contactId provided, send invite via Nostr
      let inviteResult = null;
      if (contactId) {
        try {
          // Lazy import to avoid circular deps and only load when needed
          const { sendRoomInvite } = await import("../../sharing/server.js");
          // Pass our room credentials so the Nostr invite uses the same room
          inviteResult = await sendRoomInvite(contactId, hostName, {
            roomCode, token, joinUrl: callUrl,
          });
        } catch (err) {
          inviteResult = { ok: false, message: err.message };
        }
      }

      res.json({
        roomCode,
        token,
        callUrl,
        invite: inviteResult,
      });
    } catch (err) {
      res.status(500).json({ error: err.message });
    }
  });

  // --- GET /api/rooms/:code — Room info ---
  router.get("/api/rooms/:code", (req, res) => {
    const { code } = req.params;
    const token = req.query.token;

    if (!token) {
      return res.status(400).json({ error: "Token required" });
    }

    // Validate token
    const valid = validateCallRoomToken(code, String(token));
    if (!valid) {
      return res.status(401).json({ error: "Invalid or expired room" });
    }

    // Get live room info from signaling relay
    const info = getRoomInfo(code);

    res.json({
      roomCode: code,
      hostName: valid.hostName,
      participantCount: info?.participantCount || 0,
      members: info?.members || [],
    });
  });

  // --- GET /calls — Standalone call page ---
  router.get("/calls", (req, res) => {
    const { room, token } = req.query;

    if (!room || !token) {
      return res.status(403).send(callPageError("Invalid call link", "A room code and token are required to join a call."));
    }

    // Validate token
    const valid = validateCallRoomToken(String(room), String(token));
    if (!valid) {
      return res.status(403).send(callPageError("Expired or invalid call", "This call link is no longer valid. Room tokens expire after 24 hours."));
    }

    // Serve the call page HTML with injected config
    const gatewayUrl = process.env.CROW_GATEWAY_URL || "";
    const wsProtocol = gatewayUrl.startsWith("https") ? "wss" : "ws";
    const wsBase = gatewayUrl.replace(/^https?/, wsProtocol) || `ws://localhost:${process.env.PORT || 3001}`;

    res.send(callPageHtml({
      roomCode: String(room),
      token: String(token),
      hostName: valid.hostName || "Host",
      gatewayUrl,
      wsUrl: `${wsBase}/calls/ws`,
    }));
  });

  // --- Static scripts serving ---
  const scriptsDir = getScriptsDir();
  if (scriptsDir) {
    router.use("/calls/scripts", express.static(scriptsDir, {
      maxAge: "1h",
      setHeaders: (res) => {
        res.set("Content-Type", "application/javascript");
      },
    }));
  }

  return router;
}

/**
 * Generate the standalone call page HTML.
 */
function callPageHtml({ roomCode, token, hostName, gatewayUrl, wsUrl }) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, user-scalable=no">
<title>Crow Call</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #0f0f17;
    color: #fafaf9;
    font-family: 'DM Sans', system-ui, -apple-system, sans-serif;
    height: 100vh;
    overflow: hidden;
  }
  #crow-call-root { width: 100%; height: 100%; }
</style>
<script>
  window.CrowCallConfig = {
    roomCode: ${JSON.stringify(roomCode)},
    token: ${JSON.stringify(token)},
    hostName: ${JSON.stringify(hostName)},
    gatewayUrl: ${JSON.stringify(gatewayUrl)},
    wsUrl: ${JSON.stringify(wsUrl)},
  };
</script>
</head>
<body>
<div id="crow-call-root"></div>
<script src="/calls/scripts/crow-calls-webrtc.js"></script>
<script src="/calls/scripts/crow-calls-panel.js"></script>
<script src="/calls/scripts/crow-call-ui.js"></script>
</body>
</html>`;
}

/**
 * Generate an error page for invalid/expired call links.
 */
function callPageError(title, message) {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Crow Call</title>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #0f0f17; color: #fafaf9;
    font-family: 'DM Sans', system-ui, sans-serif;
    display: flex; align-items: center; justify-content: center;
    height: 100vh;
  }
  .error-box {
    text-align: center; max-width: 400px; padding: 40px;
    background: rgba(26,26,46,0.5); border-radius: 16px;
    border: 1px solid rgba(61,61,77,0.4);
  }
  h1 { font-size: 20px; margin-bottom: 12px; color: #ef4444; }
  p { font-size: 14px; color: #a8a29e; line-height: 1.6; }
</style>
</head>
<body>
<div class="error-box">
  <h1>${title}</h1>
  <p>${message}</p>
</div>
</body>
</html>`;
}
