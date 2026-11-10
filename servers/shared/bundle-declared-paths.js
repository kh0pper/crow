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
import { basename, extname, isAbsolute, join, normalize, relative, resolve as resolvePath, sep } from "node:path";
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

/**
 * A manifest-declared name as it appears in a refusal or a log line: the name is
 * attacker-controlled, and one carrying a newline or an ESC would otherwise repaint the line
 * it is echoed in. Control characters are escaped and the length capped.
 */
export function refusalName(value) {
  return String(value).slice(0, 80)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`);
}

// Programs that fetch a package and run it: their package slot (the first non-flag argument
// and the value of -p/--package/--from/--with) is code only when it names a LOCAL spec.
const PACKAGE_RUNNERS = new Set(["npx", "uvx", "bunx", "pnpx"]);
// The two-word form of a runner (`pnpm dlx`, `npm exec`, `uv run`): program → subcommand word.
const RUNNER_WORDS = new Map([["pnpm", "dlx"], ["npm", "exec"], ["uv", "run"]]);
// Programs that RUN the script given as their first non-flag argument.
const INTERPRETERS = new Set(["node", "nodejs", "bun", "deno", "tsx", "ts-node", "python", "python3", "sh", "bash"]);
// Interpreters that name a subcommand before the script (`deno run x.ts`).
const RUN_SUBCOMMAND = new Set(["deno", "bun"]);
// Flags whose value is a file the interpreter loads and runs: code, written either
// `--flag value` or `--flag=value`.
const CODE_LOADING_FLAGS = new Set(["--import", "--require", "-r", "--loader", "--experimental-loader", "--env-file"]);
// A runner's package flag: its value is the package, checked exactly like the package slot.
const PACKAGE_FLAGS = new Set(["-p", "--package", "--from", "--with"]);
// The extensions node tries for a script given without one (`node main` → main.js, …).
const SCRIPT_EXTENSIONS = [".js", ".mjs", ".cjs", ".json", ".node"];
/** `-x` / `--opt=value` as { flag, value }; value is "" when there is no `=`. */
function flagParts(arg) {
  const eq = arg.indexOf("=");
  return eq < 0 ? { flag: arg, value: "" } : { flag: arg.slice(0, eq), value: arg.slice(eq + 1) };
}
/**
 * A package runner's spec is code only when it is local: a path (`./data`, `/opt/x`, `~/x`), a
 * `file:` spec, or a path with a `/` that is not a scoped registry name (`@scope/name`,
 * `@scope/name@1.2`). A bare registry name (`pkg`, `pkg@1.2`) is fetched, never read from the
 * bundle folder.
 */
function isLocalPackageSpec(v) {
  if (typeof v !== "string" || v === "") return false;
  if (v.startsWith(".") || v.startsWith("/") || v.startsWith("~")) return true;
  if (v.includes("file:")) return true;
  return v.includes("/") && !/^@[^/]+\/[^/]+$/.test(v);
}

/**
 * The launcher values a manifest declares, as written, that make the gateway's launcher LOAD
 * OR RUN CODE. Everything else is data the bundle's own program reads, and is not declared —
 * a `--data-dir=data` or `--db data/x.db` argument is how a container legitimately reaches its
 * own read-write `data/` mount.
 *
 * Code values:
 *   - a relative `command` with a separator (`./run.sh`): resolve-command.js resolves it inside
 *     the bundle folder. A bare command (`node`) is looked up on PATH, and an absolute one names
 *     a host program: neither is a bundle entry.
 *   - for an interpreter (`node`, `bun`, `deno`, `python`, `sh`/`bash`, `tsx`, `ts-node`), the
 *     FIRST non-flag argument is the script (`deno run` / `bun run` name the subcommand first),
 *     and every code-loading flag's value is a file it loads (`--import`, `--require`, `-r`,
 *     `--loader`, `--experimental-loader`, `--env-file`), written either way. `python -m` names
 *     a MODULE, not a path, so it is skipped and no script follows it.
 *   - for a package runner (`npx`, `uvx`, `bunx`, `pnpx`, `pnpm dlx`, `npm exec`, `uv run`), the
 *     package slot and the value of `-p`/`--package`/`--from`/`--with` are code only when they
 *     are a LOCAL spec (`./data`, `../x`, `/opt/x`, `file:…`); a registry name is fetched.
 *   - any other argument of any command is data.
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
  const push = (value) => { if (typeof value === "string" && value !== "") out.push({ key: "server.args", value }); };
  const command = manifest?.server?.command;
  const args = Array.isArray(manifest?.server?.args) ? manifest.server.args : [];
  const program = typeof command === "string" ? basename(command) : "";
  if (typeof command === "string" && command !== "" && !command.startsWith("-")
    && !isAbsolute(command) && command.includes("/")) {
    out.push({ key: "server.command", value: command });
  }
  // What the program is: an interpreter runs the script it is given, a runner fetches or runs a
  // package. Anything else takes data, so none of its arguments is declared.
  let kind = null;
  let start = 0;
  if (INTERPRETERS.has(program)) kind = "interpreter";
  else if (PACKAGE_RUNNERS.has(program)) kind = "runner";
  else if (RUNNER_WORDS.has(program) && args[0] === RUNNER_WORDS.get(program)) { kind = "runner"; start = 1; }
  if (!kind) return out;
  if (kind === "interpreter" && RUN_SUBCOMMAND.has(program) && args[start] === "run") start += 1;

  if (kind === "runner") {
    let packageTaken = false;
    for (let i = start; i < args.length; i += 1) {
      const arg = args[i];
      if (typeof arg !== "string" || arg === "") continue;
      if (arg.startsWith("-")) {
        const { flag, value } = flagParts(arg);
        if (!PACKAGE_FLAGS.has(flag)) continue;
        // `-p=./data` and `-p ./data` are the same package slot.
        const spec = value !== "" ? value : (typeof args[i + 1] === "string" ? args[++i] : "");
        if (isLocalPackageSpec(spec)) push(spec);
        continue;
      }
      // Only the FIRST non-flag argument is the package; what follows belongs to the tool.
      if (packageTaken) continue;
      packageTaken = true;
      if (isLocalPackageSpec(arg)) push(arg);
    }
    return out;
  }

  let scriptTaken = false;
  let moduleGiven = false;
  for (let i = start; i < args.length; i += 1) {
    const arg = args[i];
    if (typeof arg !== "string" || arg === "") continue;
    if (arg.startsWith("-")) {
      const { flag, value } = flagParts(arg);
      // `python -m mypkg`: the module NAME is run, and it is not a path. Nothing after it is
      // the script either — it is the module's own argv.
      if ((program === "python" || program === "python3") && flag === "-m") {
        moduleGiven = true;
        if (value === "" && typeof args[i + 1] === "string" && !args[i + 1].startsWith("-")) i += 1;
        continue;
      }
      if (!CODE_LOADING_FLAGS.has(flag)) continue;
      const v = value !== "" ? value : (typeof args[i + 1] === "string" ? args[++i] : "");
      push(v);
      continue;
    }
    // The first non-flag argument is the script; everything after it is the script's argv.
    if (scriptTaken || moduleGiven) continue;
    scriptTaken = true;
    push(arg);
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
 * The bundle-relative paths one launcher code value names, read the way the launcher reads it:
 *   - the bundle root (`.`, `./`, `.//`) → `index.js` and the installed package.json `main`;
 *   - an absolute value → its path inside the installed folder (nothing when it is not inside);
 *   - a value without an extension → the exact file node tries first, then `v.js`, `v.mjs`,
 *     `v.cjs`, `v.json`, `v.node` (for a bare `main` those are all top-level entries).
 * Values that are not strings (or are empty) name nothing.
 */
function launcherCodeValues(value, bundleDir) {
  if (typeof value !== "string" || value === "") return [];
  let v = value;
  if (isAbsolute(v)) {
    if (typeof bundleDir !== "string" || bundleDir === "") return [];
    const rel = relative(bundleDir, resolvePath(v));
    if (isAbsolute(rel) || rel === ".." || rel.startsWith(`..${sep}`)) return [];
    v = rel;
  }
  // `.` / `./` (and the folder itself, from a relative-ised absolute value) is the bundle root:
  // node then runs index.js, or whatever the installed package.json's `main` names.
  if (v === "" || normalize(v).replace(/\/+$/, "") === ".") return rootLauncherValues(bundleDir);
  if (extname(v) !== "") return [v];
  return [v, ...SCRIPT_EXTENSIONS.map((ext) => v + ext)];
}

/**
 * The manifest-declared paths, in the order the refresh copies them.
 *
 * `launcher: true` swaps the refresh's two launcher rules for the spawn's: every value
 * launcherPathValues finds (the launch command when it is a relative path, an interpreter's
 * script and code-loading flag values, a runner's local package spec), and an object panel
 * resolved to the file the gateway imports (`panel/<panel.id || bundle id>.js`,
 * routes/bundles.js resolvePanelPath) instead of the literal `panel` folder. Each value is
 * then expanded (launcherCodeValues): a value that names the bundle root becomes the files
 * node would run from it, an absolute value becomes its path inside the folder, and a value
 * without an extension also names the extensions node would try. Arguments that are data
 * (`--data-dir=data`, a registry package name) name nothing here.
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
      for (const v of launcherCodeValues(value, bundleDir)) add(key, v);
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