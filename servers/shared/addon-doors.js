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
 * Data only: the token minting and validation that turns a door set into a
 * capability arrives in a later task.
 */

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