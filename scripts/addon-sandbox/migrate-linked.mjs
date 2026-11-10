/**
 * Move checkout-linked add-ons into the Crow home.
 *
 * An add-on "linked" to the checkout is a stdio entry of mcp-addons.json whose
 * code lives outside <crowHome>/bundles/<id>: a symlink there, an entry `cwd`
 * somewhere else, or an absolute launcher inside the repo's own bundles/ folder.
 * A walled add-on must run from a folder Crow owns, so each one is copied in:
 *
 *   - the gate: nothing at all happens unless this computer's walls are on
 *     (CROW_ADDON_WALLS_DEFAULT=walled and the kill switch not set). Read first,
 *     before mcp-addons.json or any path is touched;
 *   - the backup: for one id, its whole mcp-addons.json entry and the link
 *     target are written to <crowHome>/addon-walls-migrate/<id>-<stamp>.json
 *     (file 0600, folder 0700) BEFORE anything about that id changes. Any failed
 *     step puts the folder switch back, removes what that attempt created and
 *     drops its backup file, so the id ends up exactly as it was — except that a
 *     folder the switch could not put back keeps its backup for `--undo`;
 *   - the registry: the new mcp-addons.json is a clone with the one new entry,
 *     written before the in-memory document changes;
 *   - the copy: <crowHome>/bundles/<id>.migrating (no .venv, .git, __pycache__,
 *     node_modules; no file the entry env names inside the source), checked
 *     against the source, then swapped in. The old link stays as
 *     <id>.linked-<stamp>;
 *   - a data file the entry names inside the source moves to
 *     <dataDir>/<id>/<path> and the entry is repointed (the source file stays);
 *   - funkwhale: an entry URL that names this computer is repointed to its own
 *     loopback port.
 *
 * `--undo [<id>...]` (no id = every migrated add-on) walks every live backup of
 * an id, newest first, restoring the folder each one recorded and finally the
 * entry of the OLDEST live one — the state before the first change. Each backup
 * is then marked undone and the copy stays as <id>.migrated-<stamp>. It is never
 * gated — a rollback must always work — and deletes nothing.
 *
 * CLI: node scripts/addon-sandbox/migrate-linked.mjs [--undo [<id>...]]
 * It reads CROW_HOME (default ~/.crow), CROW_DATA_DIR (default <crowHome>/data)
 * and uses the checkout it sits in as the app root.
 *
 * Design notes: the private engineering notes.
 */
import { execFile } from "node:child_process";
import {
  chmodSync, cpSync, lstatSync, mkdirSync, readFileSync, readlinkSync,
  readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync,
} from "node:fs";
import { homedir, hostname, networkInterfaces } from "node:os";
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { launcherPin } from "../../servers/shared/resolve-command.js";
import { tailscaleStatusAsync } from "../../servers/shared/self-dial-address.js";
import { withoutCredentialKeys } from "../../servers/shared/credentials-env.js";
import { wallsOnForHost } from "./host-switch.mjs";

/** Backups and their folder live directly under the Crow home. */
export const BACKUP_DIR = "addon-walls-migrate";

/** Names never copied from a source folder (rebuilt, or not ours to copy). */
const EXCLUDED_NAMES = new Set([".venv", ".git", "__pycache__", "node_modules"]);

const SLUG = /^[a-z0-9][a-z0-9-]*$/;

const inside = (child, parent) => child === parent || child.startsWith(parent + sep);
const strictlyInside = (child, parent) => child !== parent && child.startsWith(parent + sep);

function lexists(p) {
  try { lstatSync(p); return true; } catch { return false; }
}

/** The real path, or null (a missing path, a broken link, a permission). */
function realpathSyncish(p) {
  try { return realpathSync(p); } catch { return null; }
}

/** UTC `YYYYMMDDTHHMMSSZ`, the stamp every name and backup file carries. */
function utcStamp(date) {
  const p = (n) => String(n).padStart(2, "0");
  return `${date.getUTCFullYear()}${p(date.getUTCMonth() + 1)}${p(date.getUTCDate())}`
    + `T${p(date.getUTCHours())}${p(date.getUTCMinutes())}${p(date.getUTCSeconds())}Z`;
}

/** `base + suffix` when free, else `base-2 + suffix`, `base-3 + suffix` … */
function freeName(dir, base, suffix = "") {
  if (!lexists(join(dir, base + suffix))) return base + suffix;
  for (let n = 2; n < 1000; n++) {
    const name = `${base}-${n}${suffix}`;
    if (!lexists(join(dir, name))) return name;
  }
  throw new Error(`no free name for ${base} in ${dir}`);
}

