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