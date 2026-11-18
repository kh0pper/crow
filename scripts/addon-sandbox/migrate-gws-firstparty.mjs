/**
 * Google Workspace: move an add-on onto the first-party bundle (PR-2 of the
 * first-party plan; the wall window is a later PR and is NOT done here).
 *
 * The install this exists for predates `bundles/google-workspace` in the repo.
 * Its launch entry in `<CROW_HOME>/mcp-addons.json` is still the old one
 * (a `uvx --from git+https://…@<40-hex sha>`), and its installed folder is only
 * the stub manifest `migrate-linked` leaves behind (`version: "0.0.0-local"`,
 * one `sandbox.files.oauthDir` line, nothing else) with no installed.json
 * record. The repo now ships the bundle's own code, run with `uv run` from the
 * installed copy — exactly what the Extensions install path produces.
 *
 * What one run does, in this order (nothing at all is written before step b):
 *
 *   a. reads and checks everything, and changes NOTHING if any check fails;
 *   b. backs up, inside `<crowHome>/addon-walls-migrate/google-workspace-<stamp>/`:
 *      `backup.json` (the whole entry, and the byte-for-byte text + mode of
 *      mcp-addons.json and installed.json), and copies the installed folder
 *      aside to `<crowHome>/bundles/google-workspace.pre-firstparty-<stamp>`;
 *   c. copies the repo bundle into `<crowHome>/bundles/google-workspace` the way
 *      an install does — `snapshotInstallDir` (routes/bundles.js:2499, the
 *      install's own pre-copy snapshot + rollback) followed by the identical
 *      `cpSync(bundleSource, destDir, { recursive: true })` (routes/bundles.js:3686);
 *   d. adds the installed.json record the way an install does, through
 *      `writeInstalled` (bundle-core.js:97 — the install path's own writer);
 *   e. rewrites the entry: `command` = the absolute `uv`, `args` = the repo
 *      manifest's `server.args`, `command_sha256` recomputed with the shared
 *      `launcherPin` (servers/shared/resolve-command.js:197 — the gateway checks
 *      the same pin with `resolveAddonCommand`, :126), the entry's own env
 *      unchanged plus
 *      `UV_NO_CACHE=1` and `UV_PROJECT_ENVIRONMENT=<data>/google-workspace/.venv`
 *      (the same `<data>/<id>` folder the wall hands the add-on), and an
 *      `ownerSet` naming the values the owner typed;
 *   f. writes `written.json` (what it wrote) LAST, so `--undo` can prove the
 *      state is still the one this migration produced.
 *
 * It deliberately does NOT: turn the outbound guard on, set GWS_FILES_DIR,
 * raise the wall, change `addon-walls.json`, or touch the data folder beyond
 * making it. Those belong to the wall window. It also never runs
 * `migrate-linked --undo google-workspace` and never creates a symlink into the
 * tracked checkout.
 *
 * `--undo [<stamp>]` (no stamp = the newest live backup) puts back the entry,
 * the installed folder (byte-for-byte, from the folder copy) and installed.json
 * (byte-for-byte, from the recorded text). It refuses unless the current state
 * is still exactly what the migration wrote — the whole file texts and the
 * installed copy's manifest must be unchanged — and `--force` restores anyway
 * (surgically: the entry key and this add-on's installed.json record only, so
 * another add-on's later change is never clobbered). A consumed backup is
 * renamed `<name>.undone` and never deleted; neither is the folder copy.
 *
 * Exit codes:
 *   0  done: migrated, already migrated (no-op), --dry-run printed, or restored
 *   1  refused or failed before/while changing anything — the home is as it was
 *      (a backup folder is kept only when a restore step itself failed)
 *   2  usage
 *   3  --undo refused: the home changed since the migration (nothing done; add
 *      --force to restore anyway)
 *
 * CLI: node scripts/addon-sandbox/migrate-gws-firstparty.mjs
 *        [--dry-run | --undo [<stamp>] [--force]]
 * Reads CROW_HOME (default ~/.crow) and CROW_DATA_DIR (default <crowHome>/data)
 * and uses the checkout it sits in as the repo root.
 *
 * Design notes: the private engineering notes.
 */
import { createHash } from "node:crypto";
import {
  chmodSync, cpSync, lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launcherPin } from "../../servers/shared/resolve-command.js";
import { readInstalled, writeInstalled } from "../../servers/gateway/bundle-core.js";
import { legacyOwnerKeys } from "./profile.mjs";

/** The one add-on this migration owns. */
export const ADDON_ID = "google-workspace";

/** Where `migrate-linked` keeps its backups; one folder per run lives here. */
export const BACKUP_DIR = "addon-walls-migrate";

/** The version marker `migrate-linked`'s stub manifest carries. */
export const STUB_VERSION = "0.0.0-local";

/** The name `--undo`'s folder copy carries, relative to `<crowHome>/bundles`. */
export const STUB_COPY_RE = /^google-workspace\.pre-firstparty-\d{8}T\d{6}Z(?:-\d+)?$/;

/** The values the owner typed, claimed in `ownerSet` when the entry holds them. */
const OWNER_KEYS = ["GMAIL_SEND_TO_SELF_ALLOWLIST", "GOOGLE_CREDENTIALS_FILE", "GOOGLE_TOKEN_FILE"];

