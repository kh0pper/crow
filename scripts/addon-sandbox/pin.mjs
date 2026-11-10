/**
 * One version, resolved once, for an add-on whose launcher fetches its own code.
 *
 * `npx <pkg>` and `uvx <tool>` name whatever the registry serves today, so a
 * walled add-on would run different bytes tomorrow than the ones the owner
 * installed. An install on a host whose walls are on therefore writes the
 * version it resolved (`<pkg>@1.2.3`, `<tool>==1.2.3`) into mcp-addons.json,
 * plus npm's `dist.integrity` for the tarball it will fetch. The integrity is
 * RECORDED for the owner and for a later check: nothing compares it today, so
 * it is a note about what the install resolved, not a guarantee about what runs.
 *
 * A shape this module cannot pin to one exact version is refused with a reason:
 * an install that refuses is better than an add-on that runs a floating range.
 *
 * `launcherSpec` is the ONE reader of a launcher argument list, used here and by
 * the warm-up (`warmup.mjs`): a launcher option that could fetch from another
 * source is refused before either of them reads a spec.
 *
 * `pinLauncherArgs` never mutates the entry it is given. The two resolvers are
 * injectable (tests never reach npm or PyPI), and the wiring reads the two
 * switches in ONE place (`wallsOnForHost`), so a host with the walls off never
 * calls either of them.
 *
 * Node built-ins only.
 */
import { execFile } from "node:child_process";
import { dirname, join } from "node:path";

import { withoutCredentialKeys } from "../../servers/shared/credentials-env.js";
import { wallsOnForHost } from "./host-switch.mjs";

/** A version that names one release: `1.2.3`, `1.2.3-rc.1`, `1.2.3+build`. */
const EXACT_VERSION_RE = /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/;
/** A Python version as PyPI writes it: `0.4.1`, `2.0.0b1`, `1.0.post1`. */
const PYPI_VERSION_RE = /^[0-9][0-9A-Za-z.!+_-]*$/;
/** npm's tarball integrity, as `dist.integrity` reports it. */
const INTEGRITY_RE = /^sha512-[A-Za-z0-9+/]+={0,2}$/;
/** A bare package or tool name (a leading `@` marks an npm scope). */
const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** A `git+…` source pinned to a full commit. */
const GIT_PIN_RE = /^git\+.+@[0-9a-f]{40}$/i;

/** The launcher that could not be pinned to one version. */
export class PinRefused extends Error {
  constructor(message) {
    super(message);
    this.name = "PinRefused";
  }
}

/** The program name of a launcher, whatever path it is given as. */
function baseOf(command) {
  return String(command ?? "").split("/").pop();
}

/**
 * An npm or PyPI spec split into its name and version part: a leading `@` is a
 * scope, so the version separator is the last `@` that is not the first char.
 */
function splitSpec(spec) {
  const text = String(spec);
  const at = text.indexOf("@", text.startsWith("@") ? 1 : 0);
  if (at <= 0) return { name: text, version: null };
  return { name: text.slice(0, at), version: text.slice(at + 1) };
}

/** A `name==version` spec, or null when it is not that shape. */
function splitEquals(spec) {
  const text = String(spec);
  const at = text.indexOf("==");
  if (at <= 0) return null;
  return { name: text.slice(0, at), version: text.slice(at + 2) };
}

/** The options an `npx` argument list may carry before the package spec. */
const NPX_OPTIONS = new Set(["-y", "--yes", "-q", "--quiet"]);
/** The options a `uvx` argument list may carry before the tool spec. */
const UVX_OPTIONS = new Set(["-q", "--quiet"]);
/** What a launcher option this module does not read is refused with. */
const UNSUPPORTED_OPTION = ": this launcher option is not supported for a walled add-on";

