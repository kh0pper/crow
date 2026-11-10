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
 * Everything an add-on can write is bound BY FD, never by path (review focus
 * 5): its data folder, its state folders, a sign-in folder it owns, and every
 * owner-set file. Read-only code (the checkout, the node install, the install
 * folder) keeps the path binds the bot plan uses, with every `.env` masked.
 */
import { closeSync, existsSync, lstatSync, readdirSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

import {
  ContainRefused,
  ENV_NAME_RE,
  NET_RELAY_MOUNT,
  assembleBindArgs,
  makeBindPolicy,
  maskPathInto,
  rootArgs,
  scanEnvMasks,
} from "../pi-bots/pi_contain.mjs";
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

    /**
     * The one refuse list: applied to a path before it is bound, again to its
     * real path, and passed as `refuse` to every checked open.
     */
    function refusePath(p, { write = false } = {}) {
      if (typeof p !== "string" || !p || !isAbsolute(p)) return "not an absolute path";
      const base = basename(p);
      if (ENV_NAME_RE.test(base)) return "an environment file is never bound";
      if (base === "mcp-addons.json") return "Crow's add-on registry is never bound";
      if (base === "addon-walls.json") return "the wall settings are never bound";
      for (const n of [...crowSecrets, ...tokenFiles]) {
        if (p === n || under(p, n)) return "a Crow secret is never bound (" + n + ")";
      }
      if (under(p, crowHomeReal) && !allowedCrowHomeRoots.some((r) => under(p, r))) {
        return "the Crow home is not a bind source outside this add-on's own folders";
      }
      return forbidden(p, { write });
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

    // The command itself, never its `dirname(dirname(...))`: that root can be
    // an ancestor of a never-bound path (delta 11).
    const command = typeof entry.command === "string" ? entry.command : "";
    const commandBase = command ? basename(command) : "";
    const pathEnv = typeof o.pathEnv === "string" ? o.pathEnv : (process.env.PATH || "");
    const commandFile = isAbsolute(command) ? (exists(command) ? resolve(command) : null) : (command ? which(command, pathEnv, exists) : null);
    if (commandFile) {
      const r = realp(commandFile);
      const why = r ? refusePath(r) : null;
      if (why) refused.push({ path: commandFile, reason: why });
      else if (r && !under(r, "/usr") && !under(r, "/opt")) add(ro, r, { label: "add-on command" });
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
          const base = basename(d);
          if (base === "autostart" || base === "systemd") return "an autostart or systemd folder";
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
            bindFd(opened.fd, "oauth-dir", "--bind-fd", opened.realPath);
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
        bindFd(opened.fd, "state", "--bind-fd", opened.realPath);
      }
    }

    // ---- .env masks over every path-bound dir ----
    // The checkout, the node install and the install folder are walked and every
    // .env in them is masked; the add-on's own .env stays readable when its
    // manifest asks for it. The data folder is bound by fd and holds only this
    // add-on's own files, so nothing Crow owns is reachable there.
    const keep = new Set();
    if (profile.ownEnvFile === true) {
      const own = join(installRoot, ".env");
      keep.add(own);
      const ownReal = realp(own);
      if (ownReal) keep.add(ownReal);
    }
    scanEnvMasks({ ro, rw, masks, policyDirs: new Set(), exists, home, refused, keep: keep.size ? keep : null });

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