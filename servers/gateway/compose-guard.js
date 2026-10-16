/**
 * The install security check, on the compose model Docker Compose itself applies.
 *
 * The text check (validateComposeFile in routes/bundles.js) reads docker-compose.yml as
 * written, which leaves a gap between what it reads and what Compose runs: YAML anchors
 * and merge keys, flow/JSON style, interpolated `${VAR}` host paths, override files,
 * COMPOSE_FILE in .env, symlinks inside the bundle, top-level volumes with a bind
 * `device`. This module closes the gap by asking Compose for the model it will apply
 * (`docker compose config --format json`, run in the bundle dir with the same env as
 * `up`) and checking THAT, then resolving every host path through symlinks.
 *
 * Fail-closed: if Compose cannot produce a model, the bundle is refused. A model it
 * cannot reason about (unknown volume shape) is refused too.
 *
 * Every gateway path that runs `compose up` calls checkBundleCompose first: install
 * (single and collection: both go through runInstallJob), Start/recreate, and the
 * shared-storage re-apply.
 */
import { existsSync, readFileSync, realpathSync, lstatSync, readlinkSync, statSync } from "node:fs";
import { join, resolve as resolvePath, dirname, basename, sep, isAbsolute } from "node:path";
import { homedir } from "node:os";

// A value Compose sees for a `${VAR:?}` the install left blank (a collection member,
// finished later with Configure): relative, so it resolves inside the bundle dir.
export const UNSET_SENTINEL = "./crow-unset-value";

/** realpath of p, or of its nearest existing ancestor + the rest (a path Docker would create). */
export function resolveHostPath(p, depth = 0) {
  let cur = resolvePath(p);
  const rest = [];
  for (;;) {
    try {
      const real = realpathSync(cur);
      return rest.length ? join(real, ...rest.reverse()) : real;
    } catch {
      // A dangling symlink still decides where Docker creates the path: follow it.
      try {
        if (depth < 40 && lstatSync(cur).isSymbolicLink()) {
          const target = resolvePath(dirname(cur), readlinkSync(cur));
          return resolveHostPath(rest.length ? join(target, ...rest.reverse()) : target, depth + 1);
        }
      } catch { /* not there at all */ }
      const parent = dirname(cur);
      if (parent === cur) return resolvePath(p);
      rest.push(basename(cur));
      cur = parent;
    }
  }
}

const under = (p, root) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

/**
 * @param {object} ctx
 * @param {string} ctx.crowHome
 * @param {string} [ctx.dataDir]   the instance's data dir (crow.db lives here)
 * @param {string} [ctx.appRoot]   the gateway checkout (its .env holds gateway secrets)
 * @param {string} [ctx.home]
 */
export function sensitiveRoots(ctx) {
  const home = ctx.home || homedir();
  const real = (p) => resolveHostPath(p);
  const crowHome = real(ctx.crowHome);
  const dataDirs = [...new Set([ctx.dataDir, join(ctx.crowHome, "data"), join(home, ".crow", "data")].filter(Boolean).map(real))];
  const sys = ["/etc", "/root", "/boot", "/usr", "/bin", "/sbin", "/lib", "/lib32", "/lib64", "/libx32", "/opt", "/var", "/run", "/dev", "/snap", "/proc", "/sys"];
  return {
    crowHome,
    dataDirs,
    home: real(home),
    homesRoot: real(dirname(home)),
    exact: new Set([real("/"), real(home), real(dirname(home)), ...(ctx.appRoot ? [real(ctx.appRoot)] : [])]),
    trees: [
      ...sys.map((d) => ({ root: real(d), why: d, hostInfo: d === "/proc" || d === "/sys" })),
      ...(ctx.appRoot ? [{ root: real(ctx.appRoot), why: "the gateway's code and .env" }] : []),
      // Every folder on the gateway's PATH: a writable one is code the host runs.
      ...[...new Set(String(ctx.path ?? process.env.PATH ?? "").split(":").filter((d) => d.startsWith("/")))]
        .map((d) => ({ root: real(d), why: `a folder on PATH (${d})` })),
    ],
    dockerSockets: new Set(["/var/run/docker.sock", "/run/docker.sock", real("/var/run/docker.sock"), real("/run/docker.sock")]),
    localtime: real("/etc/localtime"),
  };
}

