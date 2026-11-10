/**
 * The paths a bundle's own manifest declares inside its installed folder — ONE list, read by
 * the two places that must agree on it:
 *
 *   - routes/bundles.js (`declaredRoots`): which extra top-level entries the version refresh
 *     copies from the repo copy.
 *   - scripts/lib/bundle-contract.mjs (badBundlePath / badPanelId): which declared values are
 *     refused, and routes/bundles.js re-applies the same rule when it reads them.
 *
 * Hygiene, not a security boundary: a compose may never mount the installed bundle folder
 * read-write at all (compose-guard.js), so no declared path decides what a container may write.
 *
 * A leaf module for the callers' import graph: node's own path builtin, no project imports, so
 * both routes/bundles.js and compose-guard.js can use it without a cycle (compose-guard already
 * sits under bundles-config → folder-grants → compose-guard).
 */
import { isAbsolute } from "node:path";

/**
 * First path segment of a manifest-declared path, or null for a falsy/non-string
 * input. This is the gateway's own reading of a declared path: a plain split, which
 * keeps an absolute value's empty first segment and a `..` as a segment — see
 * isValidPathSegment for the guard that keeps a hostile declared path from being
 * joined.
 */
export function firstPathSegment(p) {
  if (!p || typeof p !== "string") return null;
  const seg = p.split("/")[0];
  return seg || null;
}

/** A single, plain, non-traversal path segment (no "/", not "." or ".."). */
export function isValidPathSegment(seg) {
  return typeof seg === "string" && seg.length > 0 && seg !== "." && seg !== ".." && !seg.includes("/") && !seg.includes("\\");
}

/** An object panel's id is a file name: the gateway imports `panel/<panel.id || bundle id>.js`. */
export const PANEL_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/**
 * A manifest path the gateway reads relative to the installed bundle folder must be a plain
 * relative path that stays inside it: never absolute, never carrying a `\` (an ordinary
 * filename character on Linux, so the gateway would resolve it as written while a reader on
 * another platform would not), never walking out with a `..` segment.
 *
 * ONE rule, three readers: the bundle contract (scripts/lib/bundle-contract.mjs) refuses a
 * manifest carrying such a value, and the install paths in routes/bundles.js skip it — defence
 * in depth, so a hand-edited or pre-contract manifest never gets a file copied out of its folder
 * and run.
 */
export function badBundlePath(p) {
  return typeof p !== "string" || p === "" || isAbsolute(p) || p.includes("\\") || p.split("/").includes("..");
}

/** An object panel's id, checked by the same rule the contract applies. */
export function badPanelId(id) {
  return typeof id !== "string" || !PANEL_ID_RE.test(id);
}

/**
 * A manifest-declared name as it appears in a refusal or a log line: the name is
 * attacker-controlled, and one carrying a newline or an ESC would otherwise repaint the line
 * it is echoed in. Control characters are escaped and the length capped.
 */
export function refusalName(value) {
  return String(value).slice(0, 80)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

/**
 * The manifest-declared paths, in the order the refresh copies them: the first launcher
 * argument, the panel (a string path, or the `panel` folder an object panel lives in),
 * panelRoutes, the widgets folder, the post-install hook and every skill.
 *
 * @param {object} manifest
 * @returns {{key: string, value: string}[]} key = the manifest key naming the path
 */
export function declaredPaths(manifest) {
  const out = [];
  const add = (key, value) => { if (typeof value === "string" && value) out.push({ key, value }); };
  const args = Array.isArray(manifest?.server?.args) ? manifest.server.args : [];
  if (args.length) add("server.args", args[0]);
  if (typeof manifest?.panel === "string") add("panel", manifest.panel);
  else if (manifest?.panel && typeof manifest.panel === "object") add("panel", "panel");
  if (typeof manifest?.panelRoutes === "string") add("panelRoutes", manifest.panelRoutes);
  // A bundle's widgets are code: widgets/<id>.js files the gateway imports at page time. The
  // contract has no path key for them (the file is always widgets/<id>.js), so the root is literal.
  if (Array.isArray(manifest?.widgets) && manifest.widgets.length) add("widgets", "widgets");
  // The post-install hook's directory: run with `bash <bundle>/<script>` and refreshed on a
  // version bump like panel/.
  if (typeof manifest?.postInstall?.script === "string") add("postInstall.script", manifest.postInstall.script);
  if (Array.isArray(manifest?.skills)) for (const s of manifest.skills) add("skills", s);
  return out;
}

/**
 * The top-level bundle entries the version refresh treats as code, by the gateway's
 * own reading of a declared path (firstPathSegment + isValidPathSegment). Callers add
 * the bundle's fixed entries; this is only what the manifest declares.
 * @returns {Set<string>}
 */
export function declaredRoots(manifest) {
  const roots = new Set();
  for (const { value } of declaredPaths(manifest)) {
    const seg = firstPathSegment(value);
    if (seg && isValidPathSegment(seg)) roots.add(seg);
  }
  return roots;
}