/**
 * The paths a bundle's own manifest declares inside its installed folder — ONE list,
 * read by the two places that must agree on it:
 *
 *   - routes/bundles.js (`declaredRoots`): which extra top-level entries the version
 *     refresh copies from the repo copy. The bundle contract is manifest-declaration-
 *     driven, so a path a manifest names is code by definition.
 *   - compose-guard.js (`manifestControlTops`): which top-level entries of the bundle
 *     folder a container of that bundle may never mount read-write, because the
 *     gateway reads or runs them.
 *
 * A leaf module for the callers' import graph: only node's own `isAbsolute` (no project
 * imports), so both routes/bundles.js and compose-guard.js can use it without a cycle
 * (compose-guard already sits under bundles-config → folder-grants → compose-guard).
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
 * A launcher value that names a file in the installed bundle folder: the MCP spawn
 * runs with that folder as its cwd (resolve-command.js resolves a relative launcher
 * inside it, and node resolves a script argument the same way). `node`, `npm`, `npx`,
 * `uvx` and any other bare name are looked up elsewhere (never in the bundle), a
 * leading `-` is a flag, and a bare package name is an argument — none of them are
 * paths here. A scoped package name (`@scope/pkg`) shares the shape of a relative
 * path and is resolved as one: over-declaring a folder no manifest points at costs
 * nothing, while missing one costs the whole check.
 */
function bundleRelativeFile(v) {
  return typeof v === "string" && v !== "" && !isAbsolute(v) && !v.startsWith("-") && v.includes("/") ? v : null;
}

/**
 * The manifest-declared paths, in the order the refresh copies them.
 *
 * `launcher: true` swaps the refresh's two launcher rules for the spawn's: every
 * server.args entry that is a bundle-relative file (not just args[0], and not a flag
 * or package name), the launch command itself when it is one, and an object panel
 * resolved to the file the gateway imports (`panel/<panel.id || bundle id>.js`,
 * routes/bundles.js resolvePanelPath) instead of the literal `panel` folder.
 *
 * @param {object} manifest
 * @param {{launcher?: boolean}} [opts]
 * @returns {{key: string, value: string}[]} key = the manifest key naming the path
 */
export function declaredPaths(manifest, { launcher = false } = {}) {
  const out = [];
  const add = (key, value) => { if (typeof value === "string" && value) out.push({ key, value }); };
  const args = Array.isArray(manifest?.server?.args) ? manifest.server.args : [];
  if (launcher) {
    add("server.command", bundleRelativeFile(manifest?.server?.command));
    for (const a of args) add("server.args", bundleRelativeFile(a));
  } else if (args.length) {
    add("server.args", args[0]);
  }
  if (typeof manifest?.panel === "string") add("panel", manifest.panel);
  else if (manifest?.panel && typeof manifest.panel === "object") {
    if (!launcher) add("panel", "panel");
    else {
      // routes/bundles.js resolvePanelPath, expression for expression: `panel.id || bundle id`, then a
      // template literal, which stringifies whatever the id is (a number, an array climbing with `..`,
      // a nested object) into the path the gateway imports. Mirroring it keeps this list honest about
      // the file a hostile manifest really names.
      const panelId = manifest.panel.id || manifest.id;
      if (panelId) add("panel.id", `panel/${String(panelId)}.js`);
    }
  }
  if (typeof manifest?.panelRoutes === "string") add("panelRoutes", manifest.panelRoutes);
  // A bundle's widgets are code: widgets/<id>.js files the gateway imports at page time. The
  // contract has no path key for them (the file is always widgets/<id>.js), so the root is literal.
  if (Array.isArray(manifest?.widgets) && manifest.widgets.length) add("widgets", "widgets");
  // The post-install hook's directory is code — run with `bash <bundle>/<script>` and
  // refreshed on a version bump like panel/.
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

/**
 * The same declarations for the install check: the MCP launcher and its
 * bundle-relative arguments, and an object panel as the file really imported.
 * @returns {{key: string, value: string}[]}
 */
export function declaredControlPaths(manifest) {
  return declaredPaths(manifest, { launcher: true });
}