// ---- the allowlist -------------------------------------------------------------------
// Every key Compose can emit for a service / top-level item is listed here with how it is
// treated. A key that is not listed refuses the bundle (fail-closed): new Compose
// features have to be read and classified before a bundle may use them.
//   "ok"    inert for host access (resources, metadata, container-internal settings)
//   "priv"  any non-default value needs privileged + consent (never for community)
//   fn      validated by its function below
const SAFE_CAPS = new Set(["CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID", "KILL", "SETGID", "SETUID", "SETPCAP", "NET_BIND_SERVICE", "SYS_CHROOT", "MKNOD", "AUDIT_WRITE", "SETFCAP", "SYS_NICE", "SYS_RESOURCE", "IPC_LOCK"]);
const SERVICE_OK = new Set([
  "image", "command", "entrypoint", "environment", "container_name", "hostname", "domainname", "ports", "expose",
  "restart", "healthcheck", "depends_on", "labels", "annotations", "working_dir", "user", "init", "mem_limit",
  "mem_reservation", "memswap_limit", "mem_swappiness", "cpus", "cpu_shares", "cpu_quota", "cpu_period", "cpuset",
  "cpu_count", "cpu_percent", "cpu_rt_runtime", "cpu_rt_period", "shm_size", "stop_signal", "stop_grace_period",
  "tty", "stdin_open", "read_only", "tmpfs", "ulimits", "extra_hosts", "dns", "dns_search", "dns_opt", "pull_policy",
  "platform", "profiles", "attach", "cap_drop", "logging", "pids_limit", "blkio_config", "mac_address", "scale",
  "secrets", "configs", "links", "group_add", "stop_timeout", "networks", "gpus", "deploy", "runtime", "sysctls",
  "oom_score_adj", "privileged", "cap_add", "security_opt", "network_mode", "pid", "ipc", "uts", "userns_mode",
  "cgroup", "devices", "volumes", "env_file", "build", "label_file", "volumes_from",
]);
const SERVICE_PRIV = new Set(["cgroup_parent", "device_cgroup_rules", "external_links", "isolation", "storage_opt",
  "credential_spec", "oom_kill_disable", "use_api_socket", "post_start", "pre_stop", "develop", "models", "provider"]);
const TOP_OK = new Set(["name", "services", "networks", "volumes", "secrets", "configs"]);
// Top-level entries of a bundle folder that the gateway reads or runs.
const BUNDLE_CONTROL = new Set(["manifest.json", "docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml",
  "docker-compose.override.yml", "docker-compose.override.yaml", "compose.override.yml", "compose.override.yaml",
  ".env", ".env.example", "package.json", "package-lock.json", "node_modules", "server", "panel", "scripts", "ops", "skills", "public", "bin"]);
// Names Crow itself uses directly under CROW_HOME: no bundle id may claim them as its own.
export const RESERVED_HOME_NAMES = new Set(["data", "secrets", "bundles", "panels", "skills", "media", "backups", "env", "logs",
  "p4", "pi-bots", "eval", "blog", "bin", "tmp", "cache", "config", "android-keystore", "keychain", "identity", "peer",
  "mcp", "models", "board", "phone-token", "artifacts-sidecar", "browser-sessions", "instances", "installed", "live2d-models"]);

/**
 * Check a Compose model (the parsed `docker compose config --format json` output).
 * @returns {{valid: true} | {valid: false, reason: string}}
 */
