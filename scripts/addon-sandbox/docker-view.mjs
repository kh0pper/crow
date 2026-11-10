/**
 * One snapshot of this computer's docker/podman state, shaped for the add-on
 * wall's owner rules.
 *
 * The wall asks two questions of docker: which container publishes a loopback
 * port (`publishes`, for the root-owned listener case), and who is behind an
 * address on this computer (`containers` + `subnets` + `addonProjects`, for a
 * listed host that resolves to a container of some compose project).
 *
 * A compose project is only ever owned by an add-on when one of its containers
 * still carries the compose working_dir of an add-on's bundle folder:
 *
 *   <ownHome>/bundles/<id>[/...]        -> <id>
 *   <appRoot>/bundles/<id>[/...]        -> <id>, only when <id> is installed
 *                                          (or, from the gateway, has a local
 *                                          mcp-addons.json entry)
 *   <another home>/bundles/<id>[/...]   -> "other-instance:<id>"
 *   anything else                       -> no owner (a containerized Crow
 *                                          gateway, a repo checkout, a stale
 *                                          folder)
 *
 * A project whose containers name two different owners is left out of
 * `addonProjects` altogether, exactly like a project whose containers name no
 * add-on: it then reads as "project of no installed add-on" and no add-on may
 * claim it. A sentinel value would be a real add-on id waiting to happen (an
 * add-on called `conflict` would otherwise own every two-owner project), so an
 * owner value that is not a bundle id or `other-instance:<bundle id>` is left
 * out too. Real paths are compared, falling back to the raw label value when
 * it does not exist.
 *
 * The answer is cached briefly (a spawn makes many decisions), one build at a
 * time (concurrent callers share it), and a failed read is not cached. Callers
 * treat a rejection as a refusal.
 *
 * Node built-ins only; the docker runner and the clock are injectable.
 */
import { execFile } from "node:child_process";
import { realpathSync } from "node:fs";

/** A bundle id as the registry holds it. */
const BUNDLE_ID_RE = /^[a-z0-9][a-z0-9-]*$/;
/** The one other owner spelling: an add-on of a co-hosted Crow. */
const OTHER_INSTANCE_RE = /^other-instance:[a-z0-9][a-z0-9-]*$/;

/** An owner value a project map may carry: a bundle id, or another instance's. */
function ownerUsable(v) {
  return typeof v === "string" && (BUNDLE_ID_RE.test(v) || OTHER_INSTANCE_RE.test(v));
}
/** Enough room for a host with many containers. */
const MAX_BUFFER = 32 * 1024 * 1024;

function defaultRun(args) {
  return new Promise((resolve, reject) => {
    execFile("docker", args, { timeout: 5000, maxBuffer: MAX_BUFFER }, (err, stdout) => {
      if (err) reject(err);
      else resolve(String(stdout ?? ""));
    });
  });
}

/** The real path, or the value itself when it does not resolve. */
function realOr(p) {
  try { return realpathSync(p); } catch { return p; }
}

/** An absolute path without trailing slashes, or null. */
function cleanRoot(p) {
  const s = typeof p === "string" ? p.trim() : "";
  if (!s.startsWith("/")) return null;
  const t = s.replace(/\/+$/, "");
  return t === "" ? "/" : t;
}

/** The ids one line-per-entry listing holds. */
function lines(text) {
  return String(text || "").split("\n").map((l) => l.trim()).filter(Boolean);
}

/** A `docker inspect` answer (an array of objects). */
function parseList(text) {
  const v = JSON.parse(String(text || "[]"));
  if (!Array.isArray(v)) throw new Error("docker inspect: not a list");
  return v;
}

/**
 * The owner of a project whose container's working_dir is `dir`, or null.
 * `roots` are ordered: this home first, then the checkout, then other homes.
 */
function ownerOfDir(dir, roots, installed) {
  if (typeof dir !== "string" || !dir.trim()) return null;
  const real = realOr(dir.trim());
  for (const { root, kind } of roots) {
    const base = root === "/" ? "/bundles/" : root + "/bundles/";
    if (!real.startsWith(base)) continue;
    const rest = real.slice(base.length);
    const cut = rest.indexOf("/");
    const id = cut < 0 ? rest : rest.slice(0, cut);
    if (!BUNDLE_ID_RE.test(id)) return null;
    if (kind === "own") return id;
    if (kind === "app") return installed.has(id) ? id : null;
    return "other-instance:" + id;
  }
  return null;
}

function labelOf(labels, name) {
  const v = labels && typeof labels === "object" ? labels[name] : null;
  return typeof v === "string" ? v : "";
}

/**
 * @param {object} o
 * @param {Function} [o.run]          async (args) => stdout of `docker <args>`
 * @param {number} [o.ttlMs=2000]     how long one snapshot is reused
 * @param {string} [o.ownHome]        this Crow's home (CROW_HOME)
 * @param {string[]} [o.otherHomes]   other Crow homes on this computer
 * @param {string} [o.appRoot]        this Crow's checkout (CROW_APP_ROOT)
 * @param {Function} [o.installedIds] () => Set of the ids this Crow has installed or configured
 * @param {Function} [o.now]          clock (tests)
 * @returns {{snapshot: () => Promise<{publishes: object[], containers: object[], subnets: string[], addonProjects: Map<string,string>}>}}
 */
