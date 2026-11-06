/**
 * Calls room store — the rooms created by `POST /api/rooms` (routes/calls-page.js).
 *
 * Extracted from calls-page.js so boot/public-endpoints.js can validate a call
 * page's room credential before handing out TURN credentials (security audit
 * N1a-9) WITHOUT importing the express router, express.static and the whole
 * sharing-server graph: this module depends on node:crypto, plus the
 * node:crypto-only token-compare helper (servers/shared/token-compare.js).
 *
 * Two verifiers read this store, both through calls-page.js's
 * validateCallRoomToken(): the /calls page (and its /api/rooms/:code lookup),
 * and now /api/turn-credentials, which the call page's WebRTC script calls.
 *
 * Rooms created here are NOT in the sharing server's _activeRooms map, so
 * validateRoomToken() does not know them; that is why the calls-room lookup is
 * a separate step in validateCallRoomToken.
 */

import { randomBytes } from "node:crypto";
import { tokensEqual } from "../../shared/token-compare.js";

/** Room token lifetime. Same 24h window the calls page documents. */
export const CALL_ROOM_TTL_MS = 24 * 60 * 60 * 1000;

/** Map<roomCode, { token, hostName, createdAt, callUrl }> */
const _callsRooms = new Map();

/**
 * Create a room for calls.
 * Returns { roomCode, token, callUrl }
 */
export function createCallRoom(hostName) {
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
  const now = Date.now();
  for (const [code, room] of _callsRooms) {
    if (now - room.createdAt > CALL_ROOM_TTL_MS) {
      _callsRooms.delete(code);
    }
  }

  return { roomCode, token, callUrl };
}

/**
 * Check a room code + token against the rooms created by POST /api/rooms.
 * Returns { roomCode, hostName } on a live match, null otherwise.
 *
 * Deliberately does NOT consult the sharing server's rooms — callers that need
 * both do it in calls-page.js's validateCallRoomToken(), which is the only
 * consumer-facing verifier.
 */
export function lookupCallRoom(roomCode, token) {
  if (!roomCode || !token) return null;
  const room = _callsRooms.get(String(roomCode));
  if (!room) return null;
  // Constant time, and a missing/non-string token never matches.
  if (!tokensEqual(room.token, typeof token === "string" ? token : String(token))) return null;
  if (Date.now() - room.createdAt > CALL_ROOM_TTL_MS) {
    _callsRooms.delete(String(roomCode));
    return null;
  }
  return { roomCode: String(roomCode), hostName: room.hostName };
}