/** A temp file in the same folder, mode 0600, then a rename. */
function writeAtomicPrivate(path, text) {
  mkdirSync(dirname(path), { recursive: true });
  const tmp = join(dirname(path), `.${basename(path)}.tmp-${process.pid}-${Date.now().toString(36)}`);
  try {
    writeFileSync(tmp, text, { mode: 0o600, flag: "wx" });
    chmodSync(tmp, 0o600);
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
}

/**
 * Create one folder at mode 0700. An existing one is looked at with lstat
 * first: a symlink (or a file) is refused, never chmodded through.
 */
function ensurePrivateDir(dir) {
  let st = null;
  try { st = lstatSync(dir); } catch { st = null; }
  if (st) {
    if (st.isSymbolicLink() || !st.isDirectory()) throw new Error("a folder this migration needs is not a plain folder");
    try { chmodSync(dir, 0o700); } catch { /* someone else's folder */ }
    return;
  }
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  try { chmodSync(dir, 0o700); } catch { /* just made */ }
}

/** `<dataDir>/<id>` must be a real folder before anything is written below it. */
function dataFolderOrFail(dataRoot, id) {
  const dir = join(dataRoot, id);
  let st = null;
  try { st = lstatSync(dir); } catch { st = null; }
  if (st && !st.isDirectory()) throw new Error("its data folder is not a plain folder");
  return dir;
}

/** The highest path on the way to `dest` that does not exist yet, or null. */
function createdTop(dest) {
  if (lexists(dest)) return null;
  let top = dest;
  let at = dirname(dest);
  while (!lexists(at) && at !== dirname(at)) {
    top = at;
    at = dirname(at);
  }
  return top;
}

const deepCopy = (v) => JSON.parse(JSON.stringify(v));

/** A promise over execFile: ten minutes, and no credential keys in the child env. */
function defaultRunner(command, args, opts = {}) {
  return new Promise((ok, fail) => {
    execFile(command, args, {
      cwd: opts.cwd,
      timeout: 10 * 60 * 1000,
      maxBuffer: 8 * 1024 * 1024,
      env: withoutCredentialKeys(process.env),
    }, (err, stdout, stderr) => {
      if (err) {
        err.stdout = stdout;
        err.stderr = stderr;
        fail(err);
        return;
      }
      ok({ stdout, stderr });
    });
  });
}

// ── self names ──────────────────────────────────────────────────────────────

const cleanName = (v) => String(v ?? "").toLowerCase().replace(/^\[/, "").replace(/\]$/, "").replace(/\.$/, "");

/**
 * This computer's own names and addresses: its hostname, the hostnames of
 * CROW_GATEWAY_URL / CROW_PUBLIC_URL, every interface address, and what
 * tailscale says about this node. Every lookup is guarded; a failure just means
 * one fewer name.
 */
export async function resolveSelfNames({ env = process.env } = {}) {
  const names = new Set();
  const addrs = new Set();
  try { if (hostname()) names.add(cleanName(hostname())); } catch { /* none */ }
  for (const key of ["CROW_GATEWAY_URL", "CROW_PUBLIC_URL"]) {
    try {
      const host = new URL(String(env?.[key] || "")).hostname;
      if (host) names.add(cleanName(host));
    } catch { /* unset or not a URL */ }
  }
  try {
    for (const list of Object.values(networkInterfaces() || {})) {
      for (const addr of list || []) if (addr?.address) addrs.add(cleanName(addr.address));
    }
  } catch { /* none */ }
  try {
    const status = await tailscaleStatusAsync({ timeoutMs: 3000 });
    if (status?.Self?.DNSName) names.add(cleanName(status.Self.DNSName));
    for (const ip of status?.Self?.TailscaleIPs || []) if (ip) addrs.add(cleanName(ip));
  } catch { /* no tailscale, or it did not answer */ }
  return { names: [...names].filter(Boolean), addrs: [...addrs].filter(Boolean) };
}

// ── finding linked add-ons ──────────────────────────────────────────────────

/** The source an entry is linked to, and how, or null when it is not linked. */
function linkedSource({ id, entry, crowHome, appRoot }) {
  const linkPath = join(crowHome, "bundles", id);
  let st = null;
  try { st = lstatSync(linkPath); } catch { st = null; }
  if (st?.isSymbolicLink()) {
    const source = realpathSyncish(linkPath);
    if (source) return { source, how: "symlink" };
  }
  const ownCopy = realpathSyncish(linkPath);
  if (typeof entry.cwd === "string" && entry.cwd !== "") {
    const source = realpathSyncish(entry.cwd);
    if (source && !(ownCopy && inside(source, ownCopy))) return { source, how: "cwd" };
  }
  if (typeof entry.command === "string" && isAbsolute(entry.command) && typeof appRoot === "string") {
    const appCopy = realpathSyncish(join(appRoot, "bundles", id));
    const launcher = realpathSyncish(entry.command);
    if (appCopy && launcher && strictlyInside(launcher, appCopy)) return { source: appCopy, how: "command" };
  }
  return null;
}

/** Why a source must not be copied, or null when it is fine. */
function sourceProblem(source, { home, data }) {
  let st;
  try { st = statSync(source); } catch { return "its source is missing"; }
  if (!st.isDirectory()) return "its source is not a folder";
  const real = realpathSyncish(source);
  if (!real) return "its source is missing";
  if (real === home) return "its source is the Crow home";
  if (real === data) return "its source is the data folder";
  if (strictlyInside(home, real)) return "its source holds the Crow home";
  if (strictlyInside(data, real)) return "its source holds the data folder";
  return null;
}

/**
 * The linked add-ons of mcp-addons.json: [{ id, source, how }]. Stdio entries
 * with a slug id only; a satellite entry, an HTTP entry and a non-slug key are
 * left out. A source that must not be copied is logged and skipped.
 */
export function findLinkedAddons({ crowHome, appRoot, dataDir, addons, log = () => {} } = {}) {
  const home = realpathSyncish(crowHome) || crowHome;
  const data = dataDir ? (realpathSyncish(dataDir) || dataDir) : join(crowHome, "data");
  const out = [];
  for (const [id, entry] of Object.entries(addons && typeof addons === "object" ? addons : {})) {
    if (!SLUG.test(id)) continue;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue;
    if (entry.url) continue;
    if (entry.satellite !== undefined) continue;
    if (String(entry.transport || "stdio").toLowerCase() === "http") continue;
    const found = linkedSource({ id, entry, crowHome, appRoot });
    if (!found) continue;
    const problem = sourceProblem(found.source, { home, data });
    if (problem) {
      log(`[addon-migrate] ${id}: ${problem}; left as it is`);
      continue;
    }
    out.push({ id, source: found.source, how: found.how });
  }
  return out;
}

// ── the copy, its filter and its check ──────────────────────────────────────

function relKey(root, abs) {
  return relative(root, abs).split(sep).join("/");
}

/** An env value that names a path: absolute, or `~/…` expanded from `home`. */
function expandEnvPath(value, homeDir) {
  if (typeof value !== "string" || value === "") return null;
  if (value === "~") return homeDir;
  if (value.startsWith("~/")) return join(homeDir, value.slice(2));
  return isAbsolute(value) ? value : null;
}

/** The entry env paths that sit inside the source: [{ key, abs, rel }]. */
function envPathsInside(entry, source, homeDir) {
  const out = [];
  for (const [key, value] of Object.entries(entry?.env && typeof entry.env === "object" ? entry.env : {})) {
    const from = expandEnvPath(value, homeDir);
    if (!from) continue;
    // The value may name the source through the link itself (~/.crow/bundles/<id>/…):
    // its real path is what decides whether it lies inside the source.
    const abs = realpathSyncish(resolve(from)) || resolve(from);
    if (!strictlyInside(abs, source)) continue;
    if (!lexists(abs)) continue;
    out.push({ key, abs, rel: relKey(source, abs) });
  }
  return out;
}

/** The one exclusion rule, applied to the source and to the copy alike. */
function excludedRel(rel, envPaths) {
  for (const seg of rel.split("/")) if (EXCLUDED_NAMES.has(seg)) return true;
  for (const p of envPaths) if (rel === p.rel || rel.startsWith(p.rel + "/")) return true;
  return false;
}

/** Every entry of a tree with its type (and link text / size), same filter. */
function snapshotTree(root, envPaths) {
  const out = new Map();
  const walk = (dir, prefix) => {
    let names;
    try { names = readdirSync(dir); } catch { return; }
    for (const name of names.sort()) {
      const abs = join(dir, name);
      const rel = prefix ? `${prefix}/${name}` : name;
      if (excludedRel(rel, envPaths)) continue;
      let st;
      try { st = lstatSync(abs); } catch { continue; }
      if (st.isSymbolicLink()) {
        let link = null;
        try { link = readlinkSync(abs); } catch { link = null; }
        out.set(rel, { type: "symlink", link });
      } else if (st.isDirectory()) {
        out.set(rel, { type: "dir" });
        walk(abs, rel);
      } else if (st.isFile()) {
        out.set(rel, { type: "file", size: st.size });
      } else {
        out.set(rel, { type: "other" });
      }
    }
  };
  walk(root, "");
  return out;
}

/** The copy holds the same entries, of the same types, with the same links and sizes. */
function sameTree(source, copy, envPaths) {
  const want = snapshotTree(source, envPaths);
  const got = snapshotTree(copy, envPaths);
  if (want.size !== got.size) return false;
  for (const [rel, a] of want) {
    const b = got.get(rel);
    if (!b || a.type !== b.type) return false;
    if (a.type === "symlink" && a.link !== b.link) return false;
    if (a.type === "file" && a.size !== b.size) return false;
  }
  return true;
}

// ── the google-workspace stub ───────────────────────────────────────────────

/** No manifest in the source and a uvx `--from git+…@<40 hex>`: the code is the git ref. */
function isGitUvxStub(entry, source) {
  if (lexists(join(source, "manifest.json"))) return false;
  if (basename(String(entry?.command || "")) !== "uvx") return false;
  const args = Array.isArray(entry.args) ? entry.args.map(String) : [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    const ref = arg.startsWith("--from=") ? arg.slice(7) : (arg === "--from" ? args[i + 1] || "" : "");
    if (/^git\+.+@[0-9a-f]{40}$/i.test(ref)) return true;
  }
  return false;
}

function stubManifest(id) {
  return {
    id,
    name: id,
    type: "mcp-server",
    version: "0.0.0-local",
    sandbox: { files: { oauthDir: "env:GOOGLE_TOKEN_FILE" } },
  };
}

// ── funkwhale's own-host URL ────────────────────────────────────────────────

function isSelfHost(raw, selfNames) {
  let host;
  try { host = cleanName(new URL(String(raw)).hostname); } catch { return false; }
  if (!host) return false;
  const listed = [...(selfNames?.names || []), ...(selfNames?.addrs || [])].map(cleanName);
  return listed.includes(host);
}

/** The port its compose publishes: the entry's value, else its manifest default, else 8600. */
function funkwhalePort(entryPort, appRoot) {
  const given = String(entryPort ?? "");
  if (/^\d+$/.test(given) && Number(given) >= 1 && Number(given) <= 65535) return given;
  try {
    const manifest = JSON.parse(readFileSync(join(appRoot, "bundles", "funkwhale", "manifest.json"), "utf8"));
    const spec = (manifest.env_vars || []).find((v) => v && v.name === "FUNKWHALE_NGINX_BIND_PORT");
    const fallback = String(spec?.default ?? "");
    if (/^\d+$/.test(fallback) && Number(fallback) >= 1 && Number(fallback) <= 65535) return fallback;
  } catch { /* no repo copy: the compose default below */ }
  return "8600";
}

/**
 * The funkwhale entry with its own-computer URL repointed to the loopback port
 * its compose publishes, or null when there is nothing to change. Never mutates
 * its input; `ownerSet` keeps FUNKWHALE_URL, which is provenance, not a value.
 */
function funkwhaleRepoint({ addons, appRoot, selfNames }) {
  const entry = addons?.funkwhale;
  if (!entry || typeof entry !== "object") return null;
  const env = entry.env;
  if (!env || typeof env !== "object") return null;
  if (!isSelfHost(env.FUNKWHALE_URL, selfNames)) return null;
  const next = `http://127.0.0.1:${funkwhalePort(env.FUNKWHALE_NGINX_BIND_PORT, appRoot)}`;
  if (env.FUNKWHALE_URL === next) return null;
  return { previous: deepCopy(entry), next: { ...deepCopy(entry), env: { ...env, FUNKWHALE_URL: next } } };
}

// ── the backup ──────────────────────────────────────────────────────────────

function writeBackup({ crowHome, id, kind, entry, how, source, linkName, linkTarget, stamp, at }) {
  const dir = join(crowHome, BACKUP_DIR);
  ensurePrivateDir(dir);
  const path = join(dir, freeName(dir, `${id}-${stamp}`, ".json"));
  const record = { v: 1, id, at, kind, entry: deepCopy(entry), how, source, linkName, linkTarget };
  writeAtomicPrivate(path, `${JSON.stringify(record, null, 2)}\n`);
  return path;
}

// ── one add-on ──────────────────────────────────────────────────────────────

/** Re-pin a launcher for the copy; a null pin is no pin at all. */
function repin(next, dir) {
  const pin = launcherPin(next.command, dir);
  if (pin) next.command_sha256 = pin;
  else delete next.command_sha256;
}

/**
 * Put the folder back the way it was: the copy aside, the old link back in
 * place, the copy and every path this attempt created in the data folder
 * removed, and the backup file this attempt wrote deleted. Every step is
 * guarded, so one that fails still leaves the rest done. When a rename did not
 * go back, the backup stays: it is what `--undo` restores from.
 */
function undoAttempt(state) {
  const { id, linkPath, copyPath, keptName, linkAside, copyInPlace, backupPath, created, log } = state;
  let stuck = false;
  if (copyInPlace) {
    try { renameSync(linkPath, copyPath); } catch { /* the copy stays at <id> */ stuck = true; }
  }
  if (linkAside) {
    try { renameSync(join(dirname(linkPath), keptName), linkPath); } catch { /* reported below */ stuck = true; }
  }
  rmSync(copyPath, { recursive: true, force: true });
  for (const p of created || []) rmSync(p, { recursive: true, force: true });
  // A folder that could not be put back: keep its backup, the one thing
  // `--undo` restores from.
  if (stuck) {
    log?.(`[addon-migrate] ${id}: could not put the folders back; its backup is kept for --undo`);
    return;
  }
  if (backupPath) rmSync(backupPath, { force: true });
}

/**
 * Copy, check and switch one linked add-on. Returns its new entry and a
 * `rollback` that puts everything back; throws on any failure, with the id left
 * exactly as it was and the backup of that attempt removed (kept when a folder
 * could not be put back).
 */
async function migrateOne({ id, source, how, entry, ctx }) {
  const { crowHome, stamp, at, dataRoot } = ctx;
  const bundlesDir = join(crowHome, "bundles");
  mkdirSync(bundlesDir, { recursive: true });
  const linkPath = join(bundlesDir, id);
  const copyPath = join(bundlesDir, `${id}.migrating`);
  const stub = isGitUvxStub(entry, source);

  // Nothing is ever written through a data folder that is a link or a file.
  dataFolderOrFail(dataRoot, id);

  // 1. The backup, before a single thing changes for this id.
  const linkName = lexists(linkPath) ? freeName(bundlesDir, `${id}.linked-${stamp}`) : null;
  let linkTarget = null;
  if (linkName) {
    try { linkTarget = lstatSync(linkPath).isSymbolicLink() ? readlinkSync(linkPath) : null; } catch { linkTarget = null; }
  }
  const backupPath = writeBackup({
    crowHome, id, kind: stub ? "migrate-stub" : "migrate", entry, how, source,
    linkName, linkTarget, stamp, at,
  });

  const state = { id, linkPath, copyPath, keptName: linkName, linkAside: false, copyInPlace: false, backupPath, created: [], log: ctx.log };
  const undo = () => undoAttempt(state);
  try {
    const next = await copyAndSwitch({ id, source, entry, linkPath, copyPath, linkName, stub, ctx, state });
    return { next, rollback: undo };
  } catch (err) {
    undo();
    throw err;
  }
}

/** Steps 2-8 for one id: copy, check, prepare, copy the data out, switch in, rewrite the entry. */
async function copyAndSwitch({ id, source, entry, linkPath, copyPath, linkName, stub, ctx, state }) {
  const { dataRoot, homeDir, run, log, verify, afterCopy, afterSwitchStep, copyData } = ctx;
  const next = deepCopy(entry);
  const envPaths = stub ? [] : envPathsInside(entry, source, homeDir);
  const copyInto = typeof copyData === "function" ? copyData : cpSync;

  // 2. The copy: a stale one is ours to drop, then copy with the shared filter.
  rmSync(copyPath, { recursive: true, force: true });
  if (stub) {
    mkdirSync(copyPath, { mode: 0o700 });
    try { chmodSync(copyPath, 0o700); } catch { /* just made */ }
    writeFileSync(join(copyPath, "manifest.json"), `${JSON.stringify(stubManifest(id), null, 2)}\n`, { mode: 0o600 });
  } else {
    if (lexists(join(source, ".git"))) log(`[addon-migrate] ${id}: source has a .git folder; copied without it`);
    cpSync(source, copyPath, {
      recursive: true,
      verbatimSymlinks: true,
      filter: (abs) => abs === source || !excludedRel(relKey(source, abs), envPaths),
    });
  }

  if (typeof afterCopy === "function") await afterCopy({ id, source, copy: copyPath });

  // 3. Verify with the same filter the copy used.
  if (!stub) {
    const ok = typeof verify === "function"
      ? await verify({ id, source, copy: copyPath })
      : sameTree(source, copyPath, envPaths);
    if (!ok) throw new Error("the copy does not match its source");
  }

  if (!stub) {
    // 5. A node bundle installs its runtime deps into the copy.
    if (lexists(join(copyPath, "package.json")) && !lexists(join(copyPath, "node_modules"))) {
      await run("npm", ["install", "--omit=dev"], { cwd: copyPath });
    }
    // 6. A uv project gets its own environment; the warm-up builds it.
    if (lexists(join(copyPath, "pyproject.toml"))) {
      const envDir = join(dataRoot, id);
      const top = createdTop(envDir);
      // Recorded before it is made: a folder this attempt starts is removed again
      // even when the step that makes it fails part-way.
      if (top) state.created.push(top);
      ensurePrivateDir(envDir);
      next.env = { ...(next.env || {}), UV_PROJECT_ENVIRONMENT: join(envDir, ".venv") };
    }
  }

  // 4. The data files the entry names inside the source: after every step that
  //    can fail, immediately before the switch. Each destination is recorded,
  //    so a failure here or later removes what this attempt created.
  for (const p of envPaths) {
    const dest = join(dataRoot, id, p.rel);
    if (lexists(dest)) {
      log(`[addon-migrate] ${id}: ${p.rel} is already in the data folder; kept that copy`);
    } else {
      const top = createdTop(dest);
      // Recorded before the copy: a copy that stops part-way still leaves
      // nothing for a later boot to mistake for a finished one.
      if (top) state.created.push(top);
      mkdirSync(dirname(dest), { recursive: true, mode: 0o700 });
      copyInto(p.abs, dest, { recursive: true, verbatimSymlinks: true });
    }
    next.env = { ...(next.env || {}), [p.key]: dest };
  }

  // 7. Switch: the old link aside, the copy in.
  if (linkName) {
    renameSync(linkPath, join(dirname(linkPath), linkName));
    state.linkAside = true;
    if (typeof afterSwitchStep === "function") await afterSwitchStep({ id, step: "aside", linkPath, copyPath });
  }
  renameSync(copyPath, linkPath);
  state.copyInPlace = true;
  if (typeof afterSwitchStep === "function") await afterSwitchStep({ id, step: "place", linkPath, copyPath });

  // 8. The entry: no cwd any more, and a launcher inside the copy, re-pinned.
  //    The launcher is compared at its REAL path, so a checkout reached through
  //    a symlinked folder is rewritten into the copy like any other.
  delete next.cwd;
  const command = next.command;
  const launcher = typeof command === "string" && isAbsolute(command) ? (realpathSyncish(command) || resolve(command)) : null;
  if (launcher && strictlyInside(launcher, source)) {
    next.command = join(linkPath, relative(source, launcher));
    repin(next, linkPath);
  } else if (typeof command === "string" && !isAbsolute(command) && command.includes("/")) {
    repin(next, linkPath);
  }
  return next;
}

// ── the gated pass ──────────────────────────────────────────────────────────

/**
 * Migrate every linked add-on of this Crow home. The gate is the first thing
 * this function does; with walls off it reads nothing and changes nothing.
 */
export async function migrateLinkedAddons({
  crowHome, appRoot, dataDir, env = process.env, mcpAddonsPath,
  selfNames, runner, now = () => new Date(), log = console.log, home,
  verify, afterCopy, afterSwitchStep, copyData, writeAddons,
} = {}) {
  if (!wallsOnForHost(env)) return { skipped: "walls off", migrated: [], repointed: [], failed: [] };

  const homeDir = home || homedir();
  const addonsPath = mcpAddonsPath || join(crowHome, "mcp-addons.json");
  const dataRoot = dataDir || join(crowHome, "data");
  const run = typeof runner === "function" ? runner : defaultRunner;
  const when = now();
  const stamp = utcStamp(when);
  const at = new Date(when).toISOString();
  const result = { migrated: [], repointed: [], failed: [] };

  let addons;
  try {
    addons = JSON.parse(readFileSync(addonsPath, "utf8"));
  } catch {
    log(`[addon-migrate] cannot read ${addonsPath}; nothing done`);
    return result;
  }
  if (!addons || typeof addons !== "object" || Array.isArray(addons)) {
    log(`[addon-migrate] ${addonsPath} is not an object; nothing done`);
    return result;
  }

  // The ONE write of the registry: the caller-visible document is a clone with
  // the one new entry, and memory follows only once it is on disk.
  const writeAddonsDoc = typeof writeAddons === "function"
    ? writeAddons
    : (doc) => writeAtomicPrivate(addonsPath, JSON.stringify(doc, null, 2));
  const self = selfNames || await resolveSelfNames({ env });
  const ctx = { crowHome, appRoot, dataRoot, stamp, at, homeDir, run, log, verify, afterCopy, afterSwitchStep, copyData };

  for (const item of findLinkedAddons({ crowHome, appRoot, dataDir: dataRoot, addons, log })) {
    let made = null;
    try {
      made = await migrateOne({ ...item, entry: addons[item.id], ctx });
      await writeAddonsDoc({ ...addons, [item.id]: made.next });
      addons[item.id] = made.next;
      result.migrated.push(item.id);
      log(`[addon-migrate] ${item.id}: copied into ${join(crowHome, "bundles", item.id)}; the old link is ${item.id}.linked-${stamp}`);
    } catch (err) {
      // Any failure at all leaves this id exactly as it was: the folder switch
      // goes back and the backup of this attempt is dropped.
      if (made) made.rollback();
      const reason = String(err?.message || err).slice(0, 300);
      result.failed.push({ id: item.id, reason });
      log(`[addon-migrate] ${item.id}: ${reason}; left as it was`);
    }
  }

  const repoint = funkwhaleRepoint({ addons, appRoot, selfNames: self });
  if (repoint) {
    const migratedNow = result.migrated.includes("funkwhale");
    let backupPath = null;
    try {
      if (!migratedNow) {
        backupPath = writeBackup({
          crowHome, id: "funkwhale", kind: "repoint", entry: repoint.previous,
          how: null, source: null, linkName: null, linkTarget: null, stamp, at,
        });
      }
      await writeAddonsDoc({ ...addons, funkwhale: repoint.next });
      addons.funkwhale = repoint.next;
      if (!migratedNow) result.repointed.push("funkwhale");
      log("funkwhale: its URL named this computer; repointed to its local port");
    } catch (err) {
      if (backupPath) rmSync(backupPath, { force: true });
      const reason = String(err?.message || err).slice(0, 300);
      result.failed.push({ id: "funkwhale", reason });
      log(`[addon-migrate] funkwhale: ${reason}; left as it was`);
    }
  }

  return result;
}

// ── undo ────────────────────────────────────────────────────────────────────

/**
 * Every live backup, per id, newest first: by stamp, then by the numeric
 * suffix of a second backup written in the same second (`-10` is newer than
 * `-9`). A file that ends in ".undone.json" is not live.
 */
function liveBackups(dir) {
  const out = new Map();
  let names;
  try { names = readdirSync(dir); } catch { return out; }
  for (const name of names) {
    if (name.endsWith(".undone.json")) continue;
    const m = /^(.+)-(\d{8}T\d{6}Z)(?:-(\d+))?\.json$/.exec(name);
    if (!m) continue;
    const [, id, stamp, suffix] = m;
    const list = out.get(id) || [];
    list.push({ id, stamp, suffix: suffix ? Number(suffix) : 0, file: join(dir, name) });
    out.set(id, list);
  }
  for (const list of out.values()) {
    list.sort((a, b) => (a.stamp === b.stamp ? b.suffix - a.suffix : (a.stamp < b.stamp ? 1 : -1)));
    for (const rec of list) {
      try { rec.data = JSON.parse(readFileSync(rec.file, "utf8")); } catch { rec.data = null; }
    }
  }
  return out;
}

/** True when a backup's kept-aside folder name is one this migration writes for this id. */
function isOwnLinkName(id, name) {
  if (name === null || name === undefined) return true;
  const escaped = String(id).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^${escaped}\\.linked-\\d{8}T\\d{6}Z(-\\d+)?$`).test(String(name));
}

/**
 * Put the link and the entry back, from every live backup of each id (or of the
 * given ids). Never gated, never deletes anything: the migrated copy stays as
 * <id>.migrated-<stamp> and each backup is renamed, so a second undo is a no-op.
 *
 * Newest backup first, each one restoring the folder it recorded, and finally
 * the entry of the OLDEST live backup: that is the state before the first
 * change, so a repoint followed by a migration comes back in one step.
 */
export async function undoMigration({ crowHome, ids = null, mcpAddonsPath, now = () => new Date(), log = console.log } = {}) {
  const bundlesDir = join(crowHome, "bundles");
  const addonsPath = mcpAddonsPath || join(crowHome, "mcp-addons.json");
  const stamp = utcStamp(now());
  const live = liveBackups(join(crowHome, BACKUP_DIR));
  const wanted = Array.isArray(ids) && ids.length ? ids : [...live.keys()];
  const out = { restored: [], skipped: [] };

  let addons = null;
  try { addons = JSON.parse(readFileSync(addonsPath, "utf8")); } catch { addons = null; }

  for (const id of wanted) {
    if (!SLUG.test(String(id))) { out.skipped.push({ id, reason: "not an add-on id" }); continue; }
    const backups = live.get(id) || [];
    if (!backups.length) { out.skipped.push({ id, reason: "no backup to undo" }); continue; }
    if (backups.some((b) => !b.data || typeof b.data !== "object")) {
      out.skipped.push({ id, reason: "its backup cannot be read" });
      continue;
    }
    // A backup names this add-on and a folder name this migration writes for it,
    // or it is not ours to act on: no name in it is ever used as a path.
    if (backups.some((b) => b.data.id !== id || !isOwnLinkName(id, b.data.linkName))) {
      out.skipped.push({ id, reason: "its backup does not match this add-on" });
      continue;
    }
    try {
      for (const backup of backups) {
        const record = backup.data;
        if (record.kind !== "migrate" && record.kind !== "migrate-stub") continue;
        const linkPath = join(bundlesDir, id);
        const saved = record.linkName ? join(bundlesDir, record.linkName) : null;
        if (saved && lexists(saved)) {
          if (lexists(linkPath)) {
            renameSync(linkPath, join(bundlesDir, freeName(bundlesDir, `${id}.migrated-${stamp}`)));
          }
          renameSync(saved, linkPath);
        } else if (saved) {
          log(`[addon-migrate] ${id}: ${record.linkName} is gone; only the entry is restored`);
        } else if (lexists(linkPath)) {
          renameSync(linkPath, join(bundlesDir, freeName(bundlesDir, `${id}.migrated-${stamp}`)));
        }
      }
      const oldest = backups[backups.length - 1].data;
      if (addons && oldest.entry) {
        addons[id] = deepCopy(oldest.entry);
        writeAtomicPrivate(addonsPath, JSON.stringify(addons, null, 2));
      }
      for (const backup of backups) renameSync(backup.file, `${backup.file.replace(/\.json$/, "")}.undone.json`);
      out.restored.push(id);
      log(`[addon-migrate] ${id}: restored`);
    } catch (err) {
      out.skipped.push({ id, reason: String(err?.message || err).slice(0, 300) });
    }
  }
  return out;
}

// ── CLI ─────────────────────────────────────────────────────────────────────

export const USAGE = "usage: node scripts/addon-sandbox/migrate-linked.mjs [--undo [<id>...]]";

const WALLS_OFF_LINE = "walls are off on this computer (CROW_ADDON_WALLS_DEFAULT is not walled); nothing done";

async function main(argv) {
  const undo = argv[0] === "--undo";
  const rest = undo ? argv.slice(1) : argv;
  if (!undo && rest.length) {
    console.log(USAGE);
    return 2;
  }
  const crowHome = process.env.CROW_HOME || join(homedir(), ".crow");
  const dataDir = process.env.CROW_DATA_DIR || join(crowHome, "data");
  const appRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");

  if (undo) {
    const r = await undoMigration({ crowHome, ids: rest.length ? rest : null });
    for (const s of r.skipped) console.log(`${s.id}: ${s.reason}`);
    console.log(`restored ${r.restored.length} add-on(s)`);
    return 0;
  }

  if (!wallsOnForHost(process.env)) {
    console.log(WALLS_OFF_LINE);
    return 0;
  }
  const r = await migrateLinkedAddons({ crowHome, appRoot, dataDir, env: process.env });
  console.log(`migrated ${r.migrated.length ? r.migrated.join(", ") : "none"}`);
  if (r.repointed.length) console.log(`repointed ${r.repointed.join(", ")}`);
  for (const f of r.failed) console.log(`${f.id}: ${f.reason}`);
  return r.failed.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main(process.argv.slice(2));
}