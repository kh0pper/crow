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
 * shared-storage re-apply. The gpu-orchestrator checks model bundles itself
 * (preflightBundleUp) with the same checkComposeModel.
 */
import { existsSync, readFileSync, readdirSync, realpathSync, lstatSync, readlinkSync, statSync, openSync, fstatSync, readSync, closeSync, constants as fsConstants } from "node:fs";
import { join, resolve as resolvePath, relative, dirname, basename, sep, isAbsolute } from "node:path";
import { homedir } from "node:os";
import { createHash } from "node:crypto";
import { fileURLToPath } from "node:url";
import { execFileSync } from "node:child_process";
// The manifest's own list of paths inside the installed bundle (shared, leaf module: it
// imports nothing, so it can be read from both here and routes/bundles.js).
import { declaredControlPaths } from "../shared/bundle-declared-paths.js";

// A value Compose sees for a `${VAR:?}` the install left blank (a collection member,
// finished later with Configure): relative, so it resolves inside the bundle dir.
export const UNSET_SENTINEL = "./crow-unset-value";

/**
 * realpath of p, or of its nearest existing ancestor + the rest (a path Docker would create).
 * Always the native realpath(3): Node's JS realpathSync can stop one link short on a chain
 * of symlinks (seen with a chain ending at a socket), which would hide where a bind really lands.
 */
