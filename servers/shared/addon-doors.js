/**
 * Core policy tables for add-on doors and add-on state folders.
 *
 * These tables are CORE POLICY, keyed by add-on id and shipped with Crow:
 *  - `ADDON_DOORS` is the only place a gateway door set exists. A manifest may
 *    name a door set, but never add one, and only the set that belongs to its
 *    own id (see `deriveProfile` in scripts/addon-sandbox/profile.mjs). Nothing
 *    an add-on can write reaches this file.
 *  - `ADDON_STATE_DIRS` maps a FIRST-PARTY id to the exact Crow-home folder
 *    names that add-on has always used for its state. Never a name pattern, and
 *    never a manifest field (a pattern would collide with Crow-home entries such
 *    as `<CROW_HOME>/android-keystore`).
 *  - `ADDON_TOKEN_DIRS` maps a FIRST-PARTY id to home-relative folders it may
 *    hold read-write even though they sit under a hidden top-level entry of the
 *    home (a dot-directory such as `~/.local/share/<app>`). A hidden entry of
 *    the home is never writable otherwise, so entries are added only with a
 *    reviewed first-party need — never for a manifest field and never from
 *    anything an add-on can write.
 *
 * Data tables plus the door token that turns a door set into a one-spawn
 * capability. The token itself is never stored: only its sha256, in this
 * process's memory, replaced on each mint and cleared on close.
 */

import { createHash, randomBytes, timingSafeEqual } from "node:crypto";

/** Freeze an object graph so no caller can widen the policy at run time. */
function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) deepFreeze(value[key]);
    Object.freeze(value);
  }
  return value;
}

export const ADDON_DOORS = deepFreeze({
  // kiosk calls the gateway's loopback /api/kiosk/internal paths (bundles/kiosk/server/server.js).
  kiosk: [
    { method: "GET", path: "/api/kiosk/internal/displays" },
    { method: "POST", path: "/api/kiosk/internal/announce" },
    { method: "POST", path: "/api/kiosk/internal/show" },
  ],
  // studio's hub client (bundles/studio/server/hub-client.js) uses one prefix.
  studio: [
    { method: "GET", path: "/api/studio/agent/songs", prefix: true },
    { method: "POST", path: "/api/studio/agent/songs", prefix: true },
  ],
  // browser's container control (restart / recreate its own container).
  browser: [
    { method: "POST", path: "/api/addon-doors/browser/container" },
  ],
});

export const ADDON_STATE_DIRS = deepFreeze({
  browser: ["browser-sessions", "browser-downloads", "browser-exports"],
});

export const ADDON_TOKEN_DIRS = deepFreeze({
  // Empty on purpose: an entry here is a folder under a hidden home entry (a
  // PATH dir, a dot-config dir) that the add-on may write. Add one only with a
  // reviewed first-party need, as a home-relative path such as
  // ".local/share/<app>".
});

// --- door tokens -----------------------------------------------------------

/** A door token is 32 random bytes as lowercase hex. */
const TOKEN_RE = /^[0-9a-f]{64}$/;
/**
 * The sha256 of every live token, per add-on id. Never written anywhere.
 * One map per PROCESS, not per module instance: panel code reaches this file
 * through `appImport`, and a second instance (another spelling of the checkout
 * path) must validate against the same tokens the gateway minted.
 */
const TOKEN_MAP_KEY = Symbol.for("crow.addonDoorTokenHashes");
const tokenHashes = globalThis[TOKEN_MAP_KEY] instanceof Map
  ? globalThis[TOKEN_MAP_KEY]
  : (globalThis[TOKEN_MAP_KEY] = new Map());

const sha256 = (text) => createHash("sha256").update(String(text)).digest();

/**
 * A door set lives only in `ADDON_DOORS`; nothing else can be minted for.
 */
function hasDoorSet(id) {
  return typeof id === "string" && Object.prototype.hasOwnProperty.call(ADDON_DOORS, id);
}

/**
 * A request target a door may be judged on: exactly one leading `/`, and none
 * of the shapes that can rewrite the path a later parser sees.
 */
function safeDoorPath(path) {
  if (typeof path !== "string" || path === "") return false;
  if (path[0] !== "/" || path[1] === "/") return false;
  if (path.includes("//") || path.includes("..") || path.includes("%")) return false;
  if (path.includes("\\") || path.includes("?") || path.includes("#")) return false;
  return !/[\u0000-\u0020\u007f]/.test(path);
}

/** Whether `method` + `path` is one of `id`'s door entries. */
function doorAllows(id, method, path) {
  if (!hasDoorSet(id) || typeof method !== "string") return false;
  const entries = ADDON_DOORS[id];
  if (!Array.isArray(entries)) return false;
  const wanted = method.toUpperCase();
  for (const entry of entries) {
    if (!entry || entry.method !== wanted || typeof entry.path !== "string") continue;
    if (path === entry.path) return true;
    if (entry.prefix === true && path.startsWith(entry.path + "/")) return true;
  }
  return false;
}

/**
 * Mint a door token for one add-on: 32 random bytes as hex. Only the sha256 is
 * kept, in this process's memory, replacing any earlier token for that id.
 *
 * @throws when the id has no door set (`ADDON_DOORS` has no entry for it).
 */
export function mintAddonDoorToken(id) {
  if (!hasDoorSet(id)) throw new Error("no door set for this add-on id");
  const token = randomBytes(32).toString("hex");
  tokenHashes.set(id, sha256(token).toString("hex"));
  return token;
}

/**
 * Forget `id`'s token, but only the one that is still held: a spawn that ends
 * after a newer spawn minted for the same id must not clear the newer token.
 */
export function clearAddonDoorToken(id, token) {
  try {
    if (typeof id !== "string" || typeof token !== "string") return;
    const held = tokenHashes.get(id);
    if (typeof held !== "string") return;
    const digest = sha256(token).toString("hex");
    if (digest.length !== held.length) return;
    if (!timingSafeEqual(Buffer.from(digest, "hex"), Buffer.from(held, "hex"))) return;
    tokenHashes.delete(id);
  } catch { /* nothing to clear */ }
}

/**
 * Whether `token` is this add-on's live door token AND `method` + `path` is one
 * of its door entries. False for anything else: a token of another id, an id
 * with no door set, a token shape that is not 32 hex bytes, a path that can be
 * rewritten, and every throw.
 */
export function validateAddonDoorToken(token, id, method, path) {
  try {
    if (typeof token !== "string" || !TOKEN_RE.test(token)) return false;
    if (typeof id !== "string") return false;
    const held = tokenHashes.get(id);
    if (typeof held !== "string" || held.length !== 64) return false;
    if (!safeDoorPath(path)) return false;
    const digest = sha256(token).toString("hex");
    if (!timingSafeEqual(Buffer.from(digest, "hex"), Buffer.from(held, "hex"))) return false;
    return doorAllows(id, method, path);
  } catch {
    return false;
  }
}

/**
 * A predicate for one add-on's relay: `(url, method) => boolean`, where `url`
 * is the raw request target. The query is dropped and the path is held to the
 * same safety rules as above before the door set is consulted. An unknown id
 * answers false for everything.
 */
export function doorPredicateFor(id) {
  return (url, method) => {
    try {
      if (typeof url !== "string" || url === "" || url[0] !== "/") return false;
      const q = url.indexOf("?");
      const path = q < 0 ? url : url.slice(0, q);
      if (!safeDoorPath(path)) return false;
      return doorAllows(id, method, path);
    } catch {
      return false;
    }
  };
}