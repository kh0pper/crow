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
import { closeSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { hostname, networkInterfaces } from "node:os";
import { basename, dirname, join } from "node:path";

import { tailscaleStatusAsync } from "../../servers/shared/self-dial-address.js";
import { openCheckedBindSource } from "./bind-fd.mjs";
import { createDockerView } from "./docker-view.mjs";
import { bridgeSubnetsFromInterfaces, identifyContainerAddr, identifyListener, localOnlySubnets, TTS_PORT_EXCEPTION } from "./listener-owner.mjs";
import { composePortsFrom, profileFor } from "./profile.mjs";
import { AddonWallRefused, wrapAddonSpawn } from "./spawn.mjs";
import { labelPhrase } from "./words.mjs";

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
/** Why a wall is built: a real start, or the one prepare run before it. */
const WALL_PURPOSES = new Set(["run", "warmup"]);
/**
 * Every host a prepare run may reach: the package registries, and the copy and
 * archive hosts of a pinned git source. Frozen, and checked by name: the
 * prepare plan asks for these, and nothing else widens it.
 */
const WARMUP_HOSTS = Object.freeze([
  "registry.npmjs.org",
  "pypi.org",
  "files.pythonhosted.org",
  "github.com",
  "codeload.github.com",
]);
/** What a prepare run that asks for any other host is refused with. */
const WARMUP_HOSTS_REASON = "add-on refused: a warm-up may reach package registries only";
/** The profile refuse entry a changed installed copy produces. */
const INSTALLED_DIFFERS = "installed manifest differs";
/** The profile part kinds that describe what an add-on reaches. */
const NETWORK_LABEL_KINDS = new Set(["internet", "local-host", "network-host"]);
/** A project-service child's own folder: the same rule the plan applies. */
const SERVICE_SUBDIR_RE = /^services\/[0-9a-f][0-9a-f-]{7,63}$/;
/** An add-on id names folders, a relay dir and a data folder: one slug or nothing. */
const ADDON_ID_RE = /^[a-z0-9][a-z0-9-]*$/;

/** The two kernel route tables, as `localOnlySubnets` reads them. */
function readRouteTables() {
  const read = (p) => {
    try { return readFileSync(p, "utf8"); } catch { return ""; }
  };
  return { v4: read("/proc/net/route"), v6: read("/proc/net/ipv6_route") };
}

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

/** `err` as an AddonWallRefused, keeping its message and any code it already carries. */
function asRefused(err) {
  if (err instanceof AddonWallRefused) return err;
  const text = err && typeof err.message === "string" && err.message ? err.message : "the wall could not be built";
  return new AddonWallRefused(
    /^add-on refused/.test(text) ? text : "add-on refused: " + text,
    err && typeof err.code === "string" ? err.code : null,
  );
}

/**
 * The one exception to "an add-on cannot name another add-on's service": a
 * media add-on reaches the local TTS ports its compose project publishes.
 *
 * The ports come from the REPO copy of the TTS bundle (compose file and
 * manifest: the installed copy is writable by unwalled code), the project name
 * from one docker snapshot, and the ids from `installed.json`. Every host this
 * function adds carries `source: "gateway-tts"` and the project that owns it, so
 * the relay re-checks the named exception instead of trusting a name. Any host
 * already carrying that source is dropped first: this function is the only
 * place one may come from.
 *
 * No snapshot, no installed entry, no repo manifest, or a project value shared
 * by two projects: that TTS add-on adds nothing.
 *
 * @param {object} profile   a `profileFor` result
 * @param {object} o
 * @param {string} o.id      the add-on being walled
 * @param {string} o.appRoot this Crow's checkout
 * @param {Function|Set} o.installedIds
 * @param {object|null} o.snapshot  the docker view's snapshot
 * @returns {object} a new profile
 */
export async function withGatewayTtsHosts(profile, { id, appRoot, installedIds, snapshot } = {}) {
  const source = profile && typeof profile === "object" ? profile : {};
  const net = source.network && typeof source.network === "object" ? source.network : {};
  const hosts = (Array.isArray(net.hosts) ? net.hosts : []).filter((h) => h && h.source !== "gateway-tts");
  const labelParts = Array.isArray(source.labelParts) ? [...source.labelParts] : [];
  const label = {
    en: Array.isArray(source.label?.en) ? [...source.label.en] : [],
    es: Array.isArray(source.label?.es) ? [...source.label.es] : [],
  };
  const withHosts = () => ({ ...source, network: { ...net, hosts }, labelParts, label });

  const ttsIds = Object.prototype.hasOwnProperty.call(TTS_PORT_EXCEPTION, id) ? TTS_PORT_EXCEPTION[id] : null;
  if (!Array.isArray(ttsIds) || ttsIds.length === 0) return source;
  const projects = snapshot && snapshot.addonProjects instanceof Map ? snapshot.addonProjects : null;
  if (!projects) return withHosts();

  let ids = null;
  try {
    const raw = typeof installedIds === "function" ? installedIds() : installedIds;
    ids = raw instanceof Set ? raw : new Set(Array.isArray(raw) ? raw.map(String) : []);
  } catch {
    ids = new Set();
  }
  if (!ids) return withHosts();

  for (const ttsId of ttsIds) {
    if (typeof ttsId !== "string" || !ids.has(ttsId)) continue;
    const dir = join(appRoot, "bundles", ttsId);
    const manifestPath = join(dir, "manifest.json");
    if (!existsSync(manifestPath)) continue; // the repo copy only
    let manifest = null;
    try { manifest = JSON.parse(readFileSync(manifestPath, "utf8")); } catch { continue; }
    const composeRel = typeof manifest?.docker?.composefile === "string" && manifest.docker.composefile
      ? manifest.docker.composefile
      : "docker-compose.yml";
    let composeText = "";
    try { composeText = readFileSync(join(dir, composeRel), "utf8"); } catch { continue; }
    const ports = composePortsFrom(composeText, manifest);
    if (!ports.length) continue;
    const owners = [...projects.entries()].filter(([, value]) => value === ttsId).map(([project]) => project);
    if (owners.length !== 1) continue;
    const ownerProject = owners[0];
    const labelName = typeof manifest.name === "string" && manifest.name ? manifest.name : ttsId;
    for (const port of ports) {
      hosts.push({ host: "127.0.0.1", port, scheme: "http", from: "tts:" + ttsId, source: "gateway-tts", ownerProject });
      const part = { kind: "local-host", label: labelName, host: "127.0.0.1", port };
      const [en, es] = labelPhrase(part);
      let at = 0;
      for (let i = 0; i < labelParts.length; i++) {
        if (NETWORK_LABEL_KINDS.has(labelParts[i]?.kind)) at = i + 1;
      }
      labelParts.splice(at, 0, part);
      if (label.en.length > at) label.en.splice(at, 0, en);
      else label.en.push(en);
      if (label.es.length > at) label.es.splice(at, 0, es);
      else label.es.push(es);
    }
  }
  return withHosts();
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
 *                                   tailscaleStatus, interfaces, routes,
 *                                   wrapAddonSpawn, afterServicesDir
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

  /**
   * The ids this Crow has configured: everything `installed.json` lists, plus
   * every key of `<crowHome>/mcp-addons.json`. An add-on with its own
   * mcp-addons.json entry is configured on this Crow even when installed.json
   * does not list it (a checkout-linked add-on), so a container its checkout
   * compose folder started is its own; only that same id can ever claim such a
   * project, and mcp-addons.json is never bound into any wall. Read fresh on
   * each call; a missing, unreadable or unparseable file adds nothing.
   */
  function configuredIds() {
    const out = installedIds();
    let raw = null;
    try { raw = JSON.parse(readFileSync(join(crowHome, "mcp-addons.json"), "utf8")); } catch { return out; }
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) return out;
    for (const key of Object.keys(raw)) if (ADDON_ID_RE.test(key)) out.add(key);
    return out;
  }

  /** One docker view for every question a spawn asks. */
  function dockerView() {
    if (viewCache) return viewCache;
    const opts = {
      ownHome: crowHome,
      otherHomes: coHostedHomePaths(),
      appRoot,
      installedIds: configuredIds,
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
      const named = bridgeSubnetsFromInterfaces(table);
      let bridgeSubnets = named;
      if (!snap) {
        // No docker view: the ranges the read would have named are unknown, so
        // every local interface but loopback and the way off this computer counts
        // as one, named bridges included.
        let routes = {};
        try {
          const probe = typeof seam.routes === "function" ? seam.routes : readRouteTables;
          const r = probe();
          routes = r && typeof r === "object" ? r : {};
        } catch { routes = {}; }
        bridgeSubnets = [...new Set([...named, ...localOnlySubnets(table, routes)])];
      }
      return identifyContainerAddr(addr, { addonId: id, view: snap, bridgeSubnets });
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
   * Create `<base>/services` and `<base>/services/<uuid>`, each mkdir made
   * THROUGH a directory fd opened the way a bind source is (`bind-fd.mjs`:
   * component by component, never following a symlink). The add-on owns
   * `<base>`, so a symlink planted there must never redirect a mkdir into
   * another add-on's folder, and a name swapped between the two steps is caught
   * when the next one is opened. Both fds are closed here.
   */
  function createServiceSubdir(base, subdir) {
    const uuid = String(subdir).slice("services/".length);
    let baseFd = null;
    let servicesFd = null;
    try {
      baseFd = openCheckedBindSource(base, { expect: "dir", home }).fd;
      try {
        mkdirSync("/proc/self/fd/" + baseFd + "/services", { mode: 0o700 });
      } catch (err) {
        if (!err || err.code !== "EEXIST") throw err;
      }
      if (typeof seam.afterServicesDir === "function") seam.afterServicesDir(join(base, "services"));
      servicesFd = openCheckedBindSource(join(base, "services"), { expect: "dir", home }).fd;
      try {
        mkdirSync("/proc/self/fd/" + servicesFd + "/" + uuid, { mode: 0o700 });
      } catch (err) {
        if (!err || err.code !== "EEXIST") throw err;
      }
    } finally {
      for (const fd of [servicesFd, baseFd]) {
        if (!Number.isInteger(fd)) continue;
        try { closeSync(fd); } catch { /* already closed */ }
      }
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
   * @param {"run"|"warmup"} [o.purpose]  a real start, or the one prepare run before it
   * @param {string[]} [o.warmupHosts]  a prepare run's egress: registry names, port 443 only
   * @returns {Promise<object>} a WallResult
   */
  async function startAddonWall({ id, entry, command, args, baseEnv = process.env, ownEnv = {}, kind = "addon", dataSubdir, purpose = "run", warmupHosts } = {}) {
    try {
      // The id names folders below the data dir and, for a built-in, the
      // checkout's own bundle: checked before anything touches the filesystem.
      if (typeof id !== "string" || !ADDON_ID_RE.test(id)) {
        throw new AddonWallRefused("add-on refused: invalid add-on id");
      }
      if (!SPAWN_KINDS.has(kind)) throw new AddonWallRefused("add-on refused: unknown spawn kind");
      if (!WALL_PURPOSES.has(purpose)) throw new AddonWallRefused("add-on refused: unknown wall purpose");
      const pastDefaults = pastDefaultsAll();
      let profile = profileFor({
        id,
        entry: entry && typeof entry === "object" ? entry : {},
        appBundlesDir: join(appRoot, "bundles"),
        installedBundlesDir: join(crowHome, "bundles"),
        pastDefaultsAll: pastDefaults,
        gatewayPort,
      });
      // A first-party add-on whose installed policy differs from the repo copy:
      // the installed manifest's sandbox block is the one unwalled code could edit.
      if (Array.isArray(profile.refused) && profile.refused.some((r) => r && r.what === INSTALLED_DIFFERS)) {
        throw new AddonWallRefused("add-on refused: its installed files differ from Crow's copy", "installed-changed");
      }
      if (purpose === "warmup") {
        // The prepare run fetches packages and reaches nothing else: the hosts
        // its plan names, each an exact CONNECT entry on 443, no general
        // internet, no door, no token. A host outside the frozen list is a
        // refusal rather than a wider wall.
        const names = Array.isArray(warmupHosts) ? warmupHosts : [];
        for (const name of names) {
          if (typeof name !== "string" || !WARMUP_HOSTS.includes(name)) throw new AddonWallRefused(WARMUP_HOSTS_REASON, "warmup");
        }
        // It also gets none of the add-on's own things: a prepare run executes
        // package code, so no crow.db, no owner file or folder, no state
        // folder, no sign-in folder and no own .env reach it.
        profile = {
          ...profile,
          network: {
            internet: false,
            hosts: names.map((h) => ({ host: h, port: 443, scheme: "https", from: "warmup", source: "warmup" })),
          },
          doors: [],
          crowDb: false,
          files: { read: [], write: [], oauthDir: null, state: [] },
          ownEnvFile: false,
        };
      } else if (Object.prototype.hasOwnProperty.call(TTS_PORT_EXCEPTION, id)) {
        profile = await withGatewayTtsHosts(profile, { id, appRoot, installedIds, snapshot: await snapshotOrNull() });
      }

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
        // The data dir at its REAL path: the checked opens refuse any symlinked
        // component, and a host whose home or data dir is reached through a
        // symlink must still get its service children (as plan.mjs uses dataReal).
        let dataReal = dataDir;
        try { dataReal = realpathSync(dataDir); } catch { /* missing: the check below refuses */ }
        const base = join(dataReal, id);
        // Each level is created only under a real directory (never through a
        // symlink the add-on planted in its own writable folder): both mkdirs go
        // through fds opened component by component without following links.
        realDirOrRefuse(base, "the add-on's data folder is missing");
        createServiceSubdir(base, dataSubdir);
        realDirOrRefuse(join(base, "services"), "the services folder is not a plain folder");
        realDirOrRefuse(join(base, dataSubdir), "the service child's folder is not a plain folder");
      }

      const wrap = typeof seam.wrapAddonSpawn === "function" ? seam.wrapAddonSpawn : wrapAddonSpawn;
      return await wrap({
        id,
        command,
        args,
        baseEnv,
        ownEnv,
        // A prepare run gets the narrowest env rule whatever kind was passed: no
        // declared key from the gateway env, no storage passthrough. Its plan env
        // is the only own env it carries.
        envKind: purpose === "warmup" ? "service" : kind,
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