/**
 * The keys a LATER window writes (the outbound guard, the files folder). Only
 * ever claimed when the entry already carries them: this migration adds no
 * value of its own, so it must not claim one either.
 */
const OPTIONAL_OWNER_KEYS = ["GWS_FILES_DIR", "GWS_OUTBOUND_ALLOWLIST", "GWS_OUTBOUND_GUARD"];

/** The two the entry must already carry a value for before anything is touched. */
const REQUIRED_ENV_KEYS = ["GOOGLE_CREDENTIALS_FILE", "GOOGLE_TOKEN_FILE"];

const BACKUP_RE = /^google-workspace-(\d{8}T\d{6}Z)(?:-(\d+))?$/;

const deepCopy = (v) => JSON.parse(JSON.stringify(v));

function lexists(p) {
  try { lstatSync(p); return true; } catch { return false; }
}

/** A regular file this user may execute — the only thing that counts as a launcher. */
function isExecutableFile(p) {
  try {
    const st = statSync(p);
    return st.isFile() && (st.mode & 0o111) !== 0;
  } catch { return false; }
}

function readTextOrNull(p) {
  try { return readFileSync(p, "utf8"); } catch { return null; }
}

function parseJsonOrNull(text) {
  if (typeof text !== "string" || text === "") return null;
  try { return JSON.parse(text); } catch { return null; }
}

function sha256OfFile(p) {
  try { return createHash("sha256").update(readFileSync(p)).digest("hex"); } catch { return null; }
}

function modeOrNull(p) {
  try { return statSync(p).mode & 0o777; } catch { return null; }
}