export function resolveHostPath(p, depth = 0) {
  let cur = resolvePath(p);
  const rest = [];
  for (;;) {
    try {
      const real = realpathSync.native(cur);
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
 * @param {string[]} [ctx.operatorRoots] host folders the owner granted this bundle (folder-grants.js)
 * @param {string[]} [ctx.otherRoots]    folders granted to OTHER bundles (no root may nest with one)
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
    // Folders the owner chose (operatorRoots below), as written AND as they really lead,
    // so a path is matched in both forms (checkHostPath checks both).
    operatorRoots: [...new Set((Array.isArray(ctx.operatorRoots) ? ctx.operatorRoots : [])
      .filter((r) => typeof r === "string" && isAbsolute(r))
      .flatMap((r) => [resolvePath(r), real(r)]))],
    otherRoots: [...new Set((Array.isArray(ctx.otherRoots) ? ctx.otherRoots : [])
      .filter((r) => typeof r === "string" && isAbsolute(r))
      .map((r) => real(r)))],
  };
}

// The floor: places never mountable outside Crow's home, even in a folder the owner
// allowed (defence in depth: an owner tricked into allowing ~/.ssh is still refused).
export function hostFloorProblem(p, roots) {
  if (roots.exact.has(p)) return `mounts a sensitive host path (${p === "/" ? "/" : "a top-level folder"})`;
  const zones = [roots.crowHome, ...roots.dataDirs];
  if (zones.some((z) => under(z, p) || under(p, z))) return "mounts a folder that contains, or is inside, Crow's home or data folder";
  // Home folders (this user's and others'): dot-folders and ~/bin hold shells, keys,
  // autostart and user services.
  if (under(p, roots.homesRoot) && p !== roots.homesRoot) {
    const parts = p.slice(roots.homesRoot.length + 1).split(sep);
    if (parts.length === 1) return "mounts a whole home folder";
    if (parts[1].startsWith(".") || parts[1] === "bin") return `mounts a home folder's ${parts[1]}`;
  }
  for (const t of roots.trees) {
    if (under(p, t.root) || under(t.root, p)) return `mounts a sensitive host path (${t.why})`;
  }
  // A git working tree (another Crow checkout, lab scripts that timers run): code. Walk up
  // from the path to the filesystem root looking for .git, and refuse a folder holding one.
  for (let d = p; ; d = dirname(d)) {
    if (existsSync(join(d, ".git"))) return "mounts a git checkout (code something on this host may run)";
    if (dirname(d) === d) break;
  }
  return null;
}

/** Why a folder can't be granted (outside the floor, too shallow), or null. */
export function grantRootProblem(p, ctx) {
  const roots = sensitiveRoots(ctx);
  const real = resolveHostPath(p);
  if (real.split(sep).filter(Boolean).length < 2) return "a folder at least two levels deep";
  // Where it really leads (a CROW_HOME/media link to an external drive is judged as the drive).
  return hostFloorProblem(real, roots);
}

/** A value an owner typed that names a host folder: absolute or ~/, no interpolation. */
export function looksLikeHostPath(v) {
  return typeof v === "string" && (v.startsWith("/") || v.startsWith("~/")) && !v.includes("$") && !/[\r\n\0]/.test(v);
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
// Exported read-only for the satellite rules (servers/satellite/compose-rules.js), which refuse
// every one of these outright: one list, no drift.
export const SERVICE_PRIV = new Set(["cgroup_parent", "device_cgroup_rules", "external_links", "isolation", "storage_opt",
  "credential_spec", "oom_kill_disable", "use_api_socket", "post_start", "pre_stop", "develop", "models", "provider"]);
const TOP_OK = new Set(["name", "services", "networks", "volumes", "secrets", "configs"]);
// Crow's own bookkeeping of an installed compose (bundle-compose-state.js: .crow-compose.sha256,
// .crow-compose.edited, .crow-compose.state.json, .crow-compose.needs-config,
// .crow-compose.image-change, and whatever it adds next) is a PREFIX, not a list: read by the
// version refresh and the bind-drift card, so one of them must never be mountable read-write,
// or a container could rewrite the record those two trust. Defined here rather than imported
// from bundle-compose-state.js: that module reaches this one through bundles-config.js
// (bundles-config → folder-grants → compose-guard), so importing it would make a cycle.
// tests/compose-guard.test.js fails if a COMPOSE_*_FILE export stops starting with it.
export const COMPOSE_STATE_PREFIX = ".crow-compose.";
// Top-level entries of a bundle folder that the gateway reads or runs. Manifest-declared
// paths (a non-default compose file, a panel or panel routes outside panel/, a server entry
// the MCP spawn runs, a skill, a post-install hook) join this set per bundle: see
// manifestControlTops below.
const BUNDLE_CONTROL = new Set(["manifest.json", "settings-section.js", "docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml",
  "docker-compose.override.yml", "docker-compose.override.yaml", "compose.override.yml", "compose.override.yaml",
  ".env", ".env.example", "package.json", "package-lock.json", "node_modules", "server", "panel", "scripts", "ops", "skills", "public", "bin"]);
// The only "<id><suffix>" names a bundle owns beside <id> itself (a fixed set, so id "rook"
// never reaches bundle "rook-x"'s folder). No bundle id may end in one (tested).
export const OWN_SUFFIXES = ["-downloads", "-workspaces", "-data", "-cache"];
// Names Crow's own data uses directly under the data folder.
export const RESERVED_DATA_NAMES = new Set(["backups", "peers", "identity", "instance-id", "instance-sync", "legacy", "projects",
  "models", "media", "kb-media", "tasks", "keys", "keychain", "secrets", "nostr", "sync", "storage", "uploads", "cache", "tmp", "logs",
  "orchestrator-refcounts", "ntfy-push", "ntfy-push-status", "workspace-tools", "wayfinder-tile-cache", "glasses-photos"]);
// Names Crow itself uses directly under CROW_HOME: no bundle id may claim them as its own.
export const RESERVED_HOME_NAMES = new Set(["data", "secrets", "bundles", "panels", "skills", "media", "backups", "env", "logs",
  "p4", "pi-bots", "eval", "blog", "bin", "tmp", "cache", "config", "android-keystore", "keychain", "identity", "peer",
  "mcp", "models", "board", "phone-token", "artifacts-sidecar", "browser-sessions", "instances", "installed", "live2d-models"]);

/** Compose's byte sizes (b, k, m, g with an optional "b"; a bare number is bytes) → bytes, or null. */
export function parseByteSize(v) {
  if (typeof v === "number") return Number.isSafeInteger(v) && v >= 0 ? v : null;
  const m = /^(\d+)\s*([bkmg]?)b?$/i.exec(String(v ?? "").trim());
  if (!m) return null;
  const n = Number(m[1]) * ({ "": 1, b: 1, k: 1024, m: 1024 ** 2, g: 1024 ** 3 })[m[2].toLowerCase()];
  return Number.isSafeInteger(n) ? n : null;
}
// /dev/shm a bundle may ask for without declaring it (frigate 512 MB, browser 1 GB).
export const SHM_DEFAULT_MAX = 1024 ** 3;
const ENV_FILE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*\.env$/;

/**
 * What a reviewed manifest declares its containers need from the host (follow-up A),
 * instead of a privileged grant or a loophole:
 *   gpu        GPU device nodes (/dev/dri, /dev/kfd, /dev/nvidia*), gpus:, GPU device
 *              reservations, runtime nvidia, NVIDIA_VISIBLE_DEVICES / NVIDIA_DRIVER_CAPABILITIES
 *              in its environment, any NVIDIA_ mention in an env_file. (Image env is not in the compose model: on a host whose
 *              Docker default runtime is nvidia an image's own NVIDIA_VISIBLE_DEVICES still
 *              reaches the GPUs; the gate is complete only on hosts whose default runtime is runc.)
 *   shm_size   the /dev/shm its compose may ask for above SHM_DEFAULT_MAX. A declaration of
 *              need, NOT a security boundary (tmpfs mounts and container memory are not
 *              capped): it replaces `ipc: host`, which shares the HOST's IPC namespace.
 *   env_files  shared host env files it reads, by name, from ~/.crow/env/ or CROW_HOME/env/
 *   path_env   .env keys whose value is a host folder the operator chose (read by the
 *              gpu-orchestrator for ctx.operatorRoots). This check does not read
 *              operatorRoots yet: it relaxes nothing until the host-path allowlist
 *              (follow-up B) consumes it, and that applies its own floor to them.
 * Never honoured for community bundles. Callers pass the REPO manifest (startConsent,
 * the orchestrator), never an installed copy a container could rewrite.
 */
export function hostGrants(manifest) {
  const none = { gpu: false, shmMax: SHM_DEFAULT_MAX, envFiles: [], pathEnv: [] };
  const g = normalizeHostGrants(manifest?.host_grants);
  if (!g || manifest?.origin === "community") return none;
  const shm = g.shm_size === undefined ? null : parseByteSize(g.shm_size);
  return { gpu: g.gpu === true, shmMax: shm !== null && shm > SHM_DEFAULT_MAX ? shm : SHM_DEFAULT_MAX, envFiles: g.env_files || [], pathEnv: g.path_env || [] };
}

/** host_grants with only the keys and value shapes this module understands, or null. */
export function normalizeHostGrants(g) {
  if (!g || typeof g !== "object" || Array.isArray(g)) return null;
  const out = {};
  if (g.gpu === true) out.gpu = true;
  if ((typeof g.shm_size === "string" || typeof g.shm_size === "number") && parseByteSize(g.shm_size) !== null) out.shm_size = g.shm_size;
  if (Array.isArray(g.env_files)) out.env_files = g.env_files.filter((n) => typeof n === "string" && ENV_FILE_NAME.test(n) && !n.includes(".."));
  if (Array.isArray(g.path_env)) out.path_env = g.path_env.filter((k) => typeof k === "string" && /^[A-Za-z_][A-Za-z0-9_]*$/.test(k));
  return out;
}

const NVIDIA_ENV = ["NVIDIA_VISIBLE_DEVICES", "NVIDIA_DRIVER_CAPABILITIES"];
export const ENV_FILE_MAX_BYTES = 1024 * 1024;
/**
 * Read an ADMITTED env_file for the NVIDIA_* check: { missing } when there is no file,
 * { bad } when it is not a regular file of at most ENV_FILE_MAX_BYTES, else { nvidia }.
 *
 * No dotenv parsing (a parser differential with Compose would be a GPU-grant bypass):
 * ANY mention of NVIDIA_ (any case, any separator, quoting or line ending) counts.
 * stat before open (a device or FIFO is never opened), then open non-blocking and check
 * that the descriptor is the same regular file, and read at most the cap from it.
 */
export function scanEnvFile(path) {
  let st;
  try { st = statSync(path); } catch (e) { return e?.code === "ENOENT" || e?.code === "ENOTDIR" ? { missing: true } : { bad: true }; }
  if (!st.isFile() || st.size > ENV_FILE_MAX_BYTES) return { bad: true };
  let fd;
  try { fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NONBLOCK | fsConstants.O_NOCTTY); } catch { return { bad: true }; }
  try {
    const fst = fstatSync(fd);
    if (!fst.isFile() || fst.dev !== st.dev || fst.ino !== st.ino || fst.size > ENV_FILE_MAX_BYTES) return { bad: true };
    const buf = Buffer.alloc(ENV_FILE_MAX_BYTES + 1);
    let n = 0;
    for (let r; n <= ENV_FILE_MAX_BYTES && (r = readSync(fd, buf, n, buf.length - n, null)) > 0;) n += r;
    if (n > ENV_FILE_MAX_BYTES) return { bad: true };
    return { nvidia: /nvidia_/i.test(buf.subarray(0, n).toString("latin1")) };
  } catch { return { bad: true }; } finally { closeSync(fd); }
}

// ---- core allowances ------------------------------------------------------------------
// A core component (not a bundle) that the gateway itself runs may need one thing a
// bundle never gets. Each is named, and permits exactly that one thing; the rest of its
// compose is checked as for any bundle.
//   "preview-renderer"  servers/gateway/preview/container/compose.yml: a security_opt
//                       `seccomp=<path>` whose path is absolute, whose realpath is the
//                       shipped seccomp-chrome.json, and whose bytes hash to
//                       PREVIEW_SECCOMP_SHA256. Docker's default profile plus three
//                       reviewed changes (chroot, the clone/unshare mask, clone3 ENOSYS)
//                       so Chromium can build its own sandbox without CAP_SYS_ADMIN.
//                       Update the hash only with a reviewed change to the profile.
export const PREVIEW_SECCOMP_SHA256 = "1f5599761725d1c4bdd4a1cea1a84d5d2d203ed7e77172380ae358a65fb68414";
const PREVIEW_SECCOMP_FILE = fileURLToPath(new URL("./preview/container/seccomp-chrome.json", import.meta.url));
let previewSeccompFile = PREVIEW_SECCOMP_FILE;
/** Tests only: where the shipped profile is expected (null restores it). */
export function _setPreviewSeccompPathForTest(p) { previewSeccompFile = p || PREVIEW_SECCOMP_FILE; }
const CORE_ALLOWANCES = new Set(["preview-renderer"]);

function isShippedPreviewSeccomp(opt) {
  const m = /^seccomp=(.+)$/.exec(String(opt));
  if (!m || !isAbsolute(m[1])) return false;
  try {
    const real = realpathSync.native(m[1]);
    if (real !== realpathSync.native(previewSeccompFile)) return false;
    return createHash("sha256").update(readFileSync(real)).digest("hex") === PREVIEW_SECCOMP_SHA256;
  } catch {
    return false;
  }
}

/**
 * Check a Compose model (the parsed `docker compose config --format json` output).
 * `coreAllowance` names a core allowance (above); bundles never pass one.
 * @returns {{valid: true} | {valid: false, reason: string}}
 */
/** True when a bundle `id` may own compose project `project` (<id>, crow-<id>, or either + "-suffix"). */
export function ownableProject(id, project) {
  const p = String(project || "");
  return [id, `crow-${id}`].some((b) => p === b || p.startsWith(`${b}-`));
}

/**
 * The labels that say who owns an existing docker volume, for ctx.volumeInfo:
 * { project, bundle } (com.docker.compose.project, crow.bundle; "" when absent), or
 * null when there is no such volume or no docker at all. Any other docker failure
 * (a timeout, a daemon error) THROWS: the guard then refuses rather than skip the
 * check (fail closed).
 */
export function dockerVolumeInfo(name) {
  if (!/^[A-Za-z0-9][A-Za-z0-9_.-]{0,254}$/.test(String(name))) return null;
  try {
    const out = execFileSync("docker", ["volume", "inspect", "--format", '{{index .Labels "com.docker.compose.project"}}|{{index .Labels "crow.bundle"}}', name],
      { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000 }).trim();
    const [project = "", bundle = ""] = out.split("|");
    return { project, bundle };
  } catch (err) {
    if (err && err.code === "ENOENT") return null;                                  // no docker on this machine
    if (/no such volume/i.test(String(err?.stderr || "") + String(err?.message || ""))) return null;
    throw new Error(`cannot inspect volume '${String(name).slice(0, 60)}': ${String(err?.stderr || err?.message || err).trim().slice(0, 120)}`);
  }
}

/**
 * Bundle ids known on this instance: shipped in the repo (<appRoot>/bundles/*) plus
 * installed (<crowHome>/installed.json). For the guard's project-ownership rule.
 */
export function knownBundleIds(crowHome, appRoot) {
  const ids = new Set();
  try { for (const d of readdirSync(join(appRoot, "bundles"), { withFileTypes: true })) if (d.isDirectory()) ids.add(d.name); } catch { /* no repo bundles */ }
  try {
    const raw = JSON.parse(readFileSync(join(crowHome, "installed.json"), "utf8"));
    const list = Array.isArray(raw) ? raw : Object.entries(raw || {}).map(([k, v]) => ({ id: k, ...(v || {}) }));
    for (const e of list) { const id = typeof e === "string" ? e : e?.id; if (typeof id === "string") ids.add(id); }
  } catch { /* none installed */ }
  return [...ids];
}

/**
 * THE guard ctx for every path that runs `compose up` on a checked model (bundle
 * install/Start, the gpu-orchestrator's model containers, the preview renderer).
 * One builder, so no path can drop the ownership seams: `volumeInfo` (who owns an
 * existing volume) and `knownBundleIds` (who else could own the compose project).
 * They are set AFTER the caller's fields, so a caller cannot override them away.
 * tests/compose-guard-ctx-parity.test.js fails if a call site builds its ctx by hand.
 */
export function guardCtx(base = {}) {
  return { ...base, volumeInfo: dockerVolumeInfo, knownBundleIds: () => knownBundleIds(base.crowHome, base.appRoot) };
}

// Community bundles may not take the id "crow" or a "crow-" prefix: "crow-<id>" is how
// every bundle may name its own compose project, so such an id could claim another's.
export function reservedCommunityId(id) {
  return id === "crow" || String(id).startsWith("crow-");
}

/**
 * The first path segment a bundle-relative value resolves to, or null when it resolves
 * outside the bundle folder. Resolved EXACTLY as the gateway resolves a declared path — with
 * `path.join` against the INSTALLED bundle folder, which keeps an absolute value and a `..`
 * INSIDE that folder (join("<dir>/foo", "/data/x.js") and join("<dir>/foo", "panel/../data/x.js")
 * both land inside it, and "../foo/data/x.js" lands back in the same folder). Both sides are
 * real paths (symlinks followed), because the bind this is compared with is resolved the same
 * way. A `\` or `$` is an ordinary filename character on Linux, so a file named `ui\r.js`
 * really is the `ui\r.js` entry and is resolved as one.
 */
const FAKE_BUNDLE_ROOT = "/b";
function resolvedBundleTop(value, bundleDir, bundleReal) {
  if (typeof value !== "string" || !value) return null;
  // Without an installed folder to resolve against, the same join against a fixed root is the
  // best reading available.
  const base = typeof bundleDir === "string" && bundleDir ? resolvePath(bundleDir) : FAKE_BUNDLE_ROOT;
  const real = base === FAKE_BUNDLE_ROOT ? null : (bundleReal || resolveHostPath(base));
  const target = real ? resolveHostPath(join(base, value)) : join(base, value);
  const rel = relative(real || base, target);
  if (!rel || rel === "." || rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel)) return null;
  return rel.split(sep)[0];
}

