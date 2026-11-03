/**
 * No /internal route is reachable through the egress relay (containment
 * Phase 1, PR 6).
 *
 * The relay in a spawner (the gateway itself, or a separate bot host such as
 * pibot-gateways@) opens every upstream socket to loopback bound to the relay
 * mark, 127.0.77.1 (servers/shared/bot-doors.js). A contained bot cannot pick
 * its source address, so a socket carrying the mark is a bot's request and
 * nothing else.
 *
 * The relay also holds an exact door allowlist, so /internal should never
 * arrive here at all. This is the independent second layer: if the relay's
 * list is ever wrong or bypassed, a relayed request still cannot reach
 * /internal (the signing relay — /internal/actor-sign — above all), and the two
 * layers are proven separately. A plain 404, not a 403: the route is not there
 * for this caller.
 *
 * Lowercased and with repeated slashes collapsed, because Express routing is
 * case-insensitive by default: /INTERNAL/actor-sign would otherwise route, and
 * //internal/actor-sign is the same path to a normalising router.
 */
import { isRelayedSocket } from "../../shared/bot-doors.js";

const INTERNAL = "/internal";

export function refuseRelayedInternal(req, res, next) {
  if (!isRelayedSocket(req.socket)) return next();
  // Decoded too, so this layer stands without the relay's "no percent-escape"
  // rule: /%69nternal is /internal to anything that decodes. Undecodable =
  // refused (a door path never needs a broken escape).
  let raw = String(req.path || req.url || "");
  try { raw = decodeURIComponent(raw); } catch { return res.status(404).json({ error: "not found" }); }
  const path = raw.toLowerCase().replace(/\\/g, "/").replace(/\/{2,}/g, "/");
  if (!path.startsWith(INTERNAL)) return next();
  res.status(404).json({ error: "not found" });
}