/**
 * Read a launcher's argument list the one way both the pin and the warm-up do.
 *
 * Everything before the spec decides where the code comes from, so only the
 * options that change nothing about the source are allowed there: `-y`/`--yes`
 * and `-q`/`--quiet` for `npx`, `-q`/`--quiet` and `--from <ref>` for `uvx`.
 * Any other option is refused, because an unread one (`-p`, `--package`,
 * `--index-url`, `--with`, a flag that names another package) would make the
 * wall guard one source while the child fetches another. Everything after the
 * spec belongs to the tool and is not parsed.
 *
 * A launcher this module does not read is answered, never refused.
 *
 * @param {string} command  the launcher path or name
 * @param {string[]} [args]
 * @returns {{launcher: "npx"|"uvx"|null, spec: string|null, specIndex: number, from: string|null}}
 * @throws {PinRefused} an argument list that cannot be read safely
 */
export function launcherSpec(command, args) {
  const list = Array.isArray(args) ? args : [];
  const launcher = baseOf(command);
  if (launcher !== "npx" && launcher !== "uvx") return { launcher: null, spec: null, specIndex: -1, from: null };
  const allowed = launcher === "npx" ? NPX_OPTIONS : UVX_OPTIONS;
  let from = null;

  for (let i = 0; i < list.length; i++) {
    const a = list[i];
    if (typeof a !== "string") throw new PinRefused("the argument list cannot be read safely");
    if (launcher === "uvx" && (a === "--from" || a.startsWith("--from="))) {
      const value = a === "--from" ? list[i + 1] : a.slice("--from=".length);
      // A source that is missing, or that is the next option, names nothing.
      if (typeof value !== "string" || !value || value.startsWith("-")) {
        throw new PinRefused("--from: no source name in the argument list");
      }
      from = value;
      if (a === "--from") i += 1;
      continue;
    }
    // A lone `-` names something (a tool reads it as stdin), so it is a spec.
    if (a.startsWith("-") && a !== "-") {
      if (!allowed.has(a)) throw new PinRefused(a + UNSUPPORTED_OPTION);
      continue;
    }
    return { launcher, spec: a, specIndex: i, from };
  }
  return { launcher, spec: null, specIndex: -1, from };
}

/** True when a `--from` ref names one exact thing: a full commit, or `name==version`. */
function isPinnedRef(ref) {
  if (typeof ref !== "string" || !ref) return false;
  if (GIT_PIN_RE.test(ref)) return true;
  const pair = splitEquals(ref);
  return !!pair && NAME_RE.test(pair.name) && PYPI_VERSION_RE.test(pair.version);
}

/** The copy this module returns: never the caller's object, never its args array. */
function copyEntry(entry) {
  const base = entry && typeof entry === "object" ? entry : {};
  return { ...base, args: Array.isArray(base.args) ? [...base.args] : base.args };
}

/** The npm resolver production uses: the npm beside the gateway's own node. */
async function defaultNpmView(spec) {
  const npm = join(dirname(process.execPath), "npm");
  const out = await new Promise((resolve, reject) => {
    execFile(
      npm,
      ["view", spec, "version", "dist.integrity", "--json"],
      { timeout: 60_000, env: withoutCredentialKeys(process.env), maxBuffer: 4 * 1024 * 1024 },
      (err, stdout) => (err ? reject(err) : resolve(String(stdout ?? ""))),
    );
  });
  const parsed = JSON.parse(out);
  // A range answers with one object per matching version: the last one is newest.
  const last = Array.isArray(parsed) ? parsed[parsed.length - 1] : parsed;
  return last && typeof last === "object" ? { version: last.version, integrity: last.integrity } : null;
}