export function checkComposeModel(model, { bundleDir, manifest, consentVerified = false, ctx }) {
  const isPrivilegedAllowed = !!(manifest?.privileged && consentVerified && manifest?.origin !== "community");
  const isConsentBundle = !!(manifest?.consent_required && consentVerified && manifest?.origin !== "community");
  const roots = sensitiveRoots(ctx);
  const bundleReal = resolveHostPath(bundleDir);
  const ownId = /^[a-z0-9][a-z0-9-]*$/.test(String(manifest?.id || "")) ? manifest.id : null;
  const refuse = (reason) => ({ valid: false, reason });
  const needPriv = (what) => (isPrivilegedAllowed ? null : refuse(`Compose file uses ${what} but manifest does not declare 'privileged: true' (or consent was not verified)`));
  const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
  if (!isObj(model) || !isObj(model.services)) return refuse("Docker Compose produced no services model");
  for (const k of Object.keys(model)) {
    if (!TOP_OK.has(k) && !k.startsWith("x-")) return refuse(`top-level key '${k}' is not one the install check understands`);
  }

  // Host-path policy. Inside Crow's home and data folder it is an ALLOWLIST: the bundle's
  // own folder, CROW_HOME/<id> or <id>-*, <data>/<id>, CROW_HOME/media (library defaults),
  // and, read-only with privileged consent, crow.db and the extensions folder (companion).
  // Elsewhere: system folders, the gateway checkout, home dot-folders and ~/bin are
  // refused, and so is any folder that CONTAINS one of these.
  const checkOne = (p, { readOnly, what }) => {
    if (roots.dockerSockets.has(p)) {
      if (!readOnly) return refuse("Read-write Docker socket mounts are not permitted");
      if (!isConsentBundle && !isPrivilegedAllowed) return refuse("Docker socket mount requires manifest 'consent_required: true' and verified consent");
      return null;
    }
    if (roots.exact.has(p)) return refuse(`${what}: mounts a sensitive host path (${p === "/" ? "/" : "a top-level folder"})`);
    if ((p === "/etc/localtime" || p === roots.localtime) && readOnly) return null;
    const zones = [roots.crowHome, ...roots.dataDirs];
    if (zones.some((z) => under(z, p) && z !== p)) return refuse(`${what}: mounts a folder that contains Crow's home or data folder`);
    for (const d of roots.dataDirs) {
      if (!under(p, d)) continue;
      if (readOnly && isPrivilegedAllowed && p === join(d, "crow.db")) return null;
      if (ownId && under(p, join(d, ownId))) return null;
      return refuse(`${what}: mounts a path in Crow's data folder outside its own <data>/${ownId || "<id>"}`);
    }
    if (under(p, roots.crowHome)) {
      const rel = p.slice(roots.crowHome.length + 1);
      const first = rel.split(sep)[0];
      if (under(p, bundleReal)) {
        // The bundle's own folder, but never the folder itself or its control files read-write:
        // the gateway reads the manifest, compose file and .env, and runs server/ code, so a
        // container that could rewrite them could grant itself privileges at the next Start.
        if (!readOnly && (p === bundleReal || BUNDLE_CONTROL.has(p.slice(bundleReal.length + 1).split(sep)[0]))) {
          return refuse(`${what}: mounts the bundle's own control files read-write`);
        }
        return null;
      }
      // CROW_HOME/<id> (a folder, or not created yet) and CROW_HOME/<id>-downloads. Never a
      // name Crow itself uses there, and never an existing file (tokens, registries).
      if (ownId && !RESERVED_HOME_NAMES.has(ownId) && (first === ownId || first === `${ownId}-downloads`)) {
        const top = join(roots.crowHome, first);
        let isFile = false;
        try { isFile = !statSync(top).isDirectory(); } catch { /* not there yet */ }
        if (!isFile) return null;
      }
      if (first === "media" && rel !== "media") return null;
      if (readOnly && isPrivilegedAllowed && p === join(roots.crowHome, "bundles")) return null;
      return refuse(`${what}: mounts a path in Crow's home that is not this bundle's own`);
    }
    // Home folders (this user's and others'): dot-folders and ~/bin hold shells, keys,
    // autostart and user services.
    if (under(p, roots.homesRoot) && p !== roots.homesRoot) {
      const parts = p.slice(roots.homesRoot.length + 1).split(sep);
      if (parts.length === 1) return refuse(`${what}: mounts a whole home folder`);
      if (parts[1].startsWith(".") || parts[1] === "bin") return refuse(`${what}: mounts a home folder's ${parts[1]}`);
    }
    for (const t of roots.trees) {
      if (!(under(p, t.root) || under(t.root, p))) continue;
      if (t.hostInfo && readOnly && under(p, t.root) && (isConsentBundle || isPrivilegedAllowed)) continue;
      return refuse(`${what}: mounts a sensitive host path (${t.why})`);
    }
    // A git working tree (another Crow checkout, lab scripts that timers run): code. Walk up
    // from the path to the filesystem root looking for .git, and refuse a folder holding one.
    for (let d = p; ; d = dirname(d)) {
      if (existsSync(join(d, ".git"))) return refuse(`${what}: mounts a git checkout (code something on this host may run)`);
      if (dirname(d) === d) break;
    }
    return null;
  };
  /** Both the path as written and where it really leads (symlinks, dangling ones too). */
  const checkHostPath = (src, { readOnly, what }) => {
    if (typeof src !== "string" || src === "") return refuse(`${what}: a host path Compose could not resolve`);
    if (!isAbsolute(src)) return refuse(`${what}: a host path that is not absolute after Compose resolved it (${src.slice(0, 80)})`);
    const lex = resolvePath(src);
    const real = resolveHostPath(src);
    return checkOne(lex, { readOnly, what }) || (real !== lex ? checkOne(real, { readOnly, what }) : null);
  };
  const insideBundle = (src, what, { allowOutside = false } = {}) => {
    if (typeof src !== "string" || src === "") return refuse(`${what}: a path Compose could not resolve`);
    if (!isAbsolute(src)) return refuse(`${what}: a path that is not absolute after Compose resolved it`);
    const p = resolveHostPath(src);
    if (under(p, bundleReal) || allowOutside) return null;
    return refuse(`${what}: reads a host path outside the bundle`);
  };
  const checkKeys = (obj, allowed, what) => {
    if (!isObj(obj)) return refuse(`${what}: not a mapping`);
    for (const k of Object.keys(obj)) if (!allowed.includes(k)) return refuse(`${what}: key '${k}' is not one the install check understands`);
    return null;
  };

  const networkNames = new Set(Object.keys(model.networks || {}));
  for (const [name, s] of Object.entries(model.services)) {
    const tag = `service ${name}`;
    if (!isObj(s)) return refuse(`${tag}: not a mapping`);
    let r;
    for (const k of Object.keys(s)) {
      if (SERVICE_PRIV.has(k)) { if ((r = needPriv(`${k}`))) return r; continue; }
      if (!SERVICE_OK.has(k)) return refuse(`${tag}: key '${k}' is not one the install check understands`);
    }
    if (s.privileged !== undefined && s.privileged !== false && (r = needPriv("privileged mode"))) return r;
    for (const c of s.cap_add || []) {
      const cap = String(c).toUpperCase().replace(/^CAP_/, "");
      if (!SAFE_CAPS.has(cap) && (r = needPriv(`a capability outside the safe set (${cap})`))) return r;
    }
    const nm = s.network_mode === undefined ? "" : String(s.network_mode);
    if (nm && !(nm === "bridge" || nm === "none" || nm === "default" || nm.startsWith("service:")) && (r = needPriv(`network_mode ${nm}`))) return r;
    for (const k of ["pid", "ipc", "uts", "userns_mode", "cgroup"]) {
      if (s[k] === undefined) continue;
      const v = String(s[k]);
      const ok = (k === "ipc" && (v === "private" || v === "shareable" || v.startsWith("service:"))) || (k === "cgroup" && v === "private") || (k === "pid" && v.startsWith("service:"));
      if (!ok && (r = needPriv(`${k}: ${v}`))) return r;
    }
    for (const o of s.security_opt || []) {
      if (!/^no-new-privileges(?:[:=]true)?$/.test(String(o)) && (r = needPriv(`security_opt ${o}`))) return r;
    }
    if (s.volumes_from !== undefined && (r = needPriv("volumes_from"))) return r;
    if (s.sysctls !== undefined && Object.keys(s.sysctls || {}).length && (r = needPriv("sysctls"))) return r;
    // A moderately negative score (workspace's DB: -500) only changes who the OOM killer
    // picks; below -500, down to OOM-immune -1000, needs consent.
    if (s.oom_score_adj !== undefined && !(Number(s.oom_score_adj) >= -500) && (r = needPriv("oom_score_adj below -500"))) return r;
    if (s.runtime !== undefined && !["runc", "nvidia"].includes(String(s.runtime)) && (r = needPriv(`runtime ${s.runtime}`))) return r;
    for (const d of s.devices || []) {
      const raw = typeof d === "string" ? d.split(":")[0] : d?.source;
      // Normalized AND resolved: /dev/dri/../nvme0n1 is a raw disk.
      const isGpu = (x) => /^\/dev\/(dri(\/[A-Za-z0-9_.-]+)?|kfd|nvidia[a-z0-9-]*)$/.test(x) && !x.split("/").includes("..");
      const gpu = typeof raw === "string" && isAbsolute(raw) && isGpu(resolvePath(raw)) && isGpu(resolveHostPath(raw));
      const src = raw;
      if (!gpu && (r = needPriv(`a host device (${String(src || "?").slice(0, 60)})`))) return r;
    }
    if (s.deploy !== undefined) {
      if ((r = checkKeys(s.deploy, ["resources", "restart_policy", "replicas", "mode", "labels", "update_config", "rollback_config", "placement", "endpoint_mode"], `${tag} deploy`))) return r;
      for (const dev of s.deploy.resources?.reservations?.devices || []) {
        const caps = (dev.capabilities || []).flat().map(String);
        if (!(caps.length && caps.every((c) => ["gpu", "compute", "utility", "graphics", "video", "display"].includes(c)))) {
          if ((r = needPriv("a device reservation other than a GPU"))) return r;
        }
      }
    }
    for (const n of Object.keys(isObj(s.networks) ? s.networks : {})) {
      if (!networkNames.has(n)) return refuse(`${tag}: network '${n}' is not declared`);
    }
    for (const v of s.volumes || []) {
      if (!isObj(v)) return refuse(`${tag}: a volume Compose did not normalize`);
      if ((r = checkKeys(v, ["type", "source", "target", "read_only", "consistency", "bind", "volume", "tmpfs", "image"], `${tag} volume`))) return r;
      if (v.type === "bind") {
        if (v.bind !== undefined) {
          if ((r = checkKeys(v.bind, ["propagation", "create_host_path", "selinux"], `${tag} bind`))) return r;
          if (v.bind.propagation !== undefined && !["private", "rprivate"].includes(v.bind.propagation) && (r = needPriv(`bind propagation ${v.bind.propagation}`))) return r;
          if (v.bind.selinux !== undefined && (r = needPriv("an SELinux relabel of a host path"))) return r;
        }
        if ((r = checkHostPath(v.source, { readOnly: v.read_only === true, what: tag }))) return r;
      } else if (v.type === "volume" || v.type === "tmpfs" || v.type === "image") {
        if (v.type === "volume" && v.source !== undefined && !Object.hasOwn(model.volumes || {}, v.source)) return refuse(`${tag}: volume '${v.source}' is not declared`);
      } else {
        return refuse(`${tag}: volume type '${v.type}' is not one the install check understands`);
      }
    }
    for (const e of s.env_file || []) {
      const path = typeof e === "string" ? e : e?.path;
      if ((r = insideBundle(path, `${tag} env_file`, { allowOutside: manifest?.inference === true }))) return r;
    }
    for (const lf of [].concat(s.label_file || [])) if ((r = insideBundle(lf, `${tag} label_file`))) return r;
    if (s.build !== undefined) {
      const b = typeof s.build === "string" ? { context: s.build } : s.build;
      if ((r = checkKeys(b, ["context", "dockerfile", "dockerfile_inline", "args", "target", "labels", "cache_from", "cache_to", "no_cache", "pull", "platforms", "tags", "shm_size", "additional_contexts", "network"], `${tag} build`))) return r;
      if (/^[a-z][a-z0-9+.-]*:\/\//i.test(String(b.context))) return refuse(`${tag}: a remote build context`);
      if ((r = insideBundle(b.context, `${tag} build context`))) return r;
      if (b.network !== undefined && b.network !== "default" && b.network !== "none" && (r = needPriv(`build network ${b.network}`))) return r;
      for (const c of Object.values(b.additional_contexts || {})) {
        if ((r = insideBundle(c, `${tag} build additional_contexts`))) return r;
      }
    }
  }
  for (const [name, n] of Object.entries(model.networks || {})) {
    let r;
    if ((r = checkKeys(n, ["name", "driver", "driver_opts", "external", "internal", "attachable", "ipam", "labels", "enable_ipv6", "enable_ipv4"], `network ${name}`))) return r;
    const real = String(n.name || name);
    // An external network joins another project's network; only Crow's shared federation
    // network is expected.
    if (n.external && real !== "crow-federation") { if ((r = needPriv(`the external network '${real}'`))) return r; }
    if (n.driver !== undefined && n.driver !== "bridge" && (r = needPriv(`network driver ${n.driver}`))) return r;
  }
  for (const [name, vol] of Object.entries(model.volumes || {})) {
    let r;
    if ((r = checkKeys(vol, ["name", "driver", "driver_opts", "external", "labels"], `volume ${name}`))) return r;
    // An external volume is another project's data (another extension's database…).
    if (vol.external && (r = needPriv(`the external volume '${vol.name || name}'`))) return r;
    if (vol.driver !== undefined && vol.driver !== "local" && (r = needPriv(`volume driver ${vol.driver}`))) return r;
    const dev = vol.driver_opts?.device;
    if (dev !== undefined) {
      const o = String(vol.driver_opts.o || "");
      const type = String(vol.driver_opts.type || "");
      const remote = /^(nfs4?|cifs|smb3?)$/.test(type) && !/(?:^|,)r?bind(?:,|$)/.test(o);
      if (!remote) {
        if (typeof dev !== "string" || !dev.startsWith("/")) return refuse(`volume ${name}: a bind device that is not an absolute path`);
        if ((r = checkHostPath(dev, { readOnly: /(?:^|,)ro(?:,|$)/.test(o), what: `volume ${name}` }))) return r;
      }
    }
  }
  for (const [kind, items] of [["secrets", model.secrets], ["configs", model.configs]]) {
    for (const [name, it] of Object.entries(items || {})) {
      let r;
      if ((r = checkKeys(it, ["name", "file", "content", "external", "labels"], `${kind} ${name}`))) return r;
      // (`environment:` is refused by omission: it copies a variable from the env Compose
      // runs with — the gateway's — into the container.)
      if (it.file !== undefined && (r = insideBundle(it.file, `${kind} ${name}`))) return r;
    }
  }
  return { valid: true };
}

/** True when the model reaches the host's network: host / another container's network
 * mode, a network on the host driver or named host, or a LAN-level driver. */
export function usesHostNetwork(model) {
  for (const s of Object.values(model?.services || {})) {
    const nm = String(s?.network_mode || "");
    if (nm === "host" || nm.startsWith("container:")) return true;
  }
  for (const [name, n] of Object.entries(model?.networks || {})) {
    const real = String(n?.name || name);
    if (["host", "macvlan", "ipvlan"].includes(String(n?.driver || "")) || (n?.external && real === "host")) return true;
  }
  return false;
}

/** `${VAR:?…}` / `${VAR?…}` names in a compose text (the ones Compose refuses to leave blank). */
export function requiredComposeVars(text) {
  const out = new Set();
  const re = /\$\{([A-Za-z_][A-Za-z0-9_]*):?\?/g;
  let m;
  while ((m = re.exec(String(text || ""))) !== null) out.add(m[1]);
  return [...out];
}

function parseDotEnv(path) {
  const out = {};
  try {
    for (const line of readFileSync(path, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
      if (m) out[m[1]] = m[2].trim().replace(/^(["'])(.*)\1$/, "$2");
    }
  } catch { /* none */ }
  return out;
}

/**
 * The model `docker compose up` would apply in bundleDir. `runConfig(args, {cwd, env})`
 * runs `docker compose <args>` and resolves {stdout}. A `${VAR:?}` left blank (collection
 * installs leave required keys for "Finish setup") gets UNSET_SENTINEL so the rest of the
 * model can still be checked; Start re-runs this check once the real value is set.
 * @returns {Promise<{model: object} | {error: string}>}
 */
export async function loadComposeModel(bundleDir, { env, runConfig }) {
  const args = ["config", "--format", "json", "--no-env-resolution"];
  // Every profile: a service behind an inactive profile is still in the file, and
  // `compose --profile x up` (a hook, an operator) would start it.
  const attempt = async (e) => {
    const { stdout } = await runConfig(args, { cwd: bundleDir, env: { ...e, COMPOSE_PROFILES: "*" } });
    return JSON.parse(String(stdout));
  };
  try {
    return { model: await attempt(env) };
  } catch (first) {
    let text = "";
    for (const f of ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"]) {
      try { if (existsSync(join(bundleDir, f))) text += readFileSync(join(bundleDir, f), "utf8") + "\n"; } catch { /* skip */ }
    }
    const dot = parseDotEnv(join(bundleDir, ".env"));
    const filled = { ...env };
    let changed = false;
    for (const k of requiredComposeVars(text)) {
      if (!filled[k] && !dot[k]) { filled[k] = UNSET_SENTINEL; changed = true; }
    }
    if (changed) {
      try { return { model: await attempt(filled) }; } catch { /* fall through */ }
    }
    const msg = String(first?.stderr || first?.message || "unknown error").split("\n").map((l) => l.trim()).filter(Boolean).slice(-2).join(" ");
    return { error: `Docker Compose could not read the bundle's compose file (${msg.slice(0, 300)})` };
  }
}
