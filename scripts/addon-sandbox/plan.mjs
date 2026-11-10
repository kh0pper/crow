/**
 * The file side of the add-on wall: one stdio MCP add-on's bwrap argv, env,
 * bind fds and relay ports.
 *
 * Pure apart from realpath/stat/readdir and the checked opens in bind-fd.mjs;
 * it creates nothing. The caller passes every `fds[].fd` to the child at
 * `childFd` and closes its own copy after spawn.
 *
 * Two kinds of refusal:
 *  - a throw (`ContainRefused`) is a refusal that keeps the add-on OFF: its
 *    install folder is missing or cannot be bound, its id is not a slug, or its
 *    data folder cannot be opened read-write by fd. Fail closed, never unwalled;
 *  - an entry in `refused` is something the add-on can start without (one
 *    owner-set file, a sign-in folder, a state folder, the relay socket dir).
 *
 * Everything an add-on can touch by fd is bound BY FD, never by path (review
 * focus 5): its data folder, its state folders, a sign-in folder it owns, every
 * owner-set file, and an owner-set `files.read` folder (that one read-only,
 * `--ro-bind-fd`: a read grant is never widened to a write). Read-only code
 * (the checkout, the node install, the install folder) keeps the path binds the
 * bot plan uses, with every `.env` masked.
 *
 * Two rules hold for every read-write bind:
 *  - a hidden top-level entry of the home is never writable, except this
 *    add-on's own data folder, its own state folders and the first-party dirs
 *    core lists for it (`ADDON_TOKEN_DIRS`); and no bind is ever writable over
 *    anything that starts a program (`autostart`, `systemd`);
 *  - a folder bound by fd is walked for `.env` files like any path-bound dir
 *    (a `.env` inside a state or sign-in folder is masked too).
 *
 * The add-on's own `.env` (`ownEnvFile`) is not exempted from that mask: it is
 * masked like every other, then re-bound by fd ON TOP of its own mask. A
 * symlinked own `.env` names a file this add-on does not own, so it is refused.
 */
