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
import { existsSync, readFileSync, realpathSync, lstatSync, readlinkSync } from "node:fs";
import { join, resolve as resolvePath, dirname, basename, sep, isAbsolute } from "node:path";
import { homedir } from "node:os";

const DANGEROUS_CAPS = new Set(["ALL", "NET_ADMIN", "SYS_ADMIN", "SYS_PTRACE", "SYS_RAWIO", "NET_RAW", "SYS_MODULE", "DAC_READ_SEARCH", "SYS_BOOT", "SYS_TIME", "MAC_ADMIN", "MAC_OVERRIDE", "BPF", "PERFMON"]);
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
  const dataDirs = [...new Set([ctx.dataDir, join(ctx.crowHome, "data"), join(home, ".crow", "data")].filter(Boolean).map(real))];
  return {
    exact: new Set([real("/"), real(ctx.crowHome), real(home), ...(ctx.appRoot ? [real(ctx.appRoot)] : [])]),
    trees: [
      { root: real("/etc"), why: "/etc" },
      { root: real("/root"), why: "/root" },
      { root: real("/boot"), why: "/boot" },
      { root: real("/var/lib/docker"), why: "Docker's own data" },
      { root: real("/run"), why: "/run (system sockets)" },
      { root: real("/var/run"), why: "/var/run (system sockets)" },
      { root: real("/dev"), why: "/dev (host devices)" },
      { root: real("/proc"), why: "/proc", hostInfo: true },
      { root: real("/sys"), why: "/sys", hostInfo: true },
      { root: real(join(home, ".ssh")), why: "~/.ssh" },
      { root: real(join(ctx.crowHome, "secrets")), why: "Crow's secrets folder" },
      ...dataDirs.map((d) => ({ root: d, why: "Crow's data folder", dataDir: true })),
      ...(ctx.appRoot ? [{ root: real(join(ctx.appRoot, ".env")), why: "the gateway .env" }] : []),
      { root: real(join(ctx.crowHome, ".env")), why: "Crow's .env" },
      { root: real(join(ctx.crowHome, "mcp-addons.json")), why: "the extension registry (holds extension settings)" },
      { root: real(join(ctx.crowHome, "bundles")), why: "the extensions folder (holds other extensions' settings)", bundlesDir: true },
    ],
    dockerSockets: new Set([real("/var/run/docker.sock"), real("/run/docker.sock")]),
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

  const checkOne = (p, { readOnly, what }) => {
    if (roots.dockerSockets.has(p)) {
      if (!readOnly) return refuse("Read-write Docker socket mounts are not permitted");
      if (!isConsentBundle && !isPrivilegedAllowed) return refuse("Docker socket mount requires manifest 'consent_required: true' and verified consent");
      return null;
    }
    if (roots.exact.has(p)) return refuse(`${what}: mounts a sensitive host path (${p === "/" ? "/" : "a top-level folder"})`);
    if ((p === "/etc/localtime" || p === roots.localtime) && readOnly) return null;
    for (const t of roots.trees) {
      if (!(under(p, t.root) || under(t.root, p))) continue;
      if (t.hostInfo && readOnly && under(p, t.root) && (isConsentBundle || isPrivilegedAllowed)) continue;
      if (t.dataDir && readOnly && isPrivilegedAllowed && basename(p) === "crow.db" && dirname(p) === t.root) continue;
      if (t.dataDir && ownId && under(p, join(t.root, ownId))) continue;
      if (t.bundlesDir && readOnly && isPrivilegedAllowed && p === t.root) continue;
      if (t.bundlesDir && under(p, bundleReal)) continue;
      return refuse(`${what}: mounts a sensitive host path (${t.why})`);
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
      const src = typeof d === "string" ? d.split(":")[0] : d?.source;
      const gpu = /^\/dev\/(dri(\/.*)?|kfd|nvidia[a-z0-9-]*)$/.test(String(src || ""));
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
    if (n.external && (real === "host" || real === "none")) { if ((r = needPriv(`the '${real}' network`))) return r; }
    if (n.driver !== undefined && n.driver !== "bridge" && (r = needPriv(`network driver ${n.driver}`))) return r;
  }
  for (const [name, vol] of Object.entries(model.volumes || {})) {
    let r;
    if ((r = checkKeys(vol, ["name", "driver", "driver_opts", "external", "labels"], `volume ${name}`))) return r;
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
  const attempt = async (e) => {
    const { stdout } = await runConfig(args, { cwd: bundleDir, env: e });
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