export function createDockerView({
  run,
  ttlMs = 2000,
  ownHome,
  otherHomes = [],
  appRoot,
  installedIds = () => new Set(),
  now = Date.now,
} = {}) {
  const exec = typeof run === "function" ? run : defaultRun;
  const ttl = Number.isFinite(Number(ttlMs)) && Number(ttlMs) >= 0 ? Number(ttlMs) : 2000;
  const roots = [
    { root: ownHome, kind: "own" },
    { root: appRoot, kind: "app" },
    ...(Array.isArray(otherHomes) ? otherHomes : []).map((h) => ({ root: h, kind: "other" })),
  ]
    .map((r) => ({ root: realOr(cleanRoot(r.root)), kind: r.kind }))
    .filter((r) => typeof r.root === "string" && r.root.startsWith("/"));

  const installedSet = () => {
    try {
      const v = installedIds();
      if (v instanceof Set) return v;
      return new Set(Array.isArray(v) ? v.map(String) : []);
    } catch {
      return new Set();
    }
  };

  function assemble(inspected, networks) {
    const installed = installedSet();
    const publishes = [];
    const containers = [];
    const subnets = [];
    const byProject = new Map(); // project -> Set of owners
    for (const c of inspected) {
      if (!c || typeof c !== "object") continue;
      const labels = c.Config && typeof c.Config === "object" ? c.Config.Labels : null;
      const project = labelOf(labels, "com.docker.compose.project").trim();
      const net = c.NetworkSettings && typeof c.NetworkSettings === "object" ? c.NetworkSettings : {};
      const ips = [];
      const nets = net.Networks && typeof net.Networks === "object" ? net.Networks : {};
      for (const n of Object.values(nets)) {
        if (!n || typeof n !== "object") continue;
        for (const field of ["IPAddress", "GlobalIPv6Address"]) {
          const v = n[field];
          if (typeof v === "string" && v.trim()) ips.push(v.trim());
        }
      }
      containers.push({ id: String(c.Id ?? ""), name: String(c.Name ?? ""), project, ips });
      const ports = net.Ports && typeof net.Ports === "object" ? net.Ports : {};
      for (const [spec, binds] of Object.entries(ports)) {
        if (!/\/tcp$/.test(spec)) continue;
        for (const b of Array.isArray(binds) ? binds : []) {
          if (!b || typeof b !== "object") continue;
          const hostPort = Number(b.HostPort);
          if (!Number.isInteger(hostPort) || hostPort < 1 || hostPort > 65535) continue;
          publishes.push({ hostIp: b.HostIp == null ? "" : String(b.HostIp), hostPort, project });
        }
      }
      if (project) {
        const owner = ownerOfDir(labelOf(labels, "com.docker.compose.project.working_dir"), roots, installed);
        // A container of the project with no add-on owner counts as an owner of
        // its own (""): a project that mixes an add-on's container with one from
        // anywhere else is a conflict, never the add-on's.
        if (!byProject.has(project)) byProject.set(project, new Set());
        byProject.get(project).add(owner || "");
      }
    }
    for (const n of networks) {
      if (!n || typeof n !== "object") continue;
      if (String(n.Driver ?? "") !== "bridge") continue;
      const ipam = n.IPAM && typeof n.IPAM === "object" ? n.IPAM : {};
      for (const conf of Array.isArray(ipam.Config) ? ipam.Config : []) {
        if (!conf || typeof conf !== "object") continue;
        const s = typeof conf.Subnet === "string" ? conf.Subnet.trim() : "";
        if (s && !subnets.includes(s)) subnets.push(s);
      }
    }
    const addonProjects = new Map();
    for (const [project, owners] of byProject) {
      // More than one owner, or an owner value of no recognisable shape, is no
      // owner at all: the project is dropped, never given a placeholder that
      // could collide with an add-on id.
      if (owners.size > 1) continue;
      const [only] = owners;
      if (ownerUsable(only)) addonProjects.set(project, only);
    }
    return { publishes, containers, subnets, addonProjects };
  }

  async function build() {
    const ids = lines(await exec(["ps", "-q", "--no-trunc"]));
    const inspected = ids.length ? parseList(await exec(["inspect", ...ids])) : [];
    const netIds = lines(await exec(["network", "ls", "-q", "--no-trunc"]));
    const networks = netIds.length ? parseList(await exec(["network", "inspect", ...netIds])) : [];
    return assemble(inspected, networks);
  }

  let cache = null; // { at, value }
  let inFlight = null; // the one build a burst of callers shares

  async function snapshot() {
    const at = Number(now());
    if (cache && at - cache.at <= ttl) return cache.value;
    if (inFlight) return inFlight;
    inFlight = (async () => {
      try {
        const value = await build();
        cache = { at: Number(now()), value };
        return value;
      } finally {
        inFlight = null;
      }
    })();
    return inFlight;
  }

  return { snapshot };
}