/** UTC `YYYYMMDDTHHMMSSZ`, the stamp every name a run writes carries. */
function utcStamp(date) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}`
    + `T${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`;
}

/** A temp file in the same folder, then a rename: no reader ever sees half a file. */
function writeAtomicPrivate(path, text, mode = 0o600) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${Date.now().toString(36)}`);
  try {
    writeFileSync(tmp, text, { mode, flag: "wx" });
    chmodSync(tmp, mode);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/** `base` when free in `dir`, else `base-2`, `base-3` … */
function freeName(dir, base) {
  if (!lexists(join(dir, base))) return base;
  for (let n = 2; n < 1000; n++) {
    const name = `${base}-${n}`;
    if (!lexists(join(dir, name))) return name;
  }
  throw new Error(`no free name for ${base} in ${dir}`);
}

// ── the legacy git pin ──────────────────────────────────────────────────────

/**
 * The `--from git+…@<40 hex>` ref an entry pins, or null. The same reading
 * `migrate-linked` applies (`isGitUvxStub`), so the two agree on what "the
 * legacy shape" means.
 */
export function gitRefOf(args) {
  const list = Array.isArray(args) ? args.map(String) : [];
  for (let i = 0; i < list.length; i++) {
    const arg = list[i];
    const ref = arg.startsWith("--from=") ? arg.slice(7) : (arg === "--from" ? list[i + 1] || "" : "");
    if (/^git\+.+@[0-9a-f]{40}$/i.test(ref)) return ref;
  }
  return null;
}

/**
 * Which launch shape an entry has:
 *   "legacy"   the old `uvx --from git+…@<sha>` install this migration rewrites;
 *   "migrated" the shape step e writes (`<abs>/uv run …`), so a second run is a no-op;
 *   "http" / "satellite" / "cwd" / "other" — none of them this migration's business.
 */
export function entryShape(entry) {
  if (!entry || typeof entry !== "object" || Array.isArray(entry)) return "other";
  if (entry.url) return "http";
  if (entry.satellite !== undefined) return "satellite";
  if (String(entry.transport || "stdio").toLowerCase() === "http") return "http";
  // Neither shape has a `cwd`: the installed copy is the folder the gateway runs
  // from (proxy.js: `config.cwd || <crowHome>/bundles/<id>`).
  if (entry.cwd !== undefined) return "cwd";
  const command = typeof entry.command === "string" ? entry.command : "";
  const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
  if (basename(command) === "uvx" && gitRefOf(args) !== null) return "legacy";
  if (isAbsolute(command) && basename(command) === "uv" && args[0] === "run"
    && !args.some((a) => a === "--from" || a.startsWith("--from=") || /^git\+/.test(a))) return "migrated";
  return "other";
}

// ── uv ──────────────────────────────────────────────────────────────────────

/**
 * The absolute `uv` a migrated entry launches. In order: an explicitly given
 * path (the tests' seam), `uv` next to the entry's own launcher (the real
 * installs' `~/.local/bin/uvx` sits beside `~/.local/bin/uv`), then PATH. Node
 * built-ins only: this runs before anything is written, and a missing uv is a
 * refusal, not a search that silently picks something else.
 */
export function resolveUvPath({ entry, uvPath = null, env = process.env } = {}) {
  if (typeof uvPath === "string" && uvPath !== "") {
    if (!isAbsolute(uvPath)) return { error: `${uvPath} is not an absolute path` };
    if (!isExecutableFile(uvPath)) return { error: `${uvPath} is not an executable file` };
    return { path: uvPath, from: "the given path" };
  }
  const command = typeof entry?.command === "string" ? entry.command : "";
  if (isAbsolute(command)) {
    const sibling = join(dirname(command), "uv");
    if (isExecutableFile(sibling)) return { path: sibling, from: "next to the entry's launcher" };
  }
  for (const dir of String(env?.PATH || "").split(":").filter(Boolean)) {
    const p = join(dir, "uv");
    if (isExecutableFile(p)) return { path: p, from: "PATH" };
  }
  return { error: "uv was not found next to the entry's launcher or on PATH — install uv first, then run this again" };
}

// ── installed.json ──────────────────────────────────────────────────────────

/** installed.json's entries, refusing a file that exists but cannot be read. */
function readInstalledStrict(path) {
  const text = readTextOrNull(path);
  if (text === null) return { existed: false, text: null, entries: [] };
  const parsed = parseJsonOrNull(text);
  if (parsed === null) return { existed: true, text, entries: null, error: `${path} exists but cannot be read` };
  const entries = readInstalled(path);
  return { existed: true, text, entries };
}

// ── the runner's own provenance rule ────────────────────────────────────────

/**
 * Every `env_vars[].default` any committed manifest of `id` has shipped
 * (registry/addon-past-defaults.json — the same file routes/bundles.js reads),
 * or {} when there is none. A value equal to a shipped default is not the
 * owner's, so this is what keeps `ownerSet` honest.
 */
function pastDefaultsFor(id) {
  try {
    const doc = JSON.parse(readFileSync(new URL("../../registry/addon-past-defaults.json", import.meta.url), "utf8"));
    const defaults = doc && typeof doc === "object" ? doc.defaults : null;
    if (!defaults || typeof defaults !== "object") return {};
    const own = defaults[id];
    return own && typeof own === "object" ? own : {};
  } catch { return {}; }
}

/**
 * The `ownerSet` a migrated entry carries: the named owner values it holds, the
 * later-window keys it already holds, and everything the LEGACY rule
 * (`legacyOwnerKeys`, scripts/addon-sandbox/profile.mjs) already counted as the
 * owner's own — so the wall reads this entry's provenance exactly as it did
 * before the migration. Sorted and unique, like an install's.
 */
export function ownerSetFor(priorEnv, repoManifest, id = ADDON_ID) {
  const env = priorEnv && typeof priorEnv === "object" ? priorEnv : {};
  const claims = new Set();
  for (const key of [...OWNER_KEYS, ...OPTIONAL_OWNER_KEYS]) {
    if (Object.hasOwn(env, key)) claims.add(key);
  }
  for (const key of legacyOwnerKeys(env, repoManifest, pastDefaultsFor(id))) claims.add(key);
  return [...claims].sort();
}

// ── reading the state, changing nothing ─────────────────────────────────────

const refuse = (reason) => ({ ok: false, reason });

/**
 * Everything one run needs, read and checked. Returns `{ ok: false, reason }`
 * with a sentence for the operator when a precondition does not hold — in which
 * case the caller changes nothing at all.
 */
export function inspectGwsAddon({
  crowHome, repoRoot, dataDir = null, mcpAddonsPath = null, installedPath = null,
  uvPath = null, env = process.env,
} = {}) {
  if (typeof crowHome !== "string" || crowHome === "") return refuse("no Crow home given");
  if (typeof repoRoot !== "string" || repoRoot === "") return refuse("no repo root given");

  const addonsPath = mcpAddonsPath || join(crowHome, "mcp-addons.json");
  const installedJsonPath = installedPath || join(crowHome, "installed.json");
  const dataRoot = dataDir || env.CROW_DATA_DIR || join(crowHome, "data");
  const destDir = join(crowHome, "bundles", ADDON_ID);
  const bundleDir = join(repoRoot, "bundles", ADDON_ID);

  // 1. The repo bundle: it must be there, and it must be this add-on's.
  const repoManifestText = readTextOrNull(join(bundleDir, "manifest.json"));
  if (repoManifestText === null) {
    return refuse(`the checkout ships no bundles/${ADDON_ID}/manifest.json (repo root ${repoRoot}); nothing done`);
  }
  const repoManifest = parseJsonOrNull(repoManifestText);
  if (!repoManifest || repoManifest.id !== ADDON_ID) {
    return refuse(`bundles/${ADDON_ID}/manifest.json is not a readable manifest for ${ADDON_ID}; nothing done`);
  }
  const serverArgs = repoManifest?.server?.args;
  if (typeof repoManifest?.server?.command !== "string" || !Array.isArray(serverArgs) || serverArgs.length === 0) {
    return refuse(`bundles/${ADDON_ID}/manifest.json declares no server command/args; nothing done`);
  }

  // 2. The launch entry.
  const addonsText = readTextOrNull(addonsPath);
  if (addonsText === null) return refuse(`${addonsPath} does not exist; there is nothing to migrate`);
  const addonsDoc = parseJsonOrNull(addonsText);
  if (!addonsDoc || typeof addonsDoc !== "object" || Array.isArray(addonsDoc)) {
    return refuse(`${addonsPath} is not a JSON object; nothing done`);
  }
  if (!Object.hasOwn(addonsDoc, ADDON_ID)) {
    return refuse(`${addonsPath} has no ${ADDON_ID} entry; there is nothing to migrate`);
  }
  const entry = addonsDoc[ADDON_ID];
  const shape = entryShape(entry);
  if (shape !== "legacy" && shape !== "migrated") {
    return refuse(`the ${ADDON_ID} entry is not the legacy uvx/git+ shape or the migrated one (${shape}); nothing done`);
  }
  const entryEnv = entry.env && typeof entry.env === "object" && !Array.isArray(entry.env) ? entry.env : {};
  for (const key of REQUIRED_ENV_KEYS) {
    if (typeof entryEnv[key] !== "string" || entryEnv[key] === "") {
      return refuse(`the ${ADDON_ID} entry has no ${key}; nothing done (set it in Extensions and run this again)`);
    }
  }

  // 3. installed.json: absent is fine, unreadable is not.
  const installedState = readInstalledStrict(installedJsonPath);
  if (installedState.entries === null) return refuse(`${installedState.error}; nothing done`);
  const priorRecord = installedState.entries.find((r) => r && typeof r === "object" && r.id === ADDON_ID) || null;

  // 4. The installed folder: the stub migrate-linked leaves, or Crow's copy already.
  let copyState = "other";
  let installedManifestText = null;
  let installedManifest = null;
  if (lexists(destDir) && !lstatSync(destDir).isSymbolicLink() && lstatSync(destDir).isDirectory()) {
    installedManifestText = readTextOrNull(join(destDir, "manifest.json"));
    installedManifest = parseJsonOrNull(installedManifestText || "");
    if (installedManifest && installedManifest.version === STUB_VERSION) copyState = "stub";
    else if (installedManifestText !== null && installedManifestText === repoManifestText) copyState = "repo";
  }
  if (copyState === "other") {
    return refuse(`${destDir} is neither the ${STUB_VERSION} stub nor Crow's own copy of the bundle; nothing done`
      + (lexists(destDir) ? "" : " (there is no such folder)"));
  }

  // 5. uv, absolute and executable. Only a rewrite needs it: an entry that is already
  //    migrated is a no-op whether or not its launcher still resolves (that is a
  //    different problem, and it is reported as a note, not a refusal).
  const uv = resolveUvPath({ entry, uvPath, env });
  if (uv.error && shape === "legacy") return refuse(`${uv.error}; nothing done`);

  return {
    ok: true,
    crowHome,
    addonsPath, installedJsonPath, dataRoot, destDir, bundleDir,
    addonsText, addonsDoc, addonsMode: modeOrNull(addonsPath),
    entry, shape, entryEnv,
    installed: installedState.entries, installedText: installedState.text,
    installedExisted: installedState.existed, installedMode: modeOrNull(installedJsonPath),
    priorRecord, copyState, installedManifestText, installedManifest,
    repoManifest, repoManifestText, repoArgs: serverArgs.map(String),
    uv: uv.path ?? null, uvFrom: uv.from ?? null, uvError: uv.error ?? null,
  };
}

/**
 * The installed.json record an install writes for this bundle. An existing
 * record's install stamp is kept (this is not a reinstall), and its version and
 * type follow the repo manifest.
 */
export function installedRecordFor({ installed = [], repoManifest, at }) {
  const prior = (Array.isArray(installed) ? installed : [])
    .find((r) => r && typeof r === "object" && r.id === ADDON_ID) || null;
  const kept = prior && (prior.installedAt || prior.installed_at);
  return {
    id: ADDON_ID,
    type: (prior && prior.type) || repoManifest?.type || "bundle",
    version: repoManifest?.version,
    installedAt: typeof kept === "string" && kept !== "" ? kept : at,
  };
}

/**
 * The entry step e writes: the same entry, launched from the installed copy by
 * `uv run`, with the same env values plus the two uv settings, and the pin
 * recomputed with the shared `launcherPin` (nothing is ever re-hashed here).
 */
export function nextEntryFor({ entry, uv, args, destDir, dataRoot, repoManifest }) {
  const next = deepCopy(entry);
  next.command = uv;
  next.args = [...args];
  // A root-owned uv needs no pin (launcherPin says so by returning null); a
  // user-owned one does, and the gateway re-hashes it at every spawn.
  const pin = launcherPin(uv, destDir);
  if (pin) next.command_sha256 = pin;
  else delete next.command_sha256;
  const env = { ...(entry.env && typeof entry.env === "object" && !Array.isArray(entry.env) ? entry.env : {}) };
  env.UV_NO_CACHE = "1";
  // The same `<data>/<id>` folder the wall hands this add-on at spawn
  // (proxy.js: `join(resolveDataDir(), id)`, migrate-linked's envDir).
  env.UV_PROJECT_ENVIRONMENT = join(dataRoot, ADDON_ID, ".venv");
  next.env = env;
  next.ownerSet = ownerSetFor(entry.env, repoManifest);
  return next;
}

// ── the plan a --dry-run prints ─────────────────────────────────────────────

function planLines({ crowHome, state, stamp, at }) {
  const { destDir, bundleDir, dataRoot, entry, repoManifest, repoArgs, uv, uvFrom } = state;
  const next = nextEntryFor({
    entry, uv, args: repoArgs, destDir, dataRoot, repoManifest,
  });
  const record = installedRecordFor({ installed: state.installed, repoManifest, at });
  return [
    `[gws-firstparty] plan (dry run — nothing is written):`,
    `  1. back up -> ${join(crowHome, BACKUP_DIR, `${ADDON_ID}-${stamp}`)}/ (the entry, mcp-addons.json and installed.json texts)`,
    `     and the installed folder -> ${join(crowHome, "bundles", `${ADDON_ID}.pre-firstparty-${stamp}`)}`,
    `  2. copy ${bundleDir} -> ${destDir} (version ${repoManifest.version ?? "(none)"}, the install's own copy)`,
    `  3. installed.json += ${JSON.stringify(record)}`,
    `  4. mcp-addons.json entry ${ADDON_ID}:`,
    `     command: ${next.command}   (uv from ${uvFrom})`,
    `     args:    ${JSON.stringify(next.args)}`,
    `     command_sha256: ${next.command_sha256 ?? "(none: root-owned launcher)"}`,
    `     env:     ${JSON.stringify(next.env)}`,
    `     ownerSet: ${JSON.stringify(next.ownerSet)}`,
    `  unchanged: the wall mode, GWS_FILES_DIR, GWS_OUTBOUND_GUARD/ALLOWLIST, the token files`,
    `  undo:     node scripts/addon-sandbox/migrate-gws-firstparty.mjs --undo ${stamp}`,
  ];
}

// ── the migration ───────────────────────────────────────────────────────────

/**
 * Run the migration. `--dry-run` is `dryRun: true`: it prints the plan and
 * writes nothing. Every refusal and every failure leaves the Crow home as it
 * was (a backup folder survives only when a restore step itself failed).
 *
 * @returns {{status: "migrated"|"already-migrated"|"dry-run"|"refused"|"failed",
 *            reason?: string, notes?: string[], stamp?: string, backupDir?: string,
 *            next?: object, record?: object, lines?: string[]}}
 */
export async function migrateGwsFirstparty({
  crowHome, repoRoot, dataDir = null, mcpAddonsPath = null, installedPath = null,
  uvPath = null, env = process.env, now = () => new Date(), dryRun = false, log = console.log,
} = {}) {
  const state = inspectGwsAddon({ crowHome, repoRoot, dataDir, mcpAddonsPath, installedPath, uvPath, env });
  if (!state.ok) return { status: "refused", reason: state.reason };

  const when = now();
  const stamp = utcStamp(when);
  const at = new Date(when).toISOString();

  // A migrated entry is the whole job: this is the idempotent no-op (`--dry-run`
  // included — there is nothing to preview).
  if (state.shape === "migrated") {
    const notes = [];
    if (state.copyState !== "repo") notes.push("the installed folder is not Crow's copy yet");
    if (!state.priorRecord) notes.push("installed.json has no record for it");
    if (state.uv) {
      const want = nextEntryFor({
        entry: state.entry, uv: state.uv, args: state.repoArgs,
        destDir: state.destDir, dataRoot: state.dataRoot, repoManifest: state.repoManifest,
      });
      if (state.entry.command !== want.command || JSON.stringify(state.entry.args) !== JSON.stringify(want.args)) {
        notes.push("its launch command/args differ from the repo manifest's");
      }
    } else {
      notes.push(`its uv launcher does not resolve (${state.uvError})`);
    }
    log(`[gws-firstparty] ${ADDON_ID}: already migrated (its entry launches ${basename(state.entry.command)} ${JSON.stringify(state.entry.args)}); nothing done`);
    for (const note of notes) log(`  note: ${note}`);
    return { status: "already-migrated", stamp: null, notes, next: state.entry };
  }

  const next = nextEntryFor({
    entry: state.entry, uv: state.uv, args: state.repoArgs,
    destDir: state.destDir, dataRoot: state.dataRoot, repoManifest: state.repoManifest,
  });
  const record = installedRecordFor({ installed: state.installed, repoManifest: state.repoManifest, at });

  const lines = planLines({ crowHome, state, stamp, at });
  if (dryRun) {
    for (const line of lines) log(line);
    return { status: "dry-run", stamp, lines, next, record };
  }

  const result = await applyMigration({ crowHome: state.crowHome, state, next, record, stamp, at, log });
  for (const line of result.lines || []) log(line);
  return result;
}

/** Steps b-f of one run, with a rollback that puts everything back on any failure. */
async function applyMigration({ crowHome, state, next, record, stamp, at, log }) {
  const {
    addonsPath, installedJsonPath, dataRoot, destDir, bundleDir,
    addonsMode, installedMode, installedExisted,
  } = state;
  const bundlesDir = join(crowHome, "bundles");
  const backupRoot = join(crowHome, BACKUP_DIR);
  const backupDir = join(backupRoot, freeName(backupRoot, `${ADDON_ID}-${stamp}`));
  const stubCopyName = freeName(bundlesDir, `${ADDON_ID}.pre-firstparty-${stamp}`);
  const stubCopyPath = join(bundlesDir, stubCopyName);

  const undoState = {
    backupDir: false, stubCopy: false,
    addonsWritten: null, installedWritten: null,
  };
  let snap = null;

  const putBack = () => {
    const problems = [];
    // 1. the installed folder, through the install path's own snapshot rollback.
    if (snap) { try { snap.settle(); } catch (err) { problems.push(`the installed folder: ${err?.message || err}`); } }
    // 2. installed.json, only when the bytes on disk are still ours.
    if (undoState.installedWritten !== null) {
      try {
        const now = readTextOrNull(installedJsonPath);
        if (now === undoState.installedWritten) {
          if (installedExisted) writeAtomicPrivate(installedJsonPath, state.installedText, installedMode ?? 0o600);
          else rmSync(installedJsonPath, { force: true });
        } else problems.push("installed.json (changed again while this ran; left as it is)");
      } catch (err) { problems.push(`installed.json: ${err?.message || err}`); }
    }
    // 3. mcp-addons.json, the same way.
    if (undoState.addonsWritten !== null) {
      try {
        const now = readTextOrNull(addonsPath);
        if (now === undoState.addonsWritten) writeAtomicPrivate(addonsPath, state.addonsText, addonsMode ?? 0o600);
        else problems.push("mcp-addons.json (changed again while this ran; left as it is)");
      } catch (err) { problems.push(`mcp-addons.json: ${err?.message || err}`); }
    }
    // 4. what this attempt created: the folder copy and the backup, when nothing
    //    is left to restore from them.
    if (problems.length === 0) {
      if (undoState.stubCopy) { try { rmSync(stubCopyPath, { recursive: true, force: true }); } catch { /* reported below */ } }
      if (undoState.backupDir) { try { rmSync(backupDir, { recursive: true, force: true }); } catch { /* reported below */ } }
    }
    return problems;
  };

  try {
    // b. The backup, before a single thing changes.
    mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    undoState.backupDir = true;
    try { chmodSync(backupDir, 0o700); } catch { /* just made */ }
    cpSync(destDir, stubCopyPath, { recursive: true, verbatimSymlinks: true });
    undoState.stubCopy = true;
    writeAtomicPrivate(join(backupDir, "backup.json"), `${JSON.stringify({
      v: 1,
      id: ADDON_ID,
      kind: "gws-firstparty",
      at,
      stamp,
      entry: deepCopy(state.entry),
      stubName: stubCopyName,
      repo: { root: state.bundleDir, version: state.repoManifest?.version ?? null, manifestSha: sha256OfFile(join(bundleDir, "manifest.json")) },
      addons: { path: addonsPath, text: state.addonsText, mode: addonsMode },
      installed: { path: installedJsonPath, text: state.installedText, existed: installedExisted, mode: installedMode },
    }, null, 2)}\n`);

    // c. The copy, exactly the install path's two steps (routes/bundles.js:3684-3686)
    //    — the pre-copy snapshot (its `settle()` is the rollback) and the copy.
    const { snapshotInstallDir } = await import("../../servers/gateway/routes/bundles.js");
    snap = snapshotInstallDir(bundleDir, destDir, { backupRoot: join(backupDir, "install-rollback") });
    mkdirSync(destDir, { recursive: true });
    cpSync(bundleDir, destDir, { recursive: true });

    // d. installed.json, through the install path's own writer.
    const freshState = readInstalledStrict(installedJsonPath);
    if (freshState.entries === null) throw new Error(`${installedJsonPath} changed while this ran and can no longer be read`);
    const arr = freshState.entries.filter((r) => !(r && typeof r === "object" && r.id === ADDON_ID)).concat([record]);
    writeInstalled(installedJsonPath, arr);
    // The writer's own temp file carries the umask's mode; keep the file's own.
    try { chmodSync(installedJsonPath, installedMode ?? 0o600); } catch { /* the boot pass tightens it */ }
    undoState.installedWritten = JSON.stringify(arr, null, 2);

    // e. the data folder the entry's UV_PROJECT_ENVIRONMENT lives in (the same
    //    `<data>/<id>` the wall binds), then the entry itself.
    mkdirSync(join(dataRoot, ADDON_ID), { recursive: true, mode: 0o700 });

    const freshDoc = parseJsonOrNull(readTextOrNull(addonsPath) || "");
    if (!freshDoc || typeof freshDoc !== "object" || Array.isArray(freshDoc)) {
      throw new Error(`${addonsPath} changed while this ran and can no longer be read`);
    }
    const doc = { ...freshDoc, [ADDON_ID]: next };
    const addonsText = JSON.stringify(doc, null, 2);
    // 0600 in every case (the file can hold plain secret values on a legacy install);
    // the original mode is in the backup, and --undo puts it back.
    writeAtomicPrivate(addonsPath, addonsText, 0o600);
    undoState.addonsWritten = addonsText;

    // f. What it wrote, LAST: `--undo` refuses without it.
    writeAtomicPrivate(join(backupDir, "written.json"), `${JSON.stringify({
      at,
      entry: deepCopy(next),
      installedRecord: record,
      addonsText,
      installedText: undoState.installedWritten,
      bundleManifestSha: sha256OfFile(join(destDir, "manifest.json")),
    }, null, 2)}\n`);

    // The pre-copy snapshot is committed, so the copy stays; the temp folder the
    // install path made for it goes with it.
    try { snap.commit(); } catch { /* a leftover snapshot never fails the run */ }
    rmSync(join(backupDir, "install-rollback"), { recursive: true, force: true });
  } catch (err) {
    const problems = putBack();
    const reason = String(err?.message || err).slice(0, 300);
    if (problems.length > 0) {
      log(`[gws-firstparty] ${ADDON_ID}: ${reason}; could not put everything back: ${problems.join("; ")}`
        + ` — its backup is kept at ${backupDir} for --undo`);
      return { status: "failed", reason, problems, backupDir };
    }
    return { status: "failed", reason };
  }

  return {
    status: "migrated",
    stamp,
    backupDir,
    stubCopy: stubCopyPath,
    next,
    record,
    lines: [
      `[gws-firstparty] ${ADDON_ID}: moved onto the first-party bundle (version ${state.repoManifest?.version ?? "?"})`,
      `  installed folder: ${destDir} (the ${STUB_VERSION} stub is kept at ${stubCopyName})`,
      `  installed.json:   ${JSON.stringify(record)}`,
      `  entry:            command ${next.command}, args ${JSON.stringify(next.args)}, ${next.command_sha256 ? `pinned ${next.command_sha256}` : "no pin needed (root-owned launcher)"}`,
      `  env:              kept ${Object.keys(state.entryEnv).length} value(s); added UV_NO_CACHE and UV_PROJECT_ENVIRONMENT`,
      `  ownerSet:         ${JSON.stringify(next.ownerSet)}`,
      `  unchanged:        wall mode, GWS_FILES_DIR, the outbound guard, your token files (the wall window's job)`,
      `  backup:           ${backupDir}`,
      `  undo:             node scripts/addon-sandbox/migrate-gws-firstparty.mjs --undo ${stamp}`,
    ],
  };
}

// ── undo ────────────────────────────────────────────────────────────────────

/** Live backups of this add-on, newest first (a consumed one is named `.undone`). */
function liveBackups(crowHome) {
  const root = join(crowHome, BACKUP_DIR);
  let names = [];
  try { names = readdirSync(root); } catch { return []; }
  const out = [];
  for (const name of names) {
    const m = BACKUP_RE.exec(name);
    if (!m) continue;
    const dir = join(root, name);
    let isDir = false;
    try { isDir = lstatSync(dir).isDirectory() && !lstatSync(dir).isSymbolicLink(); } catch { isDir = false; }
    if (!isDir) continue;
    out.push({ stamp: m[1], suffix: m[2] ? Number(m[2]) : 0, name, dir });
  }
  out.sort((a, b) => (a.stamp === b.stamp ? b.suffix - a.suffix : (a.stamp < b.stamp ? 1 : -1)));
  return out;
}

/**
 * Undo one run: put the entry, the installed folder and installed.json back
 * exactly as the backup recorded them. Never deletes the backup (it is renamed
 * `<name>.undone`) and never deletes the folder copy.
 *
 * Without `force` it refuses unless the home is still exactly what the
 * migration wrote: both files' bytes and the installed copy's manifest must be
 * the ones `written.json` names. With `force` it restores anyway, surgically for
 * a file that changed (this add-on's key / record only) so a later change to
 * another add-on is never clobbered.
 *
 * @returns {{status: "restored"|"refused"|"no-backup", reason?: string, diffs?: string[],
 *            restored?: string[], problems?: string[], backupDir?: string}}
 */
export async function undoGwsFirstparty({
  crowHome, stamp = null, force = false, mcpAddonsPath = null, installedPath = null, log = console.log,
} = {}) {
  if (typeof crowHome !== "string" || crowHome === "") return { status: "refused", reason: "no Crow home given" };
  const addonsPath = mcpAddonsPath || join(crowHome, "mcp-addons.json");
  const installedJsonPath = installedPath || join(crowHome, "installed.json");
  const backups = liveBackups(crowHome);
  const picked = stamp ? backups.find((b) => b.stamp === String(stamp)) : backups[0];
  if (!picked) {
    return { status: "no-backup", reason: stamp ? `no live backup for ${stamp}` : "there is no live backup to undo" };
  }
  const backupDir = picked.dir;
  const backup = parseJsonOrNull(readTextOrNull(join(backupDir, "backup.json")) || "");
  if (!backup || backup.id !== ADDON_ID) {
    return { status: "refused", backupDir, reason: `the backup record in ${backupDir} is missing or not ${ADDON_ID}'s; nothing done` };
  }
  const written = parseJsonOrNull(readTextOrNull(join(backupDir, "written.json")) || "");

  const destDir = join(crowHome, "bundles", ADDON_ID);
  const currentAddons = readTextOrNull(addonsPath);
  const currentInstalled = readTextOrNull(installedJsonPath);
  const currentManifestSha = sha256OfFile(join(destDir, "manifest.json"));

  const diffs = [];
  if (!written) diffs.push("the run's own record of what it wrote (written.json) is missing");
  else {
    if (currentAddons !== written.addonsText) diffs.push("mcp-addons.json is not what the migration wrote");
    if ((currentInstalled ?? null) !== (written.installedText ?? null)) diffs.push("installed.json is not what the migration wrote");
    if (currentManifestSha !== written.bundleManifestSha) diffs.push("the installed copy is not what the migration wrote");
  }
  if (diffs.length > 0 && !force) {
    return {
      status: "refused",
      backupDir,
      diffs,
      reason: `${diffs.join("; ")} — nothing done (re-run with --force to restore anyway)`,
    };
  }

  const restored = [];
  const problems = [];

  // 1. The installed folder, byte-for-byte from the copy taken before the migration.
  if (typeof backup.stubName === "string" && backup.stubName !== "") {
    if (!STUB_COPY_RE.test(backup.stubName)) {
      problems.push("the backup names an installed-folder copy this migration would not write");
    } else {
      const from = join(crowHome, "bundles", backup.stubName);
      if (!lexists(from)) problems.push(`the backed-up installed folder (${backup.stubName}) is gone`);
      else {
        rmSync(destDir, { recursive: true, force: true });
        cpSync(from, destDir, { recursive: true, verbatimSymlinks: true });
        restored.push("the installed folder");
      }
    }
  }

  // 2. mcp-addons.json: the recorded bytes when nothing has changed, else (forced) the key only.
  const wholeFile = typeof written?.addonsText === "string" && currentAddons === written.addonsText;
  try {
    if (wholeFile && typeof backup.addons?.text === "string") {
      writeAtomicPrivate(addonsPath, backup.addons.text, backup.addons.mode ?? 0o600);
      restored.push("mcp-addons.json (byte-for-byte)");
    } else {
      const doc = parseJsonOrNull(currentAddons || "");
      if (!doc || typeof doc !== "object" || Array.isArray(doc)) throw new Error("mcp-addons.json cannot be read");
      if (backup.entry && typeof backup.entry === "object") doc[ADDON_ID] = deepCopy(backup.entry);
      else delete doc[ADDON_ID];
      writeAtomicPrivate(addonsPath, JSON.stringify(doc, null, 2), backup.addons?.mode ?? 0o600);
      restored.push("mcp-addons.json (its entry, the rest of the file kept)");
    }
  } catch (err) {
    problems.push(`mcp-addons.json: ${err?.message || err}`);
  }

  // 3. installed.json: the recorded bytes when nothing has changed, else (forced) this record only.
  const installedWhole = (currentInstalled ?? null) === (written?.installedText ?? null) && !!written;
  try {
    if (installedWhole) {
      if (backup.installed?.existed) writeAtomicPrivate(installedJsonPath, backup.installed.text, backup.installed.mode ?? 0o600);
      else rmSync(installedJsonPath, { force: true });
      restored.push("installed.json (byte-for-byte)");
    } else {
      const arr = readInstalled(installedJsonPath).filter((r) => !(r && typeof r === "object" && r.id === ADDON_ID));
      if (arr.length > 0 || lexists(installedJsonPath)) writeInstalled(installedJsonPath, arr);
      restored.push("installed.json (its record removed, the rest of the file kept)");
    }
  } catch (err) {
    problems.push(`installed.json: ${err?.message || err}`);
  }

  if (problems.length > 0) {
    log(`[gws-firstparty] ${ADDON_ID}: restored ${restored.join(", ") || "nothing"}; could not finish: ${problems.join("; ")}`);
    return { status: "refused", backupDir, diffs, restored, problems, reason: problems.join("; ") };
  }

  // The backup is consumed, never deleted.
  try { renameSync(backupDir, join(dirname(backupDir), freeName(dirname(backupDir), `${picked.name}.undone`))); }
  catch { /* it stays readable under its own name; a second undo then refuses on the state check */ }

  for (const line of [
    `[gws-firstparty] ${ADDON_ID}: restored (${restored.join(", ")})`,
    `  the backup stays at ${backupDir}.undone, and the folder copy at bundles/${backup.stubName ?? "(none)"}`,
    `  the data folder ${join(crowHome, "data", ADDON_ID)} is left alone (uv rebuilds its .venv)`,
  ]) log(line);
  return { status: "restored", backupDir, diffs, restored };
}

// ── CLI ─────────────────────────────────────────────────────────────────────

export const USAGE = "usage: node scripts/addon-sandbox/migrate-gws-firstparty.mjs"
  + " [--dry-run | --undo [<stamp>] [--force]]";

async function main(argv) {
  const undo = argv.includes("--undo");
  const dryRun = argv.includes("--dry-run");
  const force = argv.includes("--force");
  const rest = argv.filter((a) => a !== "--undo" && a !== "--dry-run" && a !== "--force");
  if (argv.includes("--help") || argv.includes("-h")) {
    console.log(USAGE);
    return 0;
  }
  if (dryRun && undo) {
    console.log(USAGE);
    return 2;
  }
  if (rest.some((a) => a.startsWith("-"))) {
    console.log(USAGE);
    return 2;
  }
  if (!undo && rest.length > 0) {
    console.log(USAGE);
    return 2;
  }

  const crowHome = process.env.CROW_HOME || join(homedir(), ".crow");
  const dataDir = process.env.CROW_DATA_DIR || join(crowHome, "data");
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

  if (undo) {
    if (rest.length > 1) { console.log(USAGE); return 2; }
    const r = await undoGwsFirstparty({ crowHome, stamp: rest[0] || null, force });
    if (r.status === "restored") return 0;
    if (r.status === "no-backup") { console.log(`[gws-firstparty] ${r.reason}`); return 1; }
    if (r.status === "refused" && (r.diffs || []).length > 0) { console.log(`[gws-firstparty] ${r.reason}`); return 3; }
    console.log(`[gws-firstparty] ${r.reason}`);
    return 1;
  }

  const r = await migrateGwsFirstparty({ crowHome, repoRoot, dataDir, dryRun });
  if (r.status === "migrated" || r.status === "dry-run" || r.status === "already-migrated") return 0;
  console.log(`[gws-firstparty] ${r.status === "refused" ? "refused" : "failed"}: ${r.reason}`);
  return 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}