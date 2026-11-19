/**
 * Retired bundles — the code-held manifest stub for a bundle Crow no longer ships.
 *
 * The uninstall route reads a bundle's manifest from the REPO (`getManifest` →
 * `APP_BUNDLES/<id>/manifest.json`) to undo what the install did: remove its skills,
 * re-comment the gateway env vars it wrote, close its firewall ports and drop its
 * Tailscale Serve mapping. When the bundle's folder is gone from the repo, that read
 * returns null and a Remove would skip all of it — silently leaving a skill, an env
 * line and a Serve mapping behind on a live install.
 *
 * So a retired id resolves to the stub below instead. It is deliberately NOT a
 * manifest: it cannot be installed from (nothing reads it on the install path) and
 * it carries names only, no defaults, so an env revert never rewrites a value.
 *
 * A retired bundle that is still installed on this machine also gets a boot-time
 * Fix-it card (fix-it/detectors/retired-bundle.js) whose one click runs the product's
 * own uninstall. Nothing here deletes anything by itself.
 */

/**
 * `{ [id]: stub }`. Every entry is frozen: a handler mutating it would leak into the
 * next read of the same process.
 */
export const RETIRED_BUNDLES = Object.freeze({
  companion: Object.freeze({
    id: "companion",
    name: "AI Companion",
    type: "bundle",
    version: "retired",
    retired: true,
    // The OLVV web page Crow served at /companion (proxied to 127.0.0.1:12393 before
    // the proxy was removed). Kept here so Remove still closes the port and the Serve
    // mapping an old install opened.
    ports: Object.freeze([12393]),
    webUI: Object.freeze({ port: 12393, proxyMode: "direct" }),
    skills: Object.freeze(["skills/companion.md"]),
    // Names only (no defaults): the revert re-comments exactly these keys in the
    // gateway's .env and never writes a value.
    env_vars: Object.freeze([
      "COMPANION_AVATAR",
      "EIKANYA_MODELS_DIR",
      "COMPANION_TTS_VOICE",
      "COMPANION_PERSONA",
      "COMPANION_CHARACTER_NAME",
      "COMPANION_AI_PROFILE",
      "COMPANION_AI_MODEL",
    ].map((name) => Object.freeze({ name }))),
  }),
});

/**
 * The stub manifest for a retired bundle id, or null for anything else. Callers pass
 * it only where a REPO manifest is expected and came back null.
 */
export function retiredBundleManifest(bundleId) {
  return Object.prototype.hasOwnProperty.call(RETIRED_BUNDLES, bundleId) ? RETIRED_BUNDLES[bundleId] : null;
}

/** Is this id a bundle Crow retired? (Never a statement about what is installed.) */
export function isRetiredBundle(bundleId) {
  return Object.prototype.hasOwnProperty.call(RETIRED_BUNDLES, bundleId);
}

/** The retired bundle ids, in a stable order. */
export function retiredBundleIds() {
  return Object.keys(RETIRED_BUNDLES);
}