/** The PyPI resolver production uses: the project's JSON document. */
async function defaultPypiVersion(name) {
  const resp = await fetch(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`, {
    signal: AbortSignal.timeout(15_000),
  });
  if (!resp.ok) throw new PinRefused(`the package index answered ${resp.status}`);
  const doc = await resp.json();
  const version = doc && doc.info ? doc.info.version : null;
  return typeof version === "string" ? version : null;
}

/** One resolved npm answer, checked: an exact version and a sha512 integrity. */
function checkNpmAnswer(spec, answer) {
  const version = answer && answer.version;
  const integrity = answer && answer.integrity;
  if (typeof version !== "string" || !EXACT_VERSION_RE.test(version)) {
    throw new PinRefused(`${spec}: the package index named no exact version`);
  }
  if (typeof integrity !== "string" || !INTEGRITY_RE.test(integrity)) {
    throw new PinRefused(`${spec}: the package index named no sha512 integrity`);
  }
  return { version, integrity };
}

/**
 * Pin an entry's launcher arguments to one version.
 *
 * @param {object} entry  an mcp-addons.json entry (read only: never mutated)
 * @param {object} [o]
 * @param {(spec: string) => Promise<{version: string, integrity: string}>} [o.npmView]
 * @param {(name: string) => Promise<string>} [o.pypiVersion]
 * @returns {Promise<{entry: object, pinned: boolean}>}
 * @throws {PinRefused} a spec that cannot be pinned to one exact version
 */
export async function pinLauncherArgs(entry, { npmView, pypiVersion } = {}) {
  const copy = copyEntry(entry);
  const args = Array.isArray(copy.args) ? copy.args : [];
  const read = launcherSpec(copy.command, args);

  if (read.launcher === "npx") {
    const spec = read.spec;
    if (spec === null) return { entry: copy, pinned: false };
    const at = read.specIndex;
    const { name, version } = splitSpec(spec);
    if (version !== null && EXACT_VERSION_RE.test(version)) return { entry: copy, pinned: true };
    const view = typeof npmView === "function" ? npmView : defaultNpmView;
    let answer;
    try {
      answer = await view(spec);
    } catch (err) {
      throw new PinRefused(`${spec}: the version could not be looked up (${err?.message || err})`);
    }
    const resolved = checkNpmAnswer(spec, answer);
    copy.args = args.map((a, i) => (i === at ? `${name}@${resolved.version}` : a));
    // Recorded for the owner; nothing checks it yet.
    copy.npx_integrity = resolved.integrity;
    return { entry: copy, pinned: true };
  }

  if (read.launcher === "uvx") {
    const ref = read.from;
    if (ref !== null) {
      if (!isPinnedRef(ref)) throw new PinRefused(`${ref}: pin --from to a full commit or name==version`);
      return { entry: copy, pinned: true };
    }
    const spec = read.spec;
    if (spec === null) return { entry: copy, pinned: false };
    const at = read.specIndex;
    const pair = splitEquals(spec);
    if (pair) {
      if (!NAME_RE.test(pair.name) || !PYPI_VERSION_RE.test(pair.version)) {
        throw new PinRefused(`${spec}: pin the tool to name==version`);
      }
      return { entry: copy, pinned: true };
    }
    if (!NAME_RE.test(spec)) throw new PinRefused(`${spec}: pin the tool to name==version`);
    const lookup = typeof pypiVersion === "function" ? pypiVersion : defaultPypiVersion;
    let version;
    try {
      version = await lookup(spec);
    } catch (err) {
      throw new PinRefused(`${spec}: the version could not be looked up (${err?.message || err})`);
    }
    if (typeof version !== "string" || !PYPI_VERSION_RE.test(version)) {
      throw new PinRefused(`${spec}: the package index named no exact version`);
    }
    copy.args = args.map((a, i) => (i === at ? `${spec}==${version}` : a));
    return { entry: copy, pinned: true };
  }

  return { entry: copy, pinned: false };
}

/**
 * The install-time gate: pin only on a host whose walls are on.
 *
 * The gate is read FIRST: with `CROW_ADDON_WALLS_DEFAULT` unset (or `off`) or
 * the kill switch set, the entry is returned exactly as it was and no resolver
 * runs at all.
 *
 * @param {object} entry  the entry `mcpAddonEntryFor` built
 * @param {object} [o]
 * @param {object} [o.env]  the GATEWAY's env (never a bundle .env)
 * @param {Function} [o.pin] a `pinLauncherArgs` seam
 * @returns {Promise<object>} the entry to write
 * @throws {PinRefused}
 */
export async function pinEntryIfWalled(entry, { env = process.env, pin } = {}) {
  if (!wallsOnForHost(env)) return entry;
  const run = typeof pin === "function" ? pin : pinLauncherArgs;
  const out = await run(entry);
  return out && out.entry && typeof out.entry === "object" ? out.entry : entry;
}