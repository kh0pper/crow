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
 * A leaf module for the callers' import graph: node's own path/fs builtins, no project
 * imports, so both routes/bundles.js and compose-guard.js can use it without a cycle
 * (compose-guard already sits under bundles-config → folder-grants → compose-guard).
 */
import { basename, isAbsolute, join, normalize } from "node:path";
import { readFileSync } from "node:fs";

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

// Programs that take a package name as their FIRST non-flag argument: the package is fetched
// from a registry and run from there, so only what follows it can name a bundle file.
const PACKAGE_RUNNERS = new Set(["npx", "uvx", "bunx"]);

/**
 * The launcher values a manifest declares, as written, that could name a file in the
 * installed bundle folder. The MCP spawn runs with that folder as its cwd
 * (servers/gateway/proxy.js), and node resolves a script argument there, so EVERY argument
 * is a candidate — no `/` needed: `main.js` is the file beside the manifest, `.` makes node
 * run `index.js` or the package.json `main`, and `--import=./data/h.mjs` carries a path
 * after its `=`. Over-protecting an argument that is really a bare word costs nothing;
 * missing one costs the whole check.
 *
 * Not candidates: a plain flag (no value), and — for npx/uvx/bunx — the FIRST non-flag
 * argument, which is the package to run. A relative `command` with a separator does name a
 * file (resolve-command.js resolves it inside the folder), and so does an absolute one
 * (it resolves to that host path); a bare `command` (`node`, `npx`) is looked up on PATH,
 * never in the bundle.
 *
 * One list, two readers: the bundle contract refuses any of these values that is absolute,
 * carries a `..` segment or a `\`, and compose-guard.js refuses a read-write mount of the
 * folder each one lands in.
 *
 * @param {object} manifest
 * @returns {{key: string, value: string}[]} key = the manifest key naming the value
 */
export function launcherPathValues(manifest) {
  const out = [];
  const command = manifest?.server?.command;
  if (typeof command === "string" && command !== "" && !command.startsWith("-") && command.includes("/")) {
    out.push({ key: "server.command", value: command });
  }
  const args = Array.isArray(manifest?.server?.args) ? manifest.server.args : [];
  const runner = typeof command === "string" && PACKAGE_RUNNERS.has(basename(command));
  let packageSkipped = false;
  for (const arg of args) {
    if (typeof arg !== "string" || arg === "") continue;
    let value = arg;
    if (arg.startsWith("-")) {
      // A flag on its own names nothing; a `-x=value` / `--opt=value` flag carries a value
      // that may be a file (`--import=./data/h.mjs`, `--require=./hook.js`).
      const eq = arg.indexOf("=");
      if (eq < 0) continue;
      value = arg.slice(eq + 1);
      if (value === "") continue;
    } else if (runner && !packageSkipped) {
      packageSkipped = true;
      continue;
    }
    out.push({ key: "server.args", value });
  }
  return out;
}

/**
 * What node runs for a launcher argument that resolves to the bundle root (`.` or `./`): its
 * own default `index.js`, and the top-level entry the INSTALLED package.json's `main` names —
 * the file node would really start. With no readable package.json (or no `main`) node falls
 * back to `index.js`, so that is all there is to protect.
 */
function rootLauncherValues(bundleDir) {
  const out = ["index.js"];
  if (typeof bundleDir !== "string" || bundleDir === "") return out;
  let main;
  try { main = JSON.parse(readFileSync(join(bundleDir, "package.json"), "utf8"))?.main; } catch { return out; }
  if (typeof main !== "string" || main === "") return out;
  if (normalize(main) !== "." && normalize(main) !== "..") out.push(main);
  return out;
}

/**
 * The manifest-declared paths, in the order the refresh copies them.
 *
 * `launcher: true` swaps the refresh's two launcher rules for the spawn's: every value
 * launcherPathValues finds (the launch command when it is a path, every argument, the value
 * half of a `--opt=value` flag, with an npx/uvx/bunx package name skipped), and an object
 * panel resolved to the file the gateway imports (`panel/<panel.id || bundle id>.js`,
 * routes/bundles.js resolvePanelPath) instead of the literal `panel` folder. An argument
 * that resolves to the bundle root expands to the files node would run from it, so
 * `bundleDir` is read (package.json `main`) when the caller passes it.
 *
 * @param {object} manifest
 * @param {{launcher?: boolean, bundleDir?: string}} [opts]
 * @returns {{key: string, value: string}[]} key = the manifest key naming the path
 */
export function declaredPaths(manifest, { launcher = false, bundleDir = null } = {}) {
  const out = [];
  const add = (key, value) => { if (typeof value === "string" && value) out.push({ key, value }); };
  const args = Array.isArray(manifest?.server?.args) ? manifest.server.args : [];
  if (launcher) {
    for (const { key, value } of launcherPathValues(manifest)) {
      // `.` / `./` is the bundle folder itself: node then runs index.js, or whatever the
      // installed package.json's `main` names.
      if (normalize(value) === ".") for (const v of rootLauncherValues(bundleDir)) add(key, v);
      else add(key, value);
    }
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
 * The same declarations for the install check: the MCP launcher and its arguments, and an
 * object panel as the file really imported.
 * @param {object} manifest
 * @param {string} [bundleDir] the installed bundle folder (read for package.json `main`)
 * @returns {{key: string, value: string}[]}
 */
export function declaredControlPaths(manifest, bundleDir) {
  return declaredPaths(manifest, { launcher: true, bundleDir });
}