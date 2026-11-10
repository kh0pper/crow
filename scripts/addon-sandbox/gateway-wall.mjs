/**
 * The gateway's one wall context: everything a spawn site needs from THIS
 * process's view of the computer, built once and shared by the three spawn
 * sites (bundle add-ons, project-service children, built-in integrations).
 *
 * It answers four questions for a wall:
 *  - which paths are this Crow's own code and state (`crowRoots`), so the
 *    relay's listener check never treats a gateway or satellite of any checkout
 *    or co-hosted instance as the add-on's own service;
 *  - who owns a loopback listener, and who is behind a container address
 *    (the docker view, one snapshot reused for both answers);
 *  - which names and addresses are this host's own (`selfTargets`), so a listed
 *    host can never name the gateway itself;
 *  - what every manifest has ever shipped as a default
 *    (`registry/addon-past-defaults.json`), because an entry value that equals
 *    a manifest default was not typed by the owner.
 *
 * Nothing runs at creation and every answer is computed on first use: a
 * gateway with the walls off never asks docker, tailscale or the filesystem a
 * single question through this module. A missing or unreadable past-defaults
 * table is a refusal, never an empty table: with no table a legacy default
 * would be read as owner-entered, which widens the wall.
 *
 * Node built-ins only; every input that reaches out of the process (docker, the
 * tailscale status, the interface table, the listener identification, the spawn
 * wrapper) has a test seam in `deps`.
 */
import { lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { basename, dirname, join } from "node:path";

import { tailscaleStatusAsync } from "../../servers/shared/self-dial-address.js";
import { createDockerView } from "./docker-view.mjs";
import { bridgeSubnetsFromInterfaces, identifyContainerAddr, identifyListener } from "./listener-owner.mjs";
import { loadPolicySource, profileFor } from "./profile.mjs";
import { declaredEnvKeys } from "./wall-env.mjs";
import { AddonWallRefused, wrapAddonSpawn } from "./spawn.mjs";

/** Another Crow home beside this one (`~/.crow`, `~/.crow-r2`, …). */
const CO_HOSTED_HOME_RE = /^\.crow(-|$)/;
/** How long one `selfTargets` answer is reused. */
const SELF_TARGETS_TTL_MS = 60_000;
/** The past-defaults table, relative to the checkout. */
const PAST_DEFAULTS_REL = join("registry", "addon-past-defaults.json");
/** The gateway's own public names, when the operator set them. */
const SELF_URL_VARS = ["CROW_GATEWAY_URL", "CROW_PUBLIC_URL"];
/** The spawn kinds this context builds. */
const SPAWN_KINDS = new Set(["addon", "service", "builtin"]);
/** A project-service child's own folder: the same rule the plan applies. */
const SERVICE_SUBDIR_RE = /^services\/[0-9a-f][0-9a-f-]{7,63}$/;

/** An absolute path without trailing slashes ("/" kept), or null. */
function cleanPath(p) {
  const s = typeof p === "string" ? p.trim() : "";
  if (!s.startsWith("/")) return null;
  const t = s.replace(/\/+$/, "");
  return t === "" ? "/" : t;
}

/**
 * The path as given and, when it differs, the path it really is. A path that
 * does not exist yet is still worth both spellings: its parent's real path plus
 * its own name is where a later bind will land.
 */
function spellings(p) {
  const at = cleanPath(p);
  if (!at) return [];
  const out = [at];
  let real = null;
  try {
    real = realpathSync(at);
  } catch {
    try { real = join(realpathSync(dirname(at)), basename(at)); } catch { real = null; }
  }
  const clean = cleanPath(real);
  if (clean && !out.includes(clean)) out.push(clean);
  return out;
}

/** The hostname of a configured URL, or null when it does not parse. */
function hostOfUrl(raw) {
  const text = typeof raw === "string" ? raw.trim() : "";
  if (!text) return null;
  let url = null;
  try { url = new URL(text); } catch {
    try { url = new URL("https://" + text); } catch { return null; }
  }
  const host = String(url.hostname || "").replace(/^\[|\]$/g, "").toLowerCase();
  return host || null;
}

/** `err` as an AddonWallRefused, keeping a message that already says "add-on refused". */
function asRefused(err) {
  if (err instanceof AddonWallRefused) return err;
  const text = err && typeof err.message === "string" && err.message ? err.message : "the wall could not be built";
  return new AddonWallRefused(/^add-on refused/.test(text) ? text : "add-on refused: " + text);
}

/**
 * Create this gateway's wall context.
 *
 * @param {object} o
 * @param {string} o.crowHome        this instance's home (CROW_HOME)
 * @param {string} o.appRoot         this checkout
 * @param {string} o.dataDir         this instance's data dir
 * @param {string} o.home            the operator's home
 * @param {string} o.nodeBin         the node binary the wall runs
 * @param {number} o.gatewayPort     the port doors are served on
 * @param {object} [o.gatewayEnv]    the gateway's own env (public names only)
 * @param {object} [o.deps]          test seams: dockerView, identifyListener,
 *                                   tailscaleStatus, interfaces, wrapAddonSpawn
 * @returns {{crowRoots: string[], startAddonWall: Function, selfTargets: Function,
 *            listenerOwnerFor: Function, containerOwnerFor: Function}}
 */
export function createWallContext({
  crowHome,
  appRoot,
  dataDir,
  home,
  nodeBin,
  gatewayPort,
  gatewayEnv = process.env,
  deps = {},
} = {}) {
  const seam = deps && typeof deps === "object" ? deps : {};
  const env = gatewayEnv && typeof gatewayEnv === "object" ? gatewayEnv : {};

  let rootsCache = null;
  let viewCache = null;
  let pastDefaults; // undefined: not read yet
  let targetsCache = null;

  /** The other Crow homes beside this one, at their given path. */
  function coHostedHomePaths() {
    const own = new Set(spellings(crowHome));
    const out = [];
    let names = [];
    try { names = readdirSync(home); } catch { names = []; }
    for (const name of names) {
      if (!CO_HOSTED_HOME_RE.test(String(name))) continue;
      const at = join(home, String(name));
      if (spellings(at).some((p) => own.has(p))) continue;
      const clean = cleanPath(at);
      if (clean && !out.includes(clean)) out.push(clean);
    }
    return out;
  }

  /** This Crow's checkout, home and data dir, plus every co-hosted home, both spellings. */
  function crowRoots() {
    if (rootsCache) return rootsCache;
    const roots = [];
    const addAll = (p) => {
      for (const q of spellings(p)) if (!roots.includes(q)) roots.push(q);
    };
    addAll(appRoot);
    addAll(crowHome);
    addAll(dataDir);
    for (const p of coHostedHomePaths()) {
      for (const q of spellings(p)) if (!roots.includes(q)) roots.push(q);
    }
    rootsCache = roots;
    return roots;
  }

  /** The ids `<crowHome>/installed.json` lists, in any of its three shapes. */
  function installedIds() {
    const out = new Set();
    let raw = null;
    try { raw = JSON.parse(readFileSync(join(crowHome, "installed.json"), "utf8")); } catch { return out; }
    if (Array.isArray(raw)) {
      for (const entry of raw) {
        if (typeof entry === "string" && entry) out.add(entry);
        else if (entry && typeof entry === "object" && typeof entry.id === "string" && entry.id) out.add(entry.id);
      }
    } else if (raw && typeof raw === "object") {
      for (const key of Object.keys(raw)) if (key) out.add(key);
    }
    return out;
  }

  /** One docker view for every question a spawn asks. */
  function dockerView() {
    if (viewCache) return viewCache;
    const opts = {
      ownHome: crowHome,
      otherHomes: coHostedHomePaths(),
      appRoot,
      installedIds,
    };
    let made = null;
    if (typeof seam.dockerView === "function") made = seam.dockerView(opts);
    else if (seam.dockerView && typeof seam.dockerView === "object") made = seam.dockerView;
    else made = createDockerView(opts);
    if (!made || typeof made !== "object" || typeof made.snapshot !== "function") {
      throw new Error("the docker view did not start");
    }
    viewCache = made;
    return viewCache;
  }

  /** One snapshot, or null when docker cannot be read (every caller fails closed). */
  async function snapshotOrNull() {
    try {
      return await dockerView().snapshot();
    } catch {
      return null;
    }
  }

  /**
   * The relay's listener-owner check for one add-on. The Crow roots are passed
   * explicitly: the default inside `identifyListener` comes from the env, and a
   * gateway started without CROW_APP_ROOT would otherwise have none.
   */
  function listenerOwnerFor(id) {
    return async (addr, port) => {
      const snap = await snapshotOrNull();
      const identify = typeof seam.identifyListener === "function" ? seam.identifyListener : identifyListener;
      return identify(addr, port, {
        gatewayUid: typeof process.getuid === "function" ? process.getuid() : null,
        addonId: id,
        addonProjects: snap && snap.addonProjects instanceof Map ? snap.addonProjects : new Map(),
        docker: snap ? async () => snap.publishes : null,
        crowRoots: crowRoots(),
        selfPids: [process.pid],
      });
    };
  }

  /** The relay's container-address check for one add-on. */
  function containerOwnerFor(id) {
    return async (addr) => {
      const snap = await snapshotOrNull();
      const interfaces = typeof seam.interfaces === "function" ? seam.interfaces : networkInterfaces;
      let table = {};
      try { table = interfaces() || {}; } catch { table = {}; }
      return identifyContainerAddr(addr, {
        addonId: id,
        view: snap,
        bridgeSubnets: bridgeSubnetsFromInterfaces(table),
      });
    };
  }

  /** This host's own names and addresses, cached briefly. */
  async function selfTargets() {
    const at = Date.now();
    if (targetsCache && at - targetsCache.at < SELF_TARGETS_TTL_MS) {
      return { names: [...targetsCache.value.names], addrs: [...targetsCache.value.addrs] };
    }
    const names = new Set();
    const addrs = new Set();
    try {
      const name = hostname();
      if (name) names.add(String(name).toLowerCase());
    } catch { /* no hostname: the other sources still count */ }

    let status = null;
    try {
      const probe = typeof seam.tailscaleStatus === "function" ? seam.tailscaleStatus : tailscaleStatusAsync;
      status = await probe({ timeoutMs: 3000 });
    } catch { status = null; }
    const self = status && typeof status === "object" && status.Self && typeof status.Self === "object" ? status.Self : null;
    if (self) {
      const dns = typeof self.DNSName === "string" ? self.DNSName.replace(/\.$/, "").toLowerCase() : "";
      if (dns) names.add(dns);
      for (const ip of Array.isArray(self.TailscaleIPs) ? self.TailscaleIPs : []) {
        if (typeof ip === "string" && ip) addrs.add(ip);
      }
    }

    for (const key of SELF_URL_VARS) {
      const host = hostOfUrl(env[key]);
      if (host) names.add(host);
    }

    const interfaces = typeof seam.interfaces === "function" ? seam.interfaces : networkInterfaces;
    let table = {};
    try { table = interfaces() || {}; } catch { table = {}; }
    for (const list of Object.values(table)) {
      for (const entry of Array.isArray(list) ? list : []) {
        if (entry && typeof entry.address === "string" && entry.address) addrs.add(entry.address);
      }
    }

    const value = { names: [...names], addrs: [...addrs] };
    targetsCache = { at: Date.now(), value };
    return { names: [...value.names], addrs: [...value.addrs] };
  }

  /**
   * Every `env_vars[].default` each manifest has ever shipped, read once. A
   * table that cannot be read is a refusal: an empty one would read a legacy
   * default as owner-entered and widen the wall.
   */
  function pastDefaultsAll() {
    if (pastDefaults !== undefined) return pastDefaults;
    let doc = null;
    try {
      doc = JSON.parse(readFileSync(join(appRoot, PAST_DEFAULTS_REL), "utf8"));
    } catch {
      throw new AddonWallRefused("add-on refused: the past-defaults table cannot be read");
    }
    const defaults = doc && typeof doc === "object" ? doc.defaults : null;
    if (!defaults || typeof defaults !== "object" || Array.isArray(defaults)) {
      throw new AddonWallRefused("add-on refused: the past-defaults table cannot be read");
    }
    pastDefaults = defaults;
    return pastDefaults;
  }

  /** A plain directory (lstat: never a symlink), or an AddonWallRefused. */
  function realDirOrRefuse(dir, why) {
    let st = null;
    try { st = lstatSync(dir); } catch { st = null; }
    if (!st || !st.isDirectory()) throw new AddonWallRefused("add-on refused: " + why);
  }

  /** Create one folder at mode 0700 when it is missing; an existing one is left as it is. */
  function ensureDir(dir) {
    try {
      mkdirSync(dir, { mode: 0o700 });
    } catch (err) {
      if (err && err.code === "EEXIST") return;
      throw err;
    }
  }

  /**
   * Build one walled spawn for an add-on, a project-service child or a built-in.
   * Every failure is an AddonWallRefused: the caller leaves the add-on off.
   *
   * @param {object} o
   * @param {string} o.id
   * @param {object} o.entry     the mcp-addons.json entry (or the built-in's own)
   * @param {string} o.command
   * @param {string[]} o.args
   * @param {object} [o.baseEnv]  the gateway's env: the wall reads it only through its allowlist
   *                             and the reviewed manifest's declared keys, never spreads it
   * @param {object} [o.ownEnv]   the add-on's own env (entry env, connection values, derived)
   * @param {"addon"|"service"|"builtin"} o.kind
   * @param {string} [o.dataSubdir]  `services/<uuid>`, a project-service child only
   * @returns {Promise<object>} a WallResult
   */
  async function startAddonWall({ id, entry, command, args, baseEnv = process.env, ownEnv = {}, kind = "addon", dataSubdir } = {}) {
    try {
      if (!SPAWN_KINDS.has(kind)) throw new AddonWallRefused("add-on refused: unknown spawn kind");
      const pastDefaults = pastDefaultsAll();
      const profile = profileFor({
        id,
        entry: entry && typeof entry === "object" ? entry : {},
        appBundlesDir: join(appRoot, "bundles"),
        installedBundlesDir: join(crowHome, "bundles"),
        pastDefaultsAll: pastDefaults,
        gatewayPort,
      });

      let installDir;
      if (kind === "builtin") {
        // A built-in runs the checkout's own copy of its bundle, and its data
        // folder is Crow's to create (the install did it for an add-on).
        installDir = join(appRoot, "bundles", id);
        ensureDir(join(dataDir, id));
      } else if (kind === "service") {
        // One project-service child gets its own folder below the add-on's
        // data folder, so two projects' children never share a writable tree.
        // The subfolder name is checked BEFORE anything is created: its uuid comes
        // from crow.db, which a crow.db add-on can write, so it must never be a path.
        if (typeof dataSubdir !== "string" || !SERVICE_SUBDIR_RE.test(dataSubdir)) {
          throw new AddonWallRefused("add-on refused: invalid data subfolder");
        }
        const base = join(dataDir, id);
        // Each level is created only under a real directory (never through a
        // symlink the add-on planted in its own writable folder): mkdir follows a
        // symlinked parent, which would create a folder wherever it points.
        realDirOrRefuse(base, "the add-on's data folder is missing");
        ensureDir(join(base, "services"));
        realDirOrRefuse(join(base, "services"), "the services folder is not a plain folder");
        ensureDir(join(base, dataSubdir));
        realDirOrRefuse(join(base, dataSubdir), "the service child's folder is not a plain folder");
      }

      // The keys the add-on may take from the gateway env beyond the base allowlist:
      // only what its REVIEWED repo manifest declares (wall-env.mjs).
      // A bundle add-on only: a project-service child's credentials are its
      // connection's values (never the gateway's own token for that service), and
      // a built-in's own vars are already its ownEnv.
      let declaredKeys = [];
      let declaredSource = null;
      if (kind === "addon") try {
        const src = loadPolicySource({ id, appBundlesDir: join(appRoot, "bundles"), installedBundlesDir: join(crowHome, "bundles") });
        declaredSource = src && src.source === "repo" ? "repo" : null;
        declaredKeys = declaredEnvKeys(src && src.manifest, src && src.source);
      } catch { declaredKeys = []; declaredSource = null; }

      const wrap = typeof seam.wrapAddonSpawn === "function" ? seam.wrapAddonSpawn : wrapAddonSpawn;
      return await wrap({
        id,
        command,
        args,
        baseEnv,
        ownEnv,
        declaredKeys,
        declaredSource,
        profile,
        entry: { ...(entry && typeof entry === "object" ? entry : {}), command },
        crowHome,
        dataDir,
        appRoot,
        home,
        nodeBin,
        gatewayPort,
        installDir,
        dataSubdir,
        selfTargets: await selfTargets(),
        listenerOwner: listenerOwnerFor(id),
        containerOwner: containerOwnerFor(id),
      });
    } catch (err) {
      throw asRefused(err);
    }
  }

  return {
    get crowRoots() { return crowRoots(); },
    startAddonWall,
    selfTargets,
    listenerOwnerFor,
    containerOwnerFor,
  };
}