/**
 * The top-level entry `docker.composefile` names: bundles-config.js manifestComposeFile
 * normalises it with path.relative(".", v), so `deploy/../data/c.yml` becomes `data/c.yml`
 * and is read from there. Repeated here (not imported: that module reaches this one).
 */
function resolvedComposeTop(declared, bundleDir, bundleReal) {
  const v = declared === undefined || declared === null || declared === "" ? "docker-compose.yml" : declared;
  if (typeof v !== "string" || isAbsolute(v) || v.includes("\\") || v.includes("$")) return null;
  return resolvedBundleTop(v, bundleDir, bundleReal);
}

/**
 * The top-level entries of a bundle folder that its OWN manifest names as code or config:
 * `docker.composefile` (default docker-compose.yml), the MCP launch command and its
 * bundle-relative arguments, `panel`/`panelRoutes`, `widgets`, `postInstall.script` and
 * every `skills` entry. The gateway copies the panel and its routes into PANELS_DIR and
 * imports them, reads the compose file at every install/Start, spawns the server with the
 * bundle folder as cwd, runs the post-install hook with bash, and copies the skills out of
 * the folder — so the folder holding any of them is as much a control entry as `panel/` or
 * the fixed compose names.
 *
 * Which paths a manifest declares is shared/bundle-declared-paths.js (the version refresh
 * reads the same list, so the two can never disagree). Each path is then resolved the way
 * `path.join` places it against the INSTALLED bundle folder, so a declaration that points
 * somewhere else ("/data/routes.js", "panel/../data/x.js", "../<this-folder>/data/x.js", an
 * object panel's id) names the entry it really lands in. Only a value that really resolves
 * outside the folder names nothing here; the manifest contract refuses it. (A manifest
 * declaring a path that its reader skips outright — an absolute skill path — still protects
 * the folder join() puts it in: over-protecting a folder nothing is read from costs nothing.)
 *
 * @param {object} manifest
 * @param {string} [bundleDir]   the installed bundle folder the declaration resolves against
 * @param {string} [bundleReal]  that folder as it really leads (resolveHostPath)
 * @returns {Map<string, string[]>} top-level entry → the manifest keys naming a file there
 */
function manifestControlTops(manifest, bundleDir, bundleReal) {
  const tops = new Map();
  const add = (top, key) => {
    if (!top) return;
    const keys = tops.get(top);
    if (!keys) tops.set(top, [key]);
    else if (!keys.includes(key)) keys.push(key);
  };
  add(resolvedComposeTop(manifest?.docker?.composefile, bundleDir, bundleReal), "docker.composefile");
  for (const { key, value } of declaredControlPaths(manifest)) add(resolvedBundleTop(value, bundleDir, bundleReal), key);
  return tops;
}