import { closeSync, existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

import {
  ContainRefused,
  ENV_NAME_RE,
  ENV_SCAN_MAX_DEPTH,
  ENV_SCAN_MAX_ENTRIES,
  ENV_SCAN_SKIP,
  NET_RELAY_MOUNT,
  assembleBindArgs,
  makeBindPolicy,
  maskPathInto,
  rootArgs,
  scanEnvMasks,
} from "../pi-bots/pi_contain.mjs";
import { ADDON_TOKEN_DIRS } from "../../servers/shared/addon-doors.js";
import { isLoopbackHost } from "./profile.mjs";
import { openCheckedBindSource } from "./bind-fd.mjs";

/** `p` is `root` or inside it. */
const under = (p, root) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

/** Data-dir entries a crow.db add-on keeps visible: crow.db and its journals only (tasks.db is masked). */
const CROW_DB_KEEP = new Set(["crow.db", "crow.db-wal", "crow.db-shm", "crow.db-journal"]);

/** The proxy port inside the add-on's network namespace, bumped past any port the relay serves. */
const PROXY_PORT = 39080;
/** Where the door token appears inside the wall: bind DATA, never a file in a writable tree. */
const DOOR_TOKEN_MOUNT = "/run/crow-addon/door-token";
/** Crow-home entries that are never a bind source, whatever their owner says. */
const CROW_HOME_SECRET_NAMES = ["secrets", "env", "peer-tokens.json", "identity.json", "android-keystore", ".keystore-env"];
/** An add-on id is one lowercase slug: it names a folder, so never a path. */
const ADDON_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
/** Refused for writing: a hidden top-level entry of the home is the operator's. */
const HIDDEN_WRITE_REASON = "a hidden entry of the home is never writable";
/** Refused for writing: a bind over one of these could start a program on login. */
const AUTOSTART_WRITE_REASON = "an autostart or systemd folder is never writable";
/** Path components that can start something when the owner logs in. */
const AUTOSTART_COMPONENTS = new Set(["autostart", "systemd"]);

const expandHome = (p, home) => (p === "~" ? home : typeof p === "string" && p.startsWith("~/") ? home + p.slice(1) : p);

/** The first file named `command` on `pathEnv`, or null. */
function which(command, pathEnv, exists) {
  for (const dir of String(pathEnv || "").split(":")) {
    if (!dir) continue;
    const p = join(dir, command);
    if (!exists(p)) continue;
    try { if (statSync(p).isFile()) return p; } catch { /* unreadable: keep looking */ }
  }
  return null;
}

/**
 * Build the plan for one walled stdio MCP add-on.
 *
 * @param {object} o
 *   id, profile (deriveProfile's output), entry (the mcp-addons.json entry),
 *   home, crowHome, appRoot, nodeBin, dataDir, dbPath, gatewayPort, otherHomes,
 *   selfTargets, relayDir, doorTokenFd, uid, fdBase, pathEnv, exists
 * @returns {{args: string[], env: object, unsetEnv: string[], fds: {fd, childFd, role}[], refused: {path, reason}[], net: object, addonDataDir: string}}
 * @throws {ContainRefused}
 */
export function buildAddonPlan(o = {}) {
  // The id names folders (`<dataDir>/<id>`, `<crowHome>/bundles/<id>`), so it is
  // one lowercase slug or nothing: no `/`, no `.`/`..`, no path separator.
  if (typeof o.id !== "string" || !ADDON_ID_RE.test(o.id)) {
    throw new ContainRefused("add-on refused: invalid add-on id");
  }
  const exists = o.exists || existsSync;
  const home = resolve(String(o.home));
  const id = o.id;
  const crowHome = resolve(String(o.crowHome));
  const dataDirIn = resolve(String(o.dataDir));
  const profile = o.profile && typeof o.profile === "object" ? o.profile : {};
  const entry = o.entry && typeof o.entry === "object" ? o.entry : {};
  const uid = typeof o.uid === "number" ? o.uid : process.getuid();
  const fdBase = Number.isInteger(o.fdBase) ? o.fdBase : 3;
  const files = profile.files && typeof profile.files === "object" ? profile.files : {};

  const refused = [];
  const ro = new Map(); // dest -> src
  const rw = new Map(); // dest -> src
  const masks = []; // [dest, "dir"|"file"]
  const extraEntries = []; // [flag, src, dest], merged in destination order
  const fdSpecs = []; // { fd, childFd, role, flag, dest }
  const openedFds = []; // every fd this plan opened, closed on a throw

  const realp = (p) => { try { return p && exists(p) ? realpathSync(p) : null; } catch { return null; } };
  const crowHomeReal = realp(crowHome) || crowHome;
  const homeReal = realp(home) || home;
  /** uv's managed Pythons; a bind is allowed only BELOW one of these, at either spelling of the home. */
  const uvPythonRoots = [...new Set([join(home, ".local", "share", "uv", "python"), join(homeReal, ".local", "share", "uv", "python")])];
  const INTERPRETER_OUTSIDE = "the add-on's interpreter is outside the managed Python folders";
  const dataReal = realp(dataDirIn) || dataDirIn;
  const installDir = join(crowHome, "bundles", id);
  const stateNames = (Array.isArray(files.state) ? files.state : [])
    .filter((n) => typeof n === "string" && n && !n.includes("/") && n !== "." && n !== "..");
  const statePaths = stateNames.map((n) => join(crowHome, n));

  /** The next fd number the child sees. */
  const childFdFor = () => fdBase + fdSpecs.length;
  const bindFd = (fd, role, flag, dest) => {
    const childFd = childFdFor();
    fdSpecs.push({ fd, childFd, role, flag, dest });
    extraEntries.push([flag, String(childFd), dest]);
    return childFd;
  };

  try {
    // A data folder that IS the Crow home (or an ancestor of it) would put the
    // instance's tokens, secrets/ and env/ inside the wall, and the crow.db
    // plan binds that folder read-write: refuse it outright.
    if (under(crowHomeReal, dataReal)) {
      throw new ContainRefused("add-on refused: the data folder is the Crow home");
    }

    const policy = makeBindPolicy({
      home, crowHome, crowHomeReal, dataDir: dataReal,
      appRoot: o.appRoot, nodeBin: o.nodeBin, piLabDir: null, otherHomes: o.otherHomes,
      exists, refused,
    });
    const { forbidden, add, never } = policy;

    // The Crow home is readable only inside this add-on's own folders.
    const allowedCrowHomeRoots = [];
    for (const p of [installDir, join(dataReal, id), ...statePaths, ...(profile.crowDb ? [dataReal] : [])]) {
      for (const q of [resolve(p), realp(p)]) if (q && !allowedCrowHomeRoots.includes(q)) allowedCrowHomeRoots.push(q);
    }
    const crowSecrets = CROW_HOME_SECRET_NAMES.map((n) => join(crowHomeReal, n));
    const tokenFiles = [];
    try { for (const e of readdirSync(crowHomeReal)) if (/-token$/.test(e)) tokenFiles.push(join(crowHomeReal, e)); } catch { /* no home yet */ }

    // The read-write allowlist for a hidden top-level entry of the home: the
    // bot rule (`forbidden(..., { policy: true })`) exempts the whole data dir,
    // which is too wide for a bind this add-on can write. Only these trees are
    // writable below a hidden entry: this add-on's own data folder (the data
    // dir itself for a crow.db profile), its own state folders, and the
    // first-party dirs core lists for it.
    const tokenDirNames = Object.prototype.hasOwnProperty.call(ADDON_TOKEN_DIRS, id) && Array.isArray(ADDON_TOKEN_DIRS[id])
      ? ADDON_TOKEN_DIRS[id].filter((n) => typeof n === "string" && n && !n.includes(".."))
      : [];
    const hiddenWriteRoots = [];
    const addWriteRoot = (p) => {
      for (const q of [resolve(p), realp(p)]) if (q && !hiddenWriteRoots.includes(q)) hiddenWriteRoots.push(q);
    };
    for (const p of [profile.crowDb ? dataReal : join(dataReal, id), ...statePaths]) addWriteRoot(p);
    for (const n of tokenDirNames) addWriteRoot(join(home, n));

    /** The hidden top-level entry of `home` a path sits under, or null. */
    function hiddenEntryOf(p) {
      if (!under(p, home)) return null;
      const top = p.slice(home.length + 1).split(sep)[0];
      return top && top.startsWith(".") ? top : null;
    }

    /**
     * The one refuse list: applied to a path before it is bound, again to its
     * real path, and passed as `refuse` to every checked open.
     *
     * `ownEnv` names the add-on's own `.env`, the only environment file that may
     * be bound (by fd, on top of its own mask).
     */
    function refusePath(p, { write = false, ownEnv = false } = {}) {
      if (typeof p !== "string" || !p || !isAbsolute(p)) return "not an absolute path";
      const base = basename(p);
      if (!ownEnv && ENV_NAME_RE.test(base)) return "an environment file is never bound";
      if (base === "mcp-addons.json") return "Crow's add-on registry is never bound";
      if (base === "addon-walls.json") return "the wall settings are never bound";
      for (const n of [...crowSecrets, ...tokenFiles]) {
        if (p === n || under(p, n)) return "a Crow secret is never bound (" + n + ")";
      }
      if (under(p, crowHomeReal) && !allowedCrowHomeRoots.some((r) => under(p, r))) {
        return "the Crow home is not a bind source outside this add-on's own folders";
      }
      if (!write) return forbidden(p);
      // A write bind over a folder that starts something on login, on ANY
      // component (a unit, a desktop autostart entry), is never made.
      if (p.split(sep).some((c) => AUTOSTART_COMPONENTS.has(c))) return AUTOSTART_WRITE_REASON;
      // The bot's rule first: a hidden top-level entry of the home is never
      // writable from a policy. It exempts the whole data dir, so the narrower
      // allowlist above is applied here instead.
      const bot = forbidden(p, { write: true, policy: true });
      if (!bot) return null;
      if (!hiddenEntryOf(p)) return bot; // refused for a reason of its own
      if (hiddenWriteRoots.some((r) => under(p, r))) return forbidden(p, { write: true });
      // A hidden entry outside this add-on's own trees: never writable. A more
      // specific reason (a protected path, code) still wins.
      return forbidden(p, { write: true }) || HIDDEN_WRITE_REASON;
    }

    // ---- .env files inside a folder bound by fd ----
    // A folder bound by fd is not in the ro/rw maps, so scanEnvMasks never sees
    // it: a `.env` inside a state folder or the sign-in folder would stay
    // readable. The same names, skips and caps are walked here instead.
    const envScanMaxDepth = Number.isInteger(o.envScanMaxDepth) ? o.envScanMaxDepth : ENV_SCAN_MAX_DEPTH;
    const envScanMaxEntries = Number.isInteger(o.envScanMaxEntries) ? o.envScanMaxEntries : ENV_SCAN_MAX_ENTRIES;
    const envScanCapReason = "too large to scan for .env files (cap " + envScanMaxEntries + " entries / depth " + envScanMaxDepth + "); not bound";

    /** Every `.env` file inside `root`, or null when the folder is too large to scan. */
    function envFilesInFolder(root) {
      const found = [];
      const maskedDirs = new Set(masks.filter(([, k]) => k === "dir").map(([d]) => d));
      let seen = 0;
      let capped = false;
      const walk = (dir, depth) => {
        if (capped) return;
        let names = [];
        try { names = readdirSync(dir); } catch { return; }
        for (const n of names) {
          if (++seen > envScanMaxEntries) { capped = true; return; }
          const p = join(dir, n);
          let st;
          try { st = lstatSync(p); } catch { continue; }
          if (ENV_NAME_RE.test(n)) {
            if (st.isFile()) found.push(p);
            continue;
          }
          if (st.isDirectory() && !ENV_SCAN_SKIP.has(n) && !maskedDirs.has(p)) {
            if (depth >= envScanMaxDepth) { capped = true; return; }
            walk(p, depth + 1);
            if (capped) return;
          }
        }
      };
      walk(root, 1);
      return capped ? null : found;
    }

    /** Close an fd this plan opened and forget it (the bind it was for is dropped). */
    function dropFd(fd) {
      const at = openedFds.indexOf(fd);
      if (at >= 0) openedFds.splice(at, 1);
      try { closeSync(fd); } catch { /* already closed */ }
    }

    /**
     * Bind an opened folder by fd with every `.env` inside it masked. `flag`
     * decides the mode: `--ro-bind-fd` for a read-only role (`dir-read`),
     * `--bind-fd` for a role the add-on may write.
     * A folder too large to scan is not bound at all: it is dropped and refused.
     */
    function bindOpenedDirFd(opened, role, labelPath, flag) {
      const found = envFilesInFolder(opened.realPath);
      if (!found) {
        dropFd(opened.fd);
        refused.push({ path: labelPath, reason: envScanCapReason });
        return;
      }
      for (const p of found) maskPathInto(masks, p);
      bindFd(opened.fd, role, flag, opened.realPath);
    }

    // ---- root ----
    const args = rootArgs({ exists, home });

    // ---- read-only code ----
    if (o.nodeBin) add(ro, dirname(dirname(o.nodeBin)), { label: "node" });
    if (o.appRoot) add(ro, o.appRoot, { label: "checkout" });

    // The installed copy's own folder, at its real path: the add-on's code. A
    // missing folder keeps the add-on off (there is nothing to run).
    const installRoot = realp(installDir);
    if (!installRoot) {
      throw new ContainRefused("add-on refused: its install folder " + installDir + " does not exist");
    }
    {
      const before = refused.length;
      add(ro, installRoot, { label: "install folder" });
      if (refused.length > before) {
        throw new ContainRefused("add-on refused: its install folder " + installRoot + " cannot be bound (" + refused[refused.length - 1].reason + ")");
      }
    }

    // Trees this add-on can write, computed before anything is bound so the
    // command file can be checked against them. A command inside one of them is
    // the add-on's own choice: it is either already visible through a bind or
    // refused, never a read-only bind source of ours.
    const writableTrees = [];
    const addWritableTree = (p) => {
      for (const q of [resolve(p), realp(p)]) if (q && !writableTrees.includes(q)) writableTrees.push(q);
    };
    for (const spec of Array.isArray(files.write) ? files.write : []) {
      if (spec && typeof spec.path === "string" && spec.path) addWritableTree(expandHome(spec.path, home));
    }
    if (files.oauthDir && typeof files.oauthDir === "object" && typeof files.oauthDir.path === "string" && files.oauthDir.path) {
      addWritableTree(dirname(resolve(expandHome(files.oauthDir.path, home))));
    }
    for (const p of statePaths) addWritableTree(p);

    // The command itself, never its `dirname(dirname(...))`: that root can be
    // an ancestor of a never-bound path (delta 11).
    const command = typeof entry.command === "string" ? entry.command : "";
    const commandBase = command ? basename(command) : "";
    const pathEnv = typeof o.pathEnv === "string" ? o.pathEnv : (process.env.PATH || "");
    const commandFile = isAbsolute(command) ? (exists(command) ? resolve(command) : null) : (command ? which(command, pathEnv, exists) : null);
    if (commandFile) {
      const r = realp(commandFile);
      if (!r) {
        refused.push({ path: commandFile, reason: "does not exist" });
      } else if (under(r, installRoot) || under(r, join(dataReal, id))) {
        // Already visible through the install folder or the data folder bind.
      } else if (under(r, dataReal)) {
        refused.push({ path: commandFile, reason: "another add-on's data folder is never a bind source" });
      } else if (writableTrees.some((t) => under(r, t))) {
        refused.push({ path: commandFile, reason: "a path this add-on can write is never a bind source" });
      } else {
        const why = refusePath(r);
        if (why) refused.push({ path: commandFile, reason: why });
        else if (!under(r, "/usr") && !under(r, "/opt")) add(ro, r, { label: "add-on command" });
      }
    }

    // A venv's interpreter: `bin/python` is a symlink into the Python install,
    // so its real path's grandparent is the install to bind read-only. The
    // symlink itself sits in the add-on's own WRITABLE data folder, so its
    // target is the add-on's choice: only a system dir (already bound by
    // rootArgs) or a uv-managed Python below `<home>/.local/share/uv/python`
    // may be bound, and never through the data dir or the Crow home.
    const venvPython = join(dataReal, id, ".venv", "bin", "python");
    if (exists(venvPython)) {
      const py = realp(venvPython);
      const interpreterRoot = py ? dirname(dirname(py)) : null;
      if (!interpreterRoot) {
        refused.push({ path: venvPython, reason: INTERPRETER_OUTSIDE });
      } else if (under(interpreterRoot, "/usr") || under(interpreterRoot, "/opt")) {
        // Already bound read-only by rootArgs: nothing to add.
      } else {
        const managed = uvPythonRoots.some((u) => interpreterRoot !== u && under(interpreterRoot, u));
        const why = !managed
          ? INTERPRETER_OUTSIDE
          : under(interpreterRoot, dataReal) || under(interpreterRoot, crowHomeReal)
            ? INTERPRETER_OUTSIDE
            : (refusePath(interpreterRoot) || forbidden(interpreterRoot));
        if (why) refused.push({ path: interpreterRoot, reason: why });
        else add(ro, interpreterRoot, { label: "interpreter" });
      }
    }

    // ---- data, by fd ----
    let addonDataDir;
    if (profile.crowDb) {
      if (!exists(dataReal)) throw new ContainRefused("add-on refused: the Crow data folder " + dataReal + " does not exist");
      // A read-write data bind answers to the write side of the same list: the
      // checkout, the Crow home and every protected path are never writable.
      const whyWrite = forbidden(dataReal, { write: true }) || refusePath(dataReal, { write: true });
      if (whyWrite) throw new ContainRefused("add-on refused: its data folder cannot be bound read-write (" + whyWrite + ")");
      const opened = openCheckedBindSource(dataReal, { uid, home, refuse: (rp) => refusePath(rp, { write: true }), expect: "dir" });
      openedFds.push(opened.fd);
      bindFd(opened.fd, "crow-data", "--bind-fd", opened.realPath);
      addonDataDir = join(opened.realPath, id);
      // Every entry present now is masked except crow.db and its journals, the
      // add-on's own folder and the operator's keep-list: no other add-on's
      // data, no backups, no tasks.db.
      let entries = [];
      try { entries = readdirSync(opened.realPath); } catch { /* unreadable: nothing to mask */ }
      for (const e of entries) {
        if (CROW_DB_KEEP.has(e) || e === id) continue;
        maskPathInto(masks, join(opened.realPath, e));
      }
    } else {
      const dir = join(dataReal, id);
      if (!exists(dir)) throw new ContainRefused("add-on refused: its data folder " + dir + " does not exist");
      const whyWrite = forbidden(dir, { write: true }) || refusePath(dir, { write: true });
      if (whyWrite) throw new ContainRefused("add-on refused: its data folder cannot be bound read-write (" + whyWrite + ")");
      const opened = openCheckedBindSource(dir, { uid, home, refuse: (rp) => refusePath(rp, { write: true }), expect: "dir" });
      openedFds.push(opened.fd);
      bindFd(opened.fd, "data", "--bind-fd", opened.realPath);
      addonDataDir = opened.realPath;
    }

    // ---- env: one data bind, one cache below it, no separate cache mount ----
    const env = {
      TMPDIR: "/tmp",
      HOME: home,
      XDG_CACHE_HOME: join(addonDataDir, ".cache"),
      npm_config_cache: join(addonDataDir, ".cache", "npm"),
      UV_CACHE_DIR: join(addonDataDir, ".cache", "uv"),
      CROW_DATA_DIR: dataReal,
    };
    /** Env names the caller deletes from the inherited environment before spawn. */
    const unsetEnv = [];
    if (profile.crowDb) env.CROW_DB_PATH = typeof o.dbPath === "string" && o.dbPath ? o.dbPath : join(dataDirIn, "crow.db");
    else unsetEnv.push("CROW_DB_PATH");
    if (commandBase === "uv" || commandBase === "uvx") env.UV_PROJECT_ENVIRONMENT = join(addonDataDir, ".venv");

    // ---- env-named files: owner-set only, by fd ----
    const bindNamedFile = (spec, mode) => {
      const at = resolve(expandHome(String(spec && spec.path != null ? spec.path : ""), home));
      const write = mode === "write";
      const realAt = realp(at);
      const why = refusePath(at, { write }) || (realAt ? refusePath(realAt, { write }) : null);
      if (why) { refused.push({ path: spec.path, reason: why }); return; }
      let opened;
      try {
        opened = openCheckedBindSource(at, { uid, home, refuse: (rp) => refusePath(rp, { write }), expect: "any" });
      } catch (err) {
        if (!(err instanceof ContainRefused)) throw err;
        refused.push({ path: spec.path, reason: err.message });
        return;
      }
      openedFds.push(opened.fd);
      // An owner-set entry may be a FOLDER: then every `.env` inside it is
      // masked too (a folder bound by fd is not in the ro/rw maps). A folder
      // granted read stays read-only: a read grant is never widened to write.
      if (opened.isDir) {
        bindOpenedDirFd(opened, write ? "dir-write" : "dir-read", spec.path, write ? "--bind-fd" : "--ro-bind-fd");
        return;
      }
      bindFd(opened.fd, write ? "file-write" : "file-read", write ? "--bind-fd" : "--ro-bind-fd", opened.realPath);
    };
    for (const spec of Array.isArray(files.read) ? files.read : []) {
      if (!spec || typeof spec.path !== "string" || !spec.path) continue;
      if (spec.source !== "owner") { refused.push({ path: spec.path, reason: "a manifest default is never bound" }); continue; }
      bindNamedFile(spec, "read");
    }
    for (const spec of Array.isArray(files.write) ? files.write : []) {
      if (!spec || typeof spec.path !== "string" || !spec.path) continue;
      if (spec.source !== "owner") { refused.push({ path: spec.path, reason: "a manifest default is never bound" }); continue; }
      bindNamedFile(spec, "write");
    }

    // ---- the sign-in folder: the PARENT of the named file, read-write ----
    const oauth = files.oauthDir;
    if (oauth && typeof oauth === "object" && typeof oauth.path === "string" && oauth.path) {
      if (oauth.source !== "owner") {
        refused.push({ path: oauth.path, reason: "a manifest default is never bound" });
      } else {
        const file = resolve(expandHome(oauth.path, home));
        const dir = dirname(file);
        const dirReal = realp(dir) || dir;
        const whyFor = (d) => {
          if (d === home) return "the whole home";
          if (dirname(d) === home) return "a direct child of the home";
          if (under(d, crowHomeReal)) return "the Crow home is never writable";
          for (const n of never) if (under(n, d)) return "an ancestor of a protected path (" + n + ")";
          return refusePath(d, { write: true });
        };
        const why = whyFor(dir) || whyFor(dirReal) || (exists(file) ? null : "the folder does not contain the named file");
        if (why) {
          refused.push({ path: oauth.path, reason: why });
        } else {
          let opened = null;
          try {
            opened = openCheckedBindSource(dir, { uid, home, refuse: (rp) => refusePath(rp, { write: true }), expect: "dir" });
          } catch (err) {
            if (!(err instanceof ContainRefused)) throw err;
            refused.push({ path: oauth.path, reason: err.message });
          }
          if (opened) {
            openedFds.push(opened.fd);
            bindOpenedDirFd(opened, "oauth-dir", oauth.path, "--bind-fd");
          }
        }
      }
    }

    // ---- the core state allowlist, read-write, real directories only ----
    for (const p of statePaths) {
      let st = null;
      try { st = lstatSync(p); } catch { continue; } // a missing one is skipped silently
      if (st.isSymbolicLink()) { refused.push({ path: p, reason: "a symlink is never bound" }); continue; }
      if (!st.isDirectory()) { refused.push({ path: p, reason: "not a directory" }); continue; }
      let opened = null;
      try {
        opened = openCheckedBindSource(p, { uid, home, refuse: (rp) => refusePath(rp, { write: true }), expect: "dir" });
      } catch (err) {
        if (!(err instanceof ContainRefused)) throw err;
        refused.push({ path: p, reason: err.message });
      }
      if (opened) {
        openedFds.push(opened.fd);
        bindOpenedDirFd(opened, "state", p, "--bind-fd");
      }
    }

    // ---- .env masks over every path-bound dir ----
    // The checkout, the node install and the installed copy are walked and every
    // .env in them is masked, at any depth. Nothing is kept readable by path:
    // an add-on's own `.env` is re-bound BY FD on top of its own mask below, so
    // a symlinked one cannot unmask a file the add-on does not own. The data
    // folder is bound by fd and holds only this add-on's own files, so nothing
    // Crow owns is reachable there.
    scanEnvMasks({ ro, rw, masks, policyDirs: new Set(), exists, home, refused });

    // ---- network ----
    const netCfg = profile.network && typeof profile.network === "object" ? profile.network : {};
    const hosts = Array.isArray(netCfg.hosts) ? netCfg.hosts.filter((h) => h && typeof h.host === "string") : [];
    const doors = Array.isArray(profile.doors) ? profile.doors : [];
    const selfTargets = Array.isArray(o.selfTargets) ? o.selfTargets : [];
    let net;
    if (netCfg.internet !== true && hosts.length === 0) {
      net = { sock: null, ports: [], proxyPort: null, selfTargets };
    } else {
      const ports = new Set();
      const gatewayPort = Number(o.gatewayPort);
      if (doors.length > 0 && Number.isInteger(gatewayPort) && gatewayPort > 0 && gatewayPort < 65536) ports.add(gatewayPort);
      for (const h of hosts) {
        if (!isLoopbackHost(h.host)) continue;
        const port = Number(h.port);
        if (Number.isInteger(port) && port > 0 && port < 65536) ports.add(port);
      }
      const served = [...ports].sort((a, b) => a - b);
      let proxyPort = PROXY_PORT;
      while (served.includes(proxyPort)) proxyPort++;
      if (o.relayDir) {
        const r = realp(o.relayDir);
        const why = r ? forbidden(r) : "does not exist";
        if (!r || why) refused.push({ path: String(o.relayDir), reason: "the relay socket folder cannot be bound (" + (why || "does not exist") + ")" });
        else extraEntries.push(["--ro-bind", r, NET_RELAY_MOUNT]);
      }
      net = { sock: NET_RELAY_MOUNT + "/relay.sock", ports: served, proxyPort, selfTargets };
      if (netCfg.internet === true || hosts.some((h) => !isLoopbackHost(h.host))) {
        const proxy = "http://127.0.0.1:" + proxyPort;
        Object.assign(env, {
          HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy, ALL_PROXY: proxy, all_proxy: proxy,
          NO_PROXY: "127.0.0.1,localhost,::1", no_proxy: "127.0.0.1,localhost,::1", NODE_USE_ENV_PROXY: "1",
        });
      }
    }

    // ---- the door token: bind DATA, never a path in a writable tree ----
    let doorTokenChildFd = null;
    if (typeof o.doorTokenFd === "number") {
      doorTokenChildFd = childFdFor();
      fdSpecs.push({ fd: o.doorTokenFd, childFd: doorTokenChildFd, role: "door-token", flag: "--ro-bind-data", dest: DOOR_TOKEN_MOUNT });
      extraEntries.push(["--ro-bind-data", String(doorTokenChildFd), DOOR_TOKEN_MOUNT]);
    }

    // ---- one mount list, in destination order ----
    const bindArgs = assembleBindArgs({ ro, rw, masks, extraEntries });
    if (doorTokenChildFd !== null) {
      const at = indexOfTriple(bindArgs, "--ro-bind-data", String(doorTokenChildFd), DOOR_TOKEN_MOUNT);
      // `--perms` applies to the bind that follows it.
      if (at >= 0) bindArgs.splice(at, 0, "--perms", "0400");
    }
    args.push(...bindArgs);

    // ---- the add-on's own .env: by fd, ON TOP of its own mask ----
    // The mask above covers `<installRoot>/.env` like every other .env. When the
    // manifest asks for it (`ownEnvFile`), the file itself is opened with the
    // checked walk and bound again by fd, after the mask, so it lands on top. It
    // must BE `<installRoot>/.env`: a symlink (or anything that resolves
    // elsewhere) names a file this add-on does not own, and is refused.
    if (profile.ownEnvFile === true) {
      const ownEnv = join(installRoot, ".env");
      if (exists(ownEnv)) {
        let opened = null;
        try {
          opened = openCheckedBindSource(ownEnv, {
            uid, home, expect: "file",
            refuse: (rp) => (rp !== ownEnv ? "the add-on's own environment file must be " + ownEnv : refusePath(rp, { ownEnv: true })),
          });
        } catch (err) {
          if (!(err instanceof ContainRefused)) throw err;
          refused.push({ path: ownEnv, reason: err.message });
        }
        if (opened) {
          openedFds.push(opened.fd);
          const childFd = childFdFor();
          fdSpecs.push({ fd: opened.fd, childFd, role: "own-env", flag: "--ro-bind-fd", dest: ownEnv });
          args.push("--ro-bind-fd", String(childFd), ownEnv);
        }
      }
    }

    args.push("--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup-try",
      "--unshare-net", "--cap-drop", "ALL", "--die-with-parent", "--new-session", "--chdir", installRoot);

    // The fds the child receives, in the order their args appear.
    const fds = fdSpecs
      .map((spec) => ({ spec, at: indexOfTriple(args, spec.flag, String(spec.childFd), spec.dest) }))
      .sort((a, b) => (a.at < 0 ? Number.MAX_SAFE_INTEGER : a.at) - (b.at < 0 ? Number.MAX_SAFE_INTEGER : b.at))
      .map(({ spec }) => ({ fd: spec.fd, childFd: spec.childFd, role: spec.role }));

    return { args, env, unsetEnv, fds, refused, net, addonDataDir };
  } catch (err) {
    // A refusal keeps the add-on off; nothing it opened may outlive the plan.
    for (const fd of openedFds) { try { closeSync(fd); } catch { /* already closed */ } }
    throw err;
  }
}

/** The index of one `[flag, src, dest]` triple, or -1. */
function indexOfTriple(args, flag, src, dest) {
  for (let i = 0; i + 2 < args.length; i++) {
    if (args[i] === flag && args[i + 1] === src && args[i + 2] === dest) return i;
  }
  return -1;
}