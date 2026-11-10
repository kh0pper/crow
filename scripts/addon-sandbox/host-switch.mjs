/**
 * The operator's two wall switches for one computer, read in ONE place (a leaf
 * module: no imports), so the spawn decision, the status page, the notices, the
 * linked-add-on migration and the install-time pinning can never disagree.
 *
 *  - `CROW_ADDON_WALLS=off` is the kill switch: every wall off at once.
 *  - `CROW_ADDON_WALLS_DEFAULT` is the per-host default, `walled` or `off`.
 *    Anything else (unset, empty, a typo) means the code default below.
 *
 * Both are read from the gateway's own unit environment only (never from a
 * bundle .env, which `ADDON_WALL_SWITCH_KEYS` keeps them out of).
 *
 * The code default is `off` in this release: a host walls its add-ons only
 * after the operator sets `CROW_ADDON_WALLS_DEFAULT=walled` for it. A later
 * release flips this one constant after every fleet host has run walled.
 */

/** The per-host default when the operator has not set one. */
export const ADDON_WALLS_CODE_DEFAULT = "off";

/** The two values the per-host default may take. */
const HOST_DEFAULTS = new Set(["walled", "off"]);

function envOf(env) {
  return env && typeof env === "object" ? env : {};
}

/** True when the operator's kill switch is set. */
export function killSwitchOn(env = process.env) {
  return envOf(env).CROW_ADDON_WALLS === "off";
}

/** This host's default, `walled` or `off`: the operator's value, else the code default. */
export function hostWallsDefault(env = process.env) {
  const value = envOf(env).CROW_ADDON_WALLS_DEFAULT;
  return HOST_DEFAULTS.has(value) ? value : ADDON_WALLS_CODE_DEFAULT;
}

/** Walls are on for this host: its default is walled and the kill switch is not set. */
export function wallsOnForHost(env = process.env) {
  return hostWallsDefault(env) === "walled" && !killSwitchOn(env);
}