export function checkComposeModel(model, { bundleDir, manifest, consentVerified = false, ctx, coreAllowance }) {
  if (coreAllowance !== undefined && !CORE_ALLOWANCES.has(coreAllowance)) return { valid: false, reason: `unknown core allowance '${String(coreAllowance).slice(0, 40)}'` };
  const isPrivilegedAllowed = !!(manifest?.privileged && consentVerified && manifest?.origin !== "community");
  const isConsentBundle = !!(manifest?.consent_required && consentVerified && manifest?.origin !== "community");
  const roots = sensitiveRoots(ctx);
  const bundleReal = resolveHostPath(bundleDir);
  const ownId = /^[a-z0-9][a-z0-9-]*$/.test(String(manifest?.id || "")) ? manifest.id : null;
  // Paths this manifest declares (compose file, panel, panel routes, the MCP launcher and its
  // bundle-relative arguments, widgets, the post-install hook, skills): their top-level entry
  // in the bundle folder is control too, whatever the install shipped (ctx.shipped is only
  // built on the Extensions path, from a repo copy that need not exist).
  const manifestControl = manifestControlTops(manifest, bundleDir, bundleReal);
  const refuse = (reason) => ({ valid: false, reason });
  const needPriv = (what) => (isPrivilegedAllowed ? null : refuse(`Compose file uses ${what} but manifest does not declare 'privileged: true' (or consent was not verified)`));
  const grants = hostGrants(manifest);
  // GPU access: declared by host_grants.gpu (or covered by privileged consent).
  const needGpu = (what) => (grants.gpu ? null : needPriv(`${what} (a GPU: declare host_grants.gpu)`));
  const isObj = (v) => v && typeof v === "object" && !Array.isArray(v);
  if (!isObj(model) || !isObj(model.services)) return refuse("Docker Compose produced no services model");
  for (const k of Object.keys(model)) {
    if (!TOP_OK.has(k) && !k.startsWith("x-")) return refuse(`top-level key '${k}' is not one the install check understands`);
  }

  // Host-path policy: an ALLOWLIST everywhere. Inside Crow's home and data folder: the
  // bundle's own folder, CROW_HOME/<id> or <id>-*, <data>/<id>, CROW_HOME/media (library
  // defaults), and, read-only with privileged consent, crow.db and the extensions folder
  // (companion). Outside them: /etc/localtime read-only, the Docker socket and /proc, /sys
  // (read-only, consent), and folders the owner chose (ctx.operatorRoots). Under a chosen
  // folder a floor still applies: system folders, PATH folders, the gateway checkout, home
  // dot-folders and ~/bin, a whole home folder, a git checkout, and any folder that
  // CONTAINS one of these stay refused.
  // Granted folders count only when they would pass the floor themselves, are at least two
  // levels deep, and do not nest with another bundle's (a container holding the outer one
  // could swap the inner one for a symlink before that bundle's next restart). Equal
  // folders are fine: a container cannot replace its own mount point.
  const floorProblem = (p) => hostFloorProblem(p, roots);
  const validRoot = (r) => r.split(sep).filter(Boolean).length >= 2 && !floorProblem(r);
  const others = roots.otherRoots.filter(validRoot);
  const activeRoots = roots.operatorRoots.filter((r) => validRoot(r) && !others.some((o) => o !== r && (under(o, r) || under(r, o))));
  // A folder another extension was allowed too: only that folder itself may be mounted,
  // never something below it (that extension's container could swap it for a symlink).
  const sharedRoots = new Set(activeRoots.filter((r) => others.includes(r)));
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
      // <data>/<id> or <data>/<id>-* — a folder (or not created yet), never a name Crow's
      // own data uses (backups, peers, identity…) and never an existing file.
      const first = p === d ? "" : p.slice(d.length + 1).split(sep)[0];
      if (ownId && !RESERVED_DATA_NAMES.has(ownId) && (first === ownId || OWN_SUFFIXES.some((x) => first === `${ownId}${x}`)) && !RESERVED_DATA_NAMES.has(first)) {
        let isFile = false;
        try { isFile = !statSync(join(d, first)).isDirectory(); } catch { /* not there yet */ }
        if (!isFile) return null;
      }
      return refuse(`${what}: mounts a path in Crow's data folder outside its own <data>/${ownId || "<id>"}`);
    }
    if (under(p, roots.crowHome)) {
      const rel = p.slice(roots.crowHome.length + 1);
      const first = rel.split(sep)[0];
      if (under(p, bundleReal)) {
        // The bundle's own folder, but never the folder itself or its control files read-write:
        // the gateway reads the manifest, compose file and .env, and runs server/ code, so a
        // container that could rewrite them could grant itself privileges at the next Start.
        // Same for Crow's own `.crow-compose.*` bookkeeping (COMPOSE_STATE_PREFIX above) and
        // for whatever path this manifest declares (manifestControl above).
        const top = p.slice(bundleReal.length + 1).split(sep)[0];
        if (!readOnly) {
          if (p === bundleReal || BUNDLE_CONTROL.has(top) || top.startsWith(COMPOSE_STATE_PREFIX) || (ctx.shipped && ctx.shipped.has(top))) {
            return refuse(`${what}: mounts the bundle's own control files read-write`);
          }
          const declaredBy = manifestControl.get(top);
          if (declaredBy) return refuse(`${what}: mounts '${top}' (declared by ${declaredBy.map((k) => `manifest.${k}`).join(", ")}) read-write`);
        }
        return null;
      }
      // CROW_HOME/<id> (a folder, or not created yet) and CROW_HOME/<id>-downloads. Never a
      // name Crow itself uses there, and never an existing file (tokens, registries).
      if (ownId && !RESERVED_HOME_NAMES.has(ownId) && (first === ownId || OWN_SUFFIXES.some((x) => first === `${ownId}${x}`))) {
        const top = join(roots.crowHome, first);
        let isFile = false;
        try { isFile = !statSync(top).isDirectory(); } catch { /* not there yet */ }
        if (!isFile) return null;
      }
      if (first === "media" && rel !== "media") return null;
      if (readOnly && isPrivilegedAllowed && p === join(roots.crowHome, "bundles")) return null;
      return refuse(`${what}: mounts a path in Crow's home that is not this bundle's own`);
    }
    // Outside Crow's home and data folder it is an ALLOWLIST too: the fixed system entries
    // above (/etc/localtime read-only, the Docker socket), host information (/proc, /sys)
    // read-only with consent, and folders the owner chose (operator roots). The checks
    // after this are a floor that applies even to a chosen folder.
    for (const t of roots.trees) {
      if (t.hostInfo && under(p, t.root)) {
        if (readOnly && (isConsentBundle || isPrivilegedAllowed)) return null;
        return refuse(`${what}: mounts a sensitive host path (${t.why})`);
      }
    }
    if (!activeRoots.some((r) => under(p, r) && (!sharedRoots.has(r) || p === r))) {
      const shown = p.length > 80 ? `…${p.slice(-80)}` : p;
      // An allowed folder that can't count: say why, so Configure is not offered in vain.
      const allowed = roots.operatorRoots.find((r) => under(p, r));
      let why = null;
      if (allowed && sharedRoots.has(allowed)) why = "another extension was allowed the same folder, so only that folder itself can be mounted, not a folder inside it";
      else if (allowed && !validRoot(allowed)) why = `the folder you allowed can't be used (${allowed.split(sep).filter(Boolean).length < 2 ? "it is not at least two levels deep" : floorProblem(allowed)})`;
      else if (allowed) why = "the folder you allowed sits inside, or contains, a folder another extension was allowed";
      if (why) return refuse(`${what}: mounts ${shown}, outside Crow's home: ${why}. Choose another folder in its Configure`);
      return refuse(`${what}: mounts ${shown}, outside Crow's home, which is not a folder you allowed for this extension (open its Configure and enter this folder, then Start)`);
    }
    const f = floorProblem(p);
    if (f) return refuse(`${what}: ${f}`);
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
  const insideBundle = (src, what) => {
    if (typeof src !== "string" || src === "") return refuse(`${what}: a path Compose could not resolve`);
    if (!isAbsolute(src)) return refuse(`${what}: a path that is not absolute after Compose resolved it`);
    const p = resolveHostPath(src);
    if (under(p, bundleReal)) return null;
    return refuse(`${what}: reads a host path outside the bundle`);
  };
  // A shared host env file the manifest declares (host_grants.env_files): it must really be
  // <home>/.crow/env/<name> or <CROW_HOME>/env/<name> (realpath: a symlink there that leads
  // elsewhere does not count).
  const sharedEnvFile = (path) => {
    if (!grants.envFiles.length || !existsSync(path)) return false;
    let real;
    try { real = realpathSync.native(path); } catch { return false; }
    const home = ctx.home || homedir();
    return grants.envFiles.some((n) => [join(home, ".crow", "env"), join(ctx.crowHome, "env")].some((dir) => {
      let realDir;
      try { realDir = realpathSync.native(dir); } catch { return false; }
      // As written (no ../ tricks by name) AND where it really is: the file itself, not a
      // symlink out of the folder.
      return resolvePath(path) === join(resolvePath(dir), n) && real === join(realDir, n);
    }));
  };
  const checkKeys = (obj, allowed, what) => {
    if (!isObj(obj)) return refuse(`${what}: not a mapping`);
    for (const k of Object.keys(obj)) if (!allowed.includes(k)) return refuse(`${what}: key '${k}' is not one the install check understands`);
    return null;
  };

  // A bind source inside another READ-WRITE bind of this project: the container can swap it
  // for a symlink after this check, and Docker follows it at the next (re)start, which
  // nothing re-checks (restart: unless-stopped). Refused.
  const binds = [];
  for (const s of Object.values(model.services || {})) {
    for (const v of (s && s.volumes) || []) if (v && v.type === "bind" && typeof v.source === "string" && isAbsolute(v.source)) binds.push({ p: resolveHostPath(v.source), rw: v.read_only !== true });
  }
  // Host folders a container of this project can write: read-write binds and local
  // volumes on a bind device (not read-only). A file the gateway or Compose reads there
  // could be swapped for a symlink or a FIFO after this check.
  const writable = binds.filter((b) => b.rw).map((b) => b.p);
  for (const vol of Object.values(isObj(model.volumes) ? model.volumes : {})) {
    const dev = vol?.driver_opts?.device;
    if (typeof dev === "string" && isAbsolute(dev) && !/(?:^|,)ro(?:,|$)/.test(String(vol.driver_opts.o || ""))) writable.push(resolveHostPath(dev));
  }
  const containerWritable = (path) => {
    const p = resolveHostPath(path);
    return writable.some((w) => under(p, w));
  };
  {
    for (const a of binds) {
      for (const b of binds) {
        if (a !== b && a.rw && a.p !== b.p && under(b.p, a.p)) return refuse(`a bind mount sits inside another read-write bind mount (${b.p.slice(-60)})`);
      }
    }
  }

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
      if (coreAllowance === "preview-renderer" && isShippedPreviewSeccomp(o)) continue;
      if (!/^no-new-privileges(?:[:=]true)?$/.test(String(o)) && (r = needPriv(`security_opt ${o}`))) return r;
    }
    if (s.volumes_from !== undefined && (r = needPriv("volumes_from"))) return r;
    if (s.sysctls !== undefined && Object.keys(s.sysctls || {}).length && (r = needPriv("sysctls"))) return r;
    // A moderately negative score (workspace's DB: -500) only changes who the OOM killer
    // picks; below -500, down to OOM-immune -1000, needs consent.
    if (s.oom_score_adj !== undefined && !(Number(s.oom_score_adj) >= -500) && (r = needPriv("oom_score_adj below -500"))) return r;
    if (s.runtime !== undefined && String(s.runtime) !== "runc") {
      if (String(s.runtime) === "nvidia") { if ((r = needGpu("runtime nvidia"))) return r; }
      else if ((r = needPriv(`runtime ${s.runtime}`))) return r;
    }
    if (s.gpus !== undefined && s.gpus !== null && !(Array.isArray(s.gpus) && s.gpus.length === 0) && (r = needGpu("gpus"))) return r;
    {
      // In the service's environment (env_file contents: below, once each file is admitted).
      const listed = (env, k) => (Array.isArray(env) ? (env.find((e) => String(e).split("=")[0] === k) || "").split("=").slice(1).join("=") : env?.[k]);
      for (const k of NVIDIA_ENV) {
        const v = listed(s.environment, k);
        if (v !== undefined && v !== null && v !== "" && !["void", "none"].includes(String(v)) && (r = needGpu(`${k}`))) return r;
      }
    }
    if (s.shm_size !== undefined && s.shm_size !== null) {
      const shm = parseByteSize(s.shm_size);
      if (shm === null) return refuse(`${tag}: a shm_size the install check can't read (${String(s.shm_size).slice(0, 40)})`);
      if (shm > grants.shmMax && (r = needPriv(`shm_size ${shm} bytes, more than the manifest declares (host_grants.shm_size)`))) return r;
    }
    for (const d of s.devices || []) {
      const raw = typeof d === "string" ? d.split(":")[0] : d?.source;
      // Normalized AND resolved: /dev/dri/../nvme0n1 is a raw disk.
      const isGpu = (x) => /^\/dev\/(dri(\/[A-Za-z0-9_.-]+)?|kfd|nvidia[a-z0-9-]*)$/.test(x) && !x.split("/").includes("..");
      const gpu = typeof raw === "string" && isAbsolute(raw) && isGpu(resolvePath(raw)) && isGpu(resolveHostPath(raw));
      const src = raw;
      if (gpu) { if ((r = needGpu(`the device ${String(src).slice(0, 60)}`))) return r; }
      else if ((r = needPriv(`a host device (${String(src || "?").slice(0, 60)})`))) return r;
    }
    if (s.deploy !== undefined) {
      if ((r = checkKeys(s.deploy, ["resources", "restart_policy", "replicas", "mode", "labels", "update_config", "rollback_config", "placement", "endpoint_mode"], `${tag} deploy`))) return r;
      for (const dev of s.deploy.resources?.reservations?.devices || []) {
        const caps = (dev.capabilities || []).flat().map(String);
        if (!(caps.length && caps.every((c) => ["gpu", "compute", "utility", "graphics", "video", "display"].includes(c)))) {
          if ((r = needPriv("a device reservation other than a GPU"))) return r;
        } else if ((r = needGpu("a GPU device reservation"))) return r;
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
      const shared = typeof path === "string" && isAbsolute(path) && sharedEnvFile(path);
      if (!shared && (r = insideBundle(path, `${tag} env_file`))) return r;
      if (containerWritable(path)) return refuse(`${tag} env_file: inside a folder a container of this bundle can write`);
      // Admitted: now (never before) read it for NVIDIA_* (the model is built with
      // --no-env-resolution, so env_file contents are not in it). Only a small regular file:
      // a device, FIFO or huge file would block or exhaust the gateway.
      const scan = scanEnvFile(path);
      if (scan.missing) {
        // Fail closed: a file that appears between this check and `up` is never checked.
        if (e?.required === false) continue;
        return refuse(`${tag} env_file: ${String(path).slice(-60)} does not exist`);
      }
      if (scan.bad) return refuse(`${tag} env_file: not a regular file of at most 1 MiB`);
      if (scan.nvidia && (r = needGpu("NVIDIA_* in an env_file"))) return r;
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
  // The project name decides which volumes and networks Compose reuses: a bundle may not
  // take another bundle's (name: crow-workspace) to reach its data. It must be <id>,
  // crow-<id>, or one of those plus "-<suffix>" (a second instance). Volume and network
  // names must stay inside the project.
  const project = String(model.name || "");
  const community = manifest?.origin === "community";
  if (ownId && community && reservedCommunityId(ownId)) return refuse(`the bundle id '${ownId}' is reserved (no community bundle may be "crow" or start with "crow-")`);
  if (ownId && project) {
    const okProject = [ownId, `crow-${ownId}`].some((b) => project === b || project.startsWith(`${b}-`));
    if (!okProject) return refuse(`the compose project name '${project.slice(0, 60)}' is not this bundle's (${ownId})`);
    // The project rule is prefix-based, so one name can fit several ids (crow-browser-r4
    // fits browser, browser-r4, crow-browser). A community bundle may not take a project
    // that another bundle known here (installed, or shipped in the repo) could own: it
    // would replace that bundle's containers and reach its default-named volumes.
    if (community && typeof ctx?.knownBundleIds === "function") {
      const rival = [...new Set(ctx.knownBundleIds() || [])].find((k) => k !== ownId && /^[a-z0-9][a-z0-9-]*$/.test(String(k)) && ownableProject(k, project));
      if (rival) return refuse(`the compose project name '${project.slice(0, 60)}' also belongs to the '${rival}' bundle: a community bundle may not share it`);
    }
  }
  const inProject = (n) => !project || n.startsWith(`${project}_`) || n.startsWith(`${project}-`) || n === project;
  for (const [name, n] of Object.entries(model.networks || {})) {
    let r;
    if (n && !n.external && n.name && !inProject(String(n.name))) return refuse(`network '${name}' is named outside this project (${String(n.name).slice(0, 60)})`);
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
    if (!vol.external && vol.name && !inProject(String(vol.name))) return refuse(`volume '${name}' is named outside this project (${String(vol.name).slice(0, 60)}): another bundle's data`);
    // A volume that already exists belongs to whichever compose project created it
    // (its com.docker.compose.project label). The name rule above is prefix-based, so
    // a bundle whose id extends another's (browser-chromium vs browser) could still
    // name a volume the other created; refuse unless that project is one this
    // bundle may own itself. Unlabelled volumes keep Compose's own adoption rule.
    // A bundle labels its volumes with its own id (crow.bundle) and may not wear another's.
    const declared = vol.labels && typeof vol.labels === "object" && !Array.isArray(vol.labels) ? vol.labels["crow.bundle"] : undefined;
    if (declared !== undefined && ownId && String(declared) !== ownId) return refuse(`volume '${name}' carries the label crow.bundle=${String(declared).slice(0, 60)}: another bundle's identity`);
    if (!vol.external && ownId && typeof ctx?.volumeInfo === "function") {
      const real = String(vol.name || `${project}_${name}`);
      let info;
      try { info = ctx.volumeInfo(real); } catch (err) { return refuse(`could not check who owns volume '${real.slice(0, 60)}' (${String(err?.message || err).slice(0, 120)}): refusing`); }
      if (info && info.bundle && info.bundle !== ownId) {
        return refuse(`volume '${real.slice(0, 60)}' already exists and belongs to the '${String(info.bundle).slice(0, 60)}' bundle (crow.bundle): another bundle's data`);
      }
      if (info && info.project && !ownableProject(ownId, info.project)) {
        return refuse(`volume '${real.slice(0, 60)}' already exists and belongs to compose project '${String(info.project).slice(0, 60)}': another bundle's data`);
      }
    }
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

/**
 * The environment every gateway-driven `docker compose` run gets: an ALLOWLIST of the
 * gateway's variables (Compose interpolates `${ANY_VAR}` from it, so passing all of it
 * would let a compose file copy any gateway secret into its container), plus CROW_HOME
 * named explicitly. A bundle's own settings come from its .env, which Compose reads itself.
 * COMPOSE_* never passes (COMPOSE_FILE / _PROJECT_NAME / _PROFILES would change the model).
 */
const COMPOSE_ENV_KEYS = new Set(["PATH", "HOME", "USER", "LOGNAME", "LANG", "LANGUAGE", "TZ", "TMPDIR", "XDG_RUNTIME_DIR", "CROW_GATEWAY_PORT", "CROW_GATEWAY_URL", "CROW_DB_PATH", "CROW_DATA_DIR"]);
export function composeEnv(base, crowHome) {
  const env = {};
  for (const [k, v] of Object.entries(base || {})) {
    if (COMPOSE_ENV_KEYS.has(k) || /^LC_[A-Z]+$/.test(k) || (/^DOCKER_[A-Z_]+$/.test(k) && k !== "DOCKER_DEFAULT_PLATFORM")) env[k] = v;
  }
  // Canonical (symlinks and trailing slashes resolved): the browser bundle stamps
  // its profile with this path and refuses a different one on the next start, so
  // the gateway and an operator's script must pass the same spelling.
  let home = crowHome;
  try { home = realpathSync(crowHome); } catch { if (typeof crowHome === "string" && crowHome) home = resolvePath(crowHome); }
  env.CROW_HOME = home;
  return env;
}

/** `${VAR:?…}` / `${VAR?…}` names in a compose text (the ones Compose refuses to leave blank). */
export function requiredComposeVars(text) {
  const out = new Set();
  const re = /\$\{([A-Za-z_][A-Za-z0-9_]*):?\?/g;
  let m;
  while ((m = re.exec(String(text || ""))) !== null) out.add(m[1]);
  return [...out];
}

/**
 * The required `${X:?…}` keys a compose text needs that neither the bundle's .env nor
 * the environment Compose is run with can fill (a blank value fails the `${X:?}` form
 * too, so blank counts as missing). Names only, never values. Shared by the boot
 * catch-up (routes/bundles.js) and the compose-restore remedy, so a restore can never
 * copy a file that would break Start.
 */
export function missingRequiredComposeVars(text, { dotEnv = {}, env = {} } = {}) {
  const set = (k) => {
    const v = dotEnv[k] !== undefined && dotEnv[k] !== null ? dotEnv[k] : env[k];
    return v !== undefined && v !== null && String(v).trim() !== "";
  };
  return requiredComposeVars(text).filter((k) => !set(k));
}

/**
 * Compose-style variable expansion of one value: ${V}, ${V:-d}, ${V-d},
 * ${V:?m}, ${V?m}, ${V:+a}, ${V+a} and bare $V (nesting allowed in the
 * default). An unset variable expands to "" (what compose substitutes; a `?`
 * form would have failed the run, so no container holds that mount anyway).
 */
export function expandComposeVars(value, env) {
  const str = String(value);
  let out = "";
  let i = 0;
  while (i < str.length) {
    const ch = str[i];
    if (ch !== "$") { out += ch; i++; continue; }
    if (str[i + 1] === "$") { out += "$"; i += 2; continue; }
    if (str[i + 1] === "{") {
      let depth = 1;
      let j = i + 2;
      while (j < str.length && depth > 0) {
        if (str[j] === "{") depth++;
        else if (str[j] === "}") depth--;
        if (depth > 0) j++;
      }
      const body = str.slice(i + 2, j);
      i = j + 1;
      const m = /^([A-Za-z_][A-Za-z0-9_]*)(?:(:?)([-?+])([\s\S]*))?$/.exec(body);
      if (!m) continue;
      const [, name, colon, op, arg = ""] = m;
      const v = env[name];
      const isSet = v !== undefined && v !== null;
      const usable = colon ? isSet && String(v) !== "" : isSet;
      if (op === "-") out += usable ? String(v) : expandComposeVars(arg, env);
      else if (op === "+") out += usable ? expandComposeVars(arg, env) : "";
      else out += isSet ? String(v) : "";
      continue;
    }
    const m = /^[A-Za-z_][A-Za-z0-9_]*/.exec(str.slice(i + 1));
    if (!m) { out += ch; i++; continue; }
    out += env[m[0]] !== undefined && env[m[0]] !== null ? String(env[m[0]]) : "";
    i += 1 + m[0].length;
  }
  return out;
}

/**
 * The compose override files Compose merges from the same directory as `composeRel`:
 * docker-compose.override.y[a]ml, compose.override.y[a]ml and `<name>.override.<ext>`
 * for a non-default composefile. Bundle-relative, in a fixed order.
 */
export function composeOverrideFiles(composeRel) {
  const dir = dirname(composeRel);
  const at = (name) => (dir === "." ? name : join(dir, name));
  const files = ["docker-compose.override.yml", "docker-compose.override.yaml", "compose.override.yml", "compose.override.yaml"];
  const m = /^(.*)\.(ya?ml)$/.exec(basename(composeRel));
  if (m) files.push(`${m[1]}.override.${m[2]}`);
  return [...new Set(files)].map(at);
}

/** A host IP meaning "every interface": a bind on one of these is wider than a specific one. */
export const WIDE_HOST_IPS = new Set(["", "0.0.0.0", "::", "[::]"]);

/** A compose scalar without the quotes/comments compose allows around it. */
function composeScalar(raw) {
  return String(raw ?? "").replace(/\s+#.*$/, "").trim().replace(/^["']|["']$/g, "").trim();
}

/**
 * A port or an `a-b` port range → `{ lo, hi }` (a single port has lo === hi), or
 * null when the text is not a port at all (an unresolved `${VAR}`, an empty value).
 * This is the COMPOSE side of a range: `docker inspect` never reports one, it
 * reports one key per published container port.
 */
export function composePortRange(text) {
  const m = /^(\d{1,5})(?:-(\d{1,5}))?$/.exec(String(text ?? "").trim());
  if (!m) return null;
  const lo = Number(m[1]);
  const hi = m[2] === undefined ? lo : Number(m[2]);
  return lo >= 1 && hi <= 65535 && hi >= lo ? { lo, hi } : null;
}

/** One short-syntax port spec (`[ip:][host:]container[/proto]`) → published-port entries. */
function addShortPort(out, raw, env) {
  let spec = composeScalar(expandComposeVars(String(raw ?? ""), env));
  if (!spec) return;
  let protocol = "tcp";
  const slash = spec.lastIndexOf("/");
  if (slash >= 0) {
    protocol = composeScalar(spec.slice(slash + 1)).toLowerCase() || "tcp";
    spec = spec.slice(0, slash);
  }
  const parts = spec.split(":");
  let hostIP = null;
  let container = null;
  if (parts.length === 1) container = parts[0];
  else if (parts.length === 2) container = parts[1];
  else { hostIP = parts.slice(0, -2).join(":"); container = parts.at(-1); }
  hostIP = hostIP ? hostIP.replace(/^\[|\]$/g, "").trim() || null : null;
  if (container) out.push({ containerPort: container, protocol, hostIP });
}

/** One long-syntax port entry (`target`/`published`/`host_ip`/`protocol`) → published-port entries. */
function addLongPort(out, entry, env) {
  const target = composeScalar(expandComposeVars(String(entry.target ?? ""), env));
  if (!target) return;
  const protocol = (composeScalar(expandComposeVars(String(entry.protocol ?? "tcp"), env)) || "tcp").toLowerCase();
  const hostIP = entry.host_ip === undefined
    ? null
    : composeScalar(expandComposeVars(String(entry.host_ip), env)).replace(/^\[|\]$/g, "") || null;
  out.push({ containerPort: target, protocol, hostIP });
}

/**
 * Which service each line of a compose text belongs to: a line index → service
 * name map, or null for a line outside the `services:` block. Line-based, like
 * the rest of this module. Two services may publish the SAME container port
 * (one on 127.0.0.1, one on every interface), so a port expectation that does
 * not carry its service cannot tell them apart.
 */
function serviceByLine(lines) {
  const owner = new Array(lines.length).fill(null);
  let servicesIndent = -1;
  let serviceIndent = -1;
  let current = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!line.trim() || /^\s*#/.test(line)) { owner[i] = current; continue; }
    const ind = /^(\s*)/.exec(line)[1].length;
    const key = /^(\s*)([A-Za-z0-9._-]+)\s*:\s*(#.*)?$/.exec(line);
    // A second file's `services:` (compose + its overrides are joined by the caller)
    // starts a fresh block: this must be checked BEFORE "left the block".
    if (key && ind === 0 && key[2] === "services") {
      servicesIndent = 0;
      serviceIndent = -1;
      current = null;
      owner[i] = null;
      continue;
    }
    if (servicesIndent < 0) { owner[i] = null; continue; }
    if (key && ind <= servicesIndent) { servicesIndent = -1; serviceIndent = -1; current = null; owner[i] = null; continue; }
    if (key) {
      if (serviceIndent < 0) serviceIndent = ind;
      if (ind === serviceIndent) current = key[2];
    }
    owner[i] = current;
  }
  return owner;
}

/**
 * The published ports of a compose text: `{ service, containerPort, protocol, hostIP }`
 * per entry. `hostIP: null` means compose publishes it on every interface. Both port
 * syntaxes are read (`- "127.0.0.1:8555:5000"`, long `target:`/`host_ip:` entries) and
 * `${VAR}` values expand against `env` exactly as compose resolves them. A range stays
 * ONE entry (its `containerPort` is the `a-b` text); composePortExpectations turns it
 * into `{ lo, hi }` rather than inventing a port list.
 * `service` is the enclosing service's name (`null` for a `ports:` outside `services:`),
 * so callers can keep two services' publishes apart. Line-based, like the rest of this
 * module — it reads what a bundle's compose FILE declares, not the merged model
 * (`docker compose config`), which needs docker.
 */
export function composePublishedPorts(text, env = {}) {
  const out = [];
  const lines = String(text ?? "").split(/\r?\n/);
  const services = serviceByLine(lines);
  for (let i = 0; i < lines.length; i++) {
    const key = /^(\s*)ports:\s*(.*)$/.exec(lines[i]);
    if (!key) continue;
    const service = services[i] ?? null;
    const first = out.length;
    const indent = key[1].length;
    const inline = composeScalar(key[2]);
    if (inline.startsWith("[")) {
      for (const item of inline.slice(1).replace(/\]\s*$/, "").split(",")) addShortPort(out, item, env);
      for (const entry of out.slice(first)) entry.service = service;
      continue;
    }
    let long = null;
    const flushLong = () => { if (long && long.target !== undefined) addLongPort(out, long, env); long = null; };
    for (let j = i + 1; j < lines.length; j++) {
      const line = lines[j];
      if (!line.trim() || /^\s*#/.test(line)) continue;
      const ind = /^(\s*)/.exec(line)[1].length;
      if (ind <= indent) break;
      const item = /^\s*-\s*(.*)$/.exec(line);
      if (item) {
        flushLong();
        const val = composeScalar(item[1]);
        const kv = /^([A-Za-z_]+)\s*:\s*(.*)$/.exec(val);
        if (kv) long = { [kv[1]]: composeScalar(kv[2]) };
        else addShortPort(out, val, env);
        continue;
      }
      const kv = /^\s+([A-Za-z_]+)\s*:\s*(.*)$/.exec(line);
      if (kv && long) { long[kv[1]] = composeScalar(kv[2]); continue; }
      flushLong();
    }
    flushLong();
    for (const entry of out.slice(first)) entry.service = service;
  }
  return out;
}

/** The expectation map key: the service's name plus `containerPort/protocol`. */
export function composeExpectationKey(service, containerPort, protocol) {
  return `${service || ""}|${containerPort}/${protocol}`;
}

/**
 * The `image:` each service of a compose text names: `{ service: "image:tag" }`, with
 * `${VAR:-default}` resolved against `env` exactly as Compose resolves it. A service
 * without an `image:` (a `build:` only) maps to null. Line-based, like the rest of this
 * module: it reads what the FILE declares, not the merged model (no docker needed).
 *
 * Only a key at the service's own depth counts, so an `image:` nested in an extension
 * block (or inside a block scalar) is never mistaken for the service's image.
 */
export function composeServiceImages(text, env = {}) {
  const lines = String(text ?? "").split(/\r?\n/);
  const services = serviceByLine(lines);
  const childIndent = new Map();
  const out = {};
  for (let i = 0; i < lines.length; i++) {
    const service = services[i];
    if (!service) continue;
    const key = /^(\s*)([A-Za-z0-9._-]+)\s*:(.*)$/.exec(lines[i]);
    if (!key) continue;
    const [, spaces, name, rest] = key;
    const indent = spaces.length;
    // The line that names the service is not one of its keys: its depth is set by the
    // first key below it (a block header of its own is never a value either).
    if (name === service && !rest.trim()) continue;
    if (!childIndent.has(service)) childIndent.set(service, indent);
    if (indent !== childIndent.get(service) || name !== "image") continue;
    const image = composeScalar(expandComposeVars(String(rest ?? ""), env));
    out[service] = image || null;
  }
  return out;
}

/**
 * Where two compose texts disagree about which image a service runs:
 * `[{ service, from, to }]` in service-name order, `from`/`to` being the resolved image
 * name or null (a service the other file does not have, or one that only builds). A
 * service ADDED or REMOVED is a change too, so a comparison of the two texts never
 * blesses a repo compose that would quietly start or drop a container.
 *
 * An empty list means the compose refresh can be applied without touching an image.
 */
export function composeImageChanges(installedText, repoText, env = {}) {
  const before = composeServiceImages(installedText, env);
  const after = composeServiceImages(repoText, env);
  const changes = [];
  for (const service of [...new Set([...Object.keys(before), ...Object.keys(after)])].sort()) {
    const inBefore = Object.hasOwn(before, service);
    const inAfter = Object.hasOwn(after, service);
    const from = inBefore ? before[service] : null;
    const to = inAfter ? after[service] : null;
    if (inBefore && inAfter && from === to) continue;
    changes.push({ service, from, to });
  }
  return changes;
}

/**
 * `service|containerPort/protocol` → `{ service, protocol, port, range, hostIPs }` for
 * every published port of a compose text (one or more files, e.g. the installed compose
 * plus its overrides, joined by the caller). `hostIPs` holds "" for an all-interfaces
 * publish. `range` is the compose side of a port range: `{ lo, hi }` for `8000-8002`
 * (and `{ lo: n, hi: n }` for a single port), null for a text that is not a port. The
 * service is part of the key on purpose: two services may publish the same container
 * port, one on a specific IP and one on every interface.
 */
export function composePortExpectations(text, env = {}) {
  const byPort = new Map();
  for (const p of composePublishedPorts(text, env)) {
    const key = composeExpectationKey(p.service, p.containerPort, p.protocol);
    const entry = byPort.get(key) || {
      service: p.service || "",
      protocol: p.protocol,
      port: String(p.containerPort),
      range: composePortRange(p.containerPort),
      hostIPs: [],
    };
    entry.hostIPs.push(p.hostIP ? p.hostIP : "");
    byPort.set(key, entry);
  }
  return Object.fromEntries(byPort);
}

/**
 * The expectations a RUNNING publish answers to: the same service (or, when the
 * container's compose service label is unknown, any service) and protocol, with the
 * running container port equal to a declared port or inside a declared `a-b` range.
 * Docker reports one bind per port, so a range matches the ports it contains.
 *
 * @param {object} expected  composePortExpectations() output
 * @param {{service?: string, containerPort: string|number, protocol?: string}} bind
 * @returns {Array<object>} the matching expectation entries (empty: not declared)
 */
export function portExpectationsFor(expected = {}, { service = "", containerPort, protocol = "tcp" } = {}) {
  const port = Number(String(containerPort ?? "").trim());
  const wantedService = service ? String(service) : "";
  const wantedProtocol = String(protocol || "tcp").toLowerCase();
  const out = [];
  for (const entry of Object.values(expected || {})) {
    if (!entry || entry.protocol !== wantedProtocol) continue;
    if (wantedService && entry.service !== wantedService) continue;
    if (entry.range) {
      if (Number.isInteger(port) && port >= entry.range.lo && port <= entry.range.hi) out.push(entry);
    } else if (entry.port === String(containerPort ?? "").trim()) {
      out.push(entry);
    }
  }
  return out;
}

/**
 * Where the RUNNING containers bind ports WIDER than the compose says: a running
 * `0.0.0.0`/`::`/empty host IP while compose publishes the port on a specific IP, or a
 * WIDE published container port compose no longer has. Narrower or equal is not drift.
 *
 * Expectations come from composePortExpectations (service + port/protocol, with a
 * compose range as `{lo, hi}`), so two services sharing a container port cannot mask
 * each other, and a port inside a declared range is declared. A bind whose service
 * label is unknown falls back to every expectation for that port.
 *
 * @param {object} o
 * @param {object} o.expected  composePortExpectations() output
 * @param {Array}  o.running   [{ service, containerPort, protocol, hostIp, hostPort }]
 * @returns {Array<{containerPort, protocol, hostIp, hostPort, kind: "wider"|"extra"}>}
 */
export function portBindDrift({ expected = {}, running = [] } = {}) {
  const drifted = [];
  for (const bind of Array.isArray(running) ? running : []) {
    const containerPort = String(bind?.containerPort ?? "").trim();
    if (!containerPort) continue;
    const protocol = String(bind?.protocol || "tcp").toLowerCase();
    const service = bind?.service ? String(bind.service) : "";
    const entries = portExpectationsFor(expected, { service, containerPort, protocol });
    if (entries.length === 0) {
      // A port the file no longer publishes is only worth a card while it is
      // reachable from other devices: a loopback extra is nobody's business.
      if (WIDE_HOST_IPS.has(String(bind?.hostIp ?? "").trim())) {
        drifted.push({ ...bind, protocol, kind: "extra" });
      }
      continue;
    }
    const expectedSpecific = entries.every((e) => Array.isArray(e.hostIPs) && e.hostIPs.length > 0
      && e.hostIPs.every((ip) => !WIDE_HOST_IPS.has(String(ip ?? "").trim())));
    if (expectedSpecific && WIDE_HOST_IPS.has(String(bind?.hostIp ?? "").trim())) {
      drifted.push({ ...bind, protocol, kind: "wider" });
    }
  }
  return drifted;
}

function parseDotEnvText(text) {
  const out = {};
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = line.match(/^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/);
    if (m) out[m[1]] = m[2].trim().replace(/^(["'])(.*)\1$/, "$2");
  }
  return out;
}

export function parseDotEnv(path) {
  try { return parseDotEnvText(readFileSync(path, "utf8")); } catch { return {}; }
}

/**
 * The model `docker compose up` would apply in bundleDir. `runConfig(args, {cwd, env})`
 * runs `docker compose <args>` and resolves {stdout}. A `${VAR:?}` left blank (collection
 * installs leave required keys for "Finish setup") gets UNSET_SENTINEL so the rest of the
 * model can still be checked; Start re-runs this check once the real value is set.
 * @returns {Promise<{model: object} | {error: string}>}
 */
export async function loadComposeModel(bundleDir, { env, runConfig, composeFile = null, cwd = bundleDir }) {
  // composeFile: the caller's `up` names one file (`-f`, the gpu-orchestrator): the model
  // is read the same way (no override discovery, COMPOSE_FILE ignored), from the same cwd.
  const args = [...(composeFile ? ["-f", composeFile] : []), "config", "--format", "json", "--no-env-resolution"];
  // Every profile: a service behind an inactive profile is still in the file, and
  // `compose --profile x up` (a hook, an operator) would start it.
  const attempt = async (e) => {
    const { stdout } = await runConfig(args, { cwd, env: { ...e, COMPOSE_PROFILES: "*" } });
    return JSON.parse(String(stdout));
  };
  try {
    const model = await attempt(env);
    // Compose always names the project; a model without one is not what up would apply.
    if (!model || typeof model.name !== "string" || !model.name) return { error: "Docker Compose produced a model without a project name" };
    return { model };
  } catch (first) {
    let text = "";
    for (const f of composeFile ? [composeFile] : ["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"].map((n) => join(bundleDir, n))) {
      try { if (existsSync(f)) text += readFileSync(f, "utf8") + "\n"; } catch { /* skip */ }
    }
    const dot = parseDotEnv(join(bundleDir, ".env"));
    const filled = { ...env };
    let changed = false;
    for (const k of requiredComposeVars(text)) {
      if (!filled[k] && !dot[k]) { filled[k] = UNSET_SENTINEL; changed = true; }
    }
    if (changed) {
      try {
        const model = await attempt(filled);
        if (model && typeof model.name === "string" && model.name) return { model };
      } catch { /* fall through */ }
    }
    const msg = String(first?.stderr || first?.message || "unknown error").split("\n").map((l) => l.trim()).filter(Boolean).slice(-2).join(" ");
    return { error: `Docker Compose could not read the bundle's compose file (${msg.slice(0, 300)})` };
  }
}
