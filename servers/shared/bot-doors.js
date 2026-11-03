/**
 * A contained bot's doors on its own gateway, and the mark the egress relay
 * leaves on every socket it opens (containment Phase 1, PR 6).
 *
 * A contained bot has no NIC: its only way to host loopback is the spawner's
 * egress relay (scripts/pi-bots/pi_egress.mjs). That relay used to splice the
 * bot's bytes to the gateway port, which handed the bot every route a plain
 * loopback socket reaches — every `local`-classified route of its own gateway,
 * and the host's /internal routes, the signing relay above all. Two independent
 * layers close that:
 *
 *   1. this allowlist. The relay terminates HTTP itself and judges EVERY
 *      request on the connection (keep-alive included) against these doors.
 *   2. the mark. Every socket the relay opens to loopback is bound to
 *      RELAY_SOURCE_V4, so the gateway can recognise "this came through the
 *      relay" and refuse /internal on it (middleware/internal-guard.js), and
 *      the #614 caller check refuses it outright (bot-host-caller.js). The
 *      mark is set by the relay process, outside the sandbox: a bot cannot
 *      choose its own source address. Any 127/8 address is local on Linux, so
 *      no privilege is needed to bind it.
 *
 * The door list is exact and case-sensitive: owner-authority surfaces
 * (/memory, /projects, /sharing, /tools*, /router, /dashboard, /llm/models,
 * /llm/acquire) are deliberately absent, and an operator's ruling fixed the
 * list. A family added later (a new bot-only mount) is added by the PR that
 * mounts it.
 */

export const BOT_DOOR_PREFIXES = Object.freeze([
  "/llm/v1/",      // the model router: the bot's own models, no provider key
  "/llm/p/",       // a provider door (native row, external engine, bundle)
  "/llm/c/",       // a consented cloud door
  "/board/mcp",    // its own board mount, under the board token
  "/phone/mcp",    // phone plans, under the phone token and the actor signature
  "/artifacts/mcp",
  "/secrets/mcp",  // the bot-only credential-card mount, under the secrets token and a signed Perch actor
  "/peer-relay/",  // the relay to paired peers, under the relay token
]);

/** The source address the relay binds for every upstream socket it opens. */
export const RELAY_SOURCE_V4 = "127.0.77.1";

// Anything that could rewrite the path between this check and the gateway's
// router is refused rather than reasoned about: a ".." segment, a second
// slash, a backslash, "*" (OPTIONS *), and ANY percent-escape (a normalised
// door path never needs one, and %2e/%2f/%5c are only the ones we know).
const FORBIDDEN = /[\u0000-\u0020\u007f\\*]/;

/**
 * Is this request target one of the bot doors? Origin-form only ("/path"), so
 * an absolute-form URL ("http://host/path", which a proxy target could carry)
 * is never a door. The query string is dropped before matching: doors are
 * paths, and `/board/mcp?x=1` is the board mount.
 *
 * A door that is a whole mount (`/board/mcp`) matches only itself or a child
 * path, so `/board/mcpx` is not a door; a door that is a prefix (`/llm/v1/`)
 * matches anything under it.
 */
export function isDoorPath(rawTarget) {
  if (typeof rawTarget !== "string" || rawTarget === "") return false;
  // Origin-form only: one leading slash, never two.
  if (rawTarget[0] !== "/" || rawTarget[1] === "/") return false;
  if (FORBIDDEN.test(rawTarget)) return false;
  if (rawTarget.includes("//") || rawTarget.includes("..") || rawTarget.includes("%")) return false;
  const q = rawTarget.indexOf("?");
  const path = q < 0 ? rawTarget : rawTarget.slice(0, q);
  if (path === "/") return false;
  for (const door of BOT_DOOR_PREFIXES) {
    // A whole-mount door is itself or a child path ("?x=1" was already
    // dropped), never a longer word: /board/mcpx is not the board mount.
    if (door.endsWith("/") ? path.startsWith(door) : (path === door || path.startsWith(door + "/"))) return true;
  }
  return false;
}

/** "[::ffff:127.0.77.1]" / "::FFFF:127.0.77.1" / "127.0.77.1" → "127.0.77.1". */
export function normalizeRelayAddr(addr) {
  let s = String(addr ?? "").trim().replace(/^\[(.*)\]$/, "$1");
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(s);
  if (mapped) s = mapped[1];
  return s;
}

/**
 * Did this socket come from the egress relay? True only for the mark, in any
 * spelling the kernel may report it (a dual-stack listener sees the v4-mapped
 * form). Every other peer, loopback ones included, is not relayed.
 */
export function isRelayedSocket(socket) {
  if (!socket || typeof socket !== "object") return false;
  return normalizeRelayAddr(socket.remoteAddress) === RELAY_SOURCE_V4;
}