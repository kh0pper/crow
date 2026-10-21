/**
 * The "contain" tier of the pi sandbox (queue item 19, migration step 2a).
 *
 * The default tier (pi_sandbox.mjs, S3) bind-mounts the whole host filesystem
 * and masks a few routes: a bot shell can still read ~/.ssh keys, operator
 * files with credentials, other instances' data, and write the checkout the
 * gateway runs or the user's rc files. Contain inverts that: an EMPTY root
 * (tmpfs /) with only what a pi turn needs bound in, read-only unless the
 * bot's own policy grants a write.
 *
 *   system      /usr /etc (+/opt, usr-merge symlinks, DNS stub) read-only;
 *               /etc/crow masked; fresh /dev, /tmp, /run, $HOME (tmpfs)
 *   engine      node install, pi package, the checkout, pi-lab: read-only
 *   pi state    ~/.pi/agent = a per-spawn SHADOW copy (writable, discarded):
 *               pi creates lock dirs beside auth.json/settings.json, and a
 *               bot must not be able to edit the real settings (packages[]
 *               loads extensions into every later pi). Its subdirs with
 *               code (pkg, agents, prompts, bin) are bound read-only on top.
 *               The operator's own pi sessions are not visible.
 *   instance    the data dir read-write (the bot's stdio MCP servers open
 *               crow.db directly; documented residual), identity.json masked
 *               unless a sharing tool needs it; CROW_HOME itself, its tokens,
 *               secrets/ and env/ are not bound. <crowHome>/skills read-only.
 *   bot         session dir + cwd + project workspace read-write; write_paths
 *               read-write; read_paths read-only (all realpath'd)
 *   MCP         each server's cwd, an absolute command's install root, and
 *               absolute files named in its env: read-only
 *   cache       one per-instance bot cache (npm, uv) read-write, so npx/uv
 *               work without touching the cache unsandboxed processes run
 *
 * Never bound, whatever a policy says: ~/.ssh, ~/.gnupg, ~/.claude, ~/.config
 * /systemd, the whole $HOME, other /home users, other Crow instance homes,
 * /etc/crow, /run/credentials, /run/user, docker sockets; nor is the checkout
 * or engine ever writable. "/" in write_paths/read_paths (permissionMode
 * bypass) cannot be contained: ContainRefused.
 *
 * Selection comes from the SPAWNER's env only (a bot def's spawn_env is
 * stripped of these names): CROW_PI_SANDBOX=contain for every pi, or
 * CROW_PI_CONTAIN_BOTS=<id,id> for listed bots.
 */
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";

export class ContainRefused extends Error {
  constructor(msg) { super(msg); this.name = "ContainRefused"; }
}

export function containSelected(env, botId) {
  const mode = String(env.CROW_PI_SANDBOX || "").trim().toLowerCase();
  if (mode === "off") return false;
  if (mode === "contain") return true;
  const list = String(env.CROW_PI_CONTAIN_BOTS || "").split(",").map((s) => s.trim()).filter(Boolean);
  return !!botId && list.includes(String(botId));
}

/** Subdirs of the pi agent dir that hold code or config pi only reads. */
export const AGENT_RO_SUBDIRS = Object.freeze(["pkg", "agents", "prompts", "bin", "extensions", "themes"]);
/** Top-level agent files copied into the shadow (small config; pi writes locks beside them). */
export const AGENT_SHADOW_FILES = Object.freeze(["auth.json", "models.json", "models-store.json", "settings.json", "mcp.json", "keybindings.json"]);
/** Data-dir entries a contained bot keeps: the DB files and their journals. */
export const DB_FILE_RE = /^(crow|tasks)\.db(-wal|-shm|-journal)?$/;

const under = (p, root) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

let _home = null;
function real(p, exists) {
  if (p && _home && (p === "~" || p.startsWith("~/"))) p = join(_home, p.slice(1));
  if (!p || !isAbsolute(p)) return null;
  if (!exists(p)) return null;
  try { return realpathSync(p); } catch { return null; }
}

/** Directories never bound wholesale (their contents belong to everyone). */
const SHARED_ROOTS = ["/tmp", "/var/tmp", "/var", "/run", "/home", "/dev/shm", tmpdir()];

/** The nearest ancestor (up to 4 levels) of a file holding a package.json; else the file itself. */
export function packageRoot(file, exists = existsSync) {
  let d = dirname(file);
  for (let i = 0; i < 4; i++) {
    if (exists(join(d, "package.json"))) return d;
    const up = dirname(d);
    if (up === d) break;
    d = up;
  }
  return file;
}

/** Paths a bot may never see, for a given home. */
export function neverBound(home) {
  return [join(home, ".ssh"), join(home, ".gnupg"), join(home, ".claude"), join(home, ".config", "systemd"),
    join(home, ".local", "share", "systemd"), "/etc/crow", "/run/credentials", "/run/user", "/run/docker.sock", "/var/run/docker.sock"];
}

function otherInstanceHomes(home, crowHome) {
  const out = [];
  try {
    for (const e of readdirSync(home)) {
      const p = join(home, e);
      if (/^\.crow(-|$)/.test(e) && p !== crowHome) out.push(p);
    }
  } catch {}
  return out;
}

/**
 * Build the bwrap argv (everything before "--") for one contained pi spawn.
 * Pure apart from realpath/stat; nothing is created.
 * @returns {{args: string[], env: object, refused: {path, reason}[]}}
 */
export function buildContainPlan(o) {
  const exists = o.exists || existsSync;
  const home = o.home;
  _home = home;
  const refused = [];
  const ro = new Map(); // dest -> src
  const rw = new Map();
  const masks = []; // [dest, "dir"|"file"]
  function maskPath(p) {
    try {
      const st = lstatSync(p);
      if (st.isDirectory()) masks.push([p, "dir"]);
      else if (st.isSymbolicLink()) { /* dangling inside unless its target is bound; handled below */ }
      else masks.push([p, "file"]);
    } catch {}
  }

  for (const list of [o.writePaths || [], o.readPaths || []]) {
    if (list.some((p) => p === "/" || resolve(String(p)) === "/")) {
      throw new ContainRefused("permissionMode bypass (\"/\" in write_paths/read_paths) cannot run in the contain tier");
    }
  }

  const instanceSecrets = [];
  if (o.crowHome) {
    for (const n of ["secrets", "env", "peer-tokens.json", "android-keystore", ".keystore-env"]) instanceSecrets.push(join(o.crowHome, n));
    try { for (const e of readdirSync(o.crowHome)) if (/-token$/.test(e)) instanceSecrets.push(join(o.crowHome, e)); } catch {}
  }
  const never = [...neverBound(home), ...instanceSecrets].map((p) => (exists(p) ? (() => { try { return realpathSync(p); } catch { return p; } })() : p));
  const others = otherInstanceHomes(home, o.crowHome);
  const homesRoot = dirname(home);
  const codeRoots = [o.appRoot, o.nodeBin && dirname(dirname(o.nodeBin)), o.piLabDir].filter(Boolean)
    .map((p) => real(p, exists) || p);

  function forbidden(p, { write = false, policy = false } = {}) {
    if (p === "/") return "the whole filesystem";
    if (SHARED_ROOTS.includes(p)) return "a shared system directory (" + p + ")";
    if (p === home || p === homesRoot) return "the whole home";
    if (under(home, p)) return "an ancestor of the home";
    for (const n of never) if (under(p, n) || under(n, p)) return "a protected path (" + n + ")";
    for (const x of others) if (under(p, x)) return "another Crow instance's home";
    if (under(p, homesRoot) && !under(p, home)) return "another user's home";
    if (write) for (const c of codeRoots) if (under(p, c) || under(c, p)) return "code (the checkout or the engine) is never writable";
    if (write && policy && under(p, home)) {
      const top = p.slice(home.length + 1).split(sep)[0];
      const dataReal = o.dataDir ? (real(o.dataDir, exists) || o.dataDir) : null;
      if (top.startsWith(".") && !(dataReal && under(p, dataReal))) return "a hidden entry of the home (rc files, config, PATH dirs) is never writable from a policy";
    }
    return null;
  }

  function add(map, p, { write = false, label = "", policy = false } = {}) {
    if (!p) return;
    const r = real(p, exists);
    if (!r) { refused.push({ path: p, reason: "does not exist" + (label ? " (" + label + ")" : "") }); return; }
    const why = forbidden(r, { write, policy });
    if (why) { refused.push({ path: p, reason: why }); return; }
    map.set(r, r);
  }

  // engine (read-only)
  if (o.nodeBin) add(ro, dirname(dirname(o.nodeBin)), { label: "node" });
  if (o.cliPath) add(ro, packageRoot(o.cliPath, exists), { label: "pi" });
  add(ro, o.appRoot, { label: "checkout" });
  if (o.piLabDir) add(ro, o.piLabDir, { label: "pi-lab" });
  if (o.crowHome) { const sk = join(o.crowHome, "skills"); if (exists(sk)) add(ro, sk); }
  // pi packages (settings.json packages[]): pi-lab, which holds the permission
  // gate, is loaded this way. A package that exists on the host but cannot be
  // bound would make pi start WITHOUT it: refuse the spawn instead.
  if (o.piAgentDir) {
    let pkgs = [];
    try { pkgs = JSON.parse(readFileSync(join(o.shadowAgentDir || o.piAgentDir, "settings.json"), "utf8")).packages || []; } catch {}
    for (const entry of Array.isArray(pkgs) ? pkgs : []) {
      const spec = typeof entry === "string" ? entry : (entry && (entry.source || entry.path)) || "";
      if (!spec || !(spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("~"))) continue; // a registry name: lives under the agent dir
      const abs = spec.startsWith("~") ? join(home, spec.slice(1)) : resolve(o.piAgentDir, spec);
      if (!exists(abs)) continue; // missing on the host too: pi behaves as it does unsandboxed
      const r = real(abs, exists);
      if (r && under(r, o.piAgentDir)) continue; // pkg/... is bound with the agent subdirs
      const before = refused.length;
      add(ro, abs, { label: "pi package" });
      if (refused.length > before) throw new ContainRefused("pi package " + spec + " cannot be bound into the contain tier (" + refused[refused.length - 1].reason + "); refusing to start pi without it");
    }
  }

  // MCP servers
  for (const s of o.mcpServers || []) {
    if (s.cwd && real(s.cwd, exists) !== real(home, exists)) add(ro, s.cwd, { label: "mcp cwd" });
    if (s.command && isAbsolute(s.command)) {
      const c = real(s.command, exists);
      if (c) {
        const root = dirname(dirname(c)); // <root>/bin/<cmd>
        if (under(root, home) && root !== real(home, exists)) add(ro, root, { label: "mcp command" });
      }
    }
    for (const v of Object.values(s.env || {})) {
      const val = String(v || "");
      if (isAbsolute(val) && !val.includes("\n") && exists(val)) {
        try { if (statSync(val).isFile()) add(ro, val, { label: "mcp env file" }); } catch {}
      }
    }
  }

  // instance data (read-write) + masks
  if (o.dataDir) {
    add(rw, o.dataDir, { write: true, label: "data dir" });
    const rd = real(o.dataDir, exists);
    if (rd && rw.has(rd)) {
      // The directory itself must be bound (SQLite creates -wal/-shm/-journal
      // beside the DB; a private copy of those would corrupt it), so every
      // OTHER entry present at spawn time is masked: other projects, backups,
      // peers, sync state, DB copies. Kept: the DBs, the bot's own project,
      // identity.json for a sharing bot, and the operator's keep-list.
      const keep = new Set(o.dataKeep || []);
      if (o.unmaskIdentity) keep.add("identity.json");
      const wsReal = o.workspaceDir ? real(o.workspaceDir, exists) : null;
      let entries = [];
      try { entries = readdirSync(rd); } catch {}
      for (const e of entries) {
        if (DB_FILE_RE.test(e) || keep.has(e)) continue;
        const p = join(rd, e);
        if (e === "projects" && wsReal && under(wsReal, p)) {
          let segs = [];
          try { segs = readdirSync(p); } catch {}
          for (const g of segs) { const q = join(p, g); if (!under(wsReal, q)) maskPath(q); }
          continue;
        }
        maskPath(p);
      }
    }
  }

  // bot cache
  if (o.botCacheDir) add(rw, o.botCacheDir, { write: true, label: "bot cache" });

  // bot paths
  for (const p of [o.sessionDir, o.cwd, o.workspaceDir]) if (p) add(rw, p, { write: true });
  for (const p of o.writePaths || []) add(rw, String(p), { write: true, label: "write_paths", policy: true });
  for (const p of o.readPaths || []) add(ro, String(p), { label: "read_paths" });
  // read-only when also writable: writable wins
  for (const k of rw.keys()) ro.delete(k);

  // ---- assemble ----
  const args = ["--tmpfs", "/"];
  for (const d of o.systemDirs || ["/usr", "/etc", "/opt"]) if (exists(d)) args.push("--ro-bind", d, d);
  for (const [link, target] of [["/bin", "usr/bin"], ["/sbin", "usr/sbin"], ["/lib", "usr/lib"], ["/lib64", "usr/lib64"], ["/lib32", "usr/lib32"]]) {
    let isLink = false;
    try { isLink = lstatSync(link).isSymbolicLink(); } catch {}
    if (isLink) args.push("--symlink", target, link);
    else if (exists(link) && !o.systemDirs) args.push("--ro-bind", link, link);
  }
  // /proc: a fresh procfs of the sandbox's OWN pid namespace (--unshare-pid,
  // required: without it a same-uid bot could signal every host process of
  // that uid; kill(2) checks the uid, not the namespace).
  args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--tmpfs", "/var/tmp", "--tmpfs", "/run");
  if (exists("/run/systemd/resolve")) args.push("--ro-bind", "/run/systemd/resolve", "/run/systemd/resolve");
  if (exists("/etc/crow")) args.push("--tmpfs", "/etc/crow");
  args.push("--tmpfs", home);

  // .env files: never readable from a bound dir (the checkout's .env holds
  // the gateway's secrets; bundle .env files hold extension secrets). Top
  // level of every bound dir, plus <bound>/bundles/*/ (the checkout's).
  const boundDirs = [...ro.keys(), ...rw.keys()].filter((p) => { try { return statSync(p).isDirectory(); } catch { return false; } });
  const isBound = (p) => boundDirs.some((d) => under(p, d)) || ro.has(p) || rw.has(p);
  const envScan = new Set(boundDirs);
  for (const d of boundDirs) {
    const b = join(d, "bundles");
    try { for (const e of readdirSync(b)) envScan.add(join(b, e)); } catch {}
  }
  for (const d of envScan) {
    let names = [];
    try { names = readdirSync(d); } catch { continue; }
    for (const n of names) {
      if (!/^\.env(\..*)?$/.test(n)) continue;
      const p = join(d, n);
      let st; try { st = lstatSync(p); } catch { continue; }
      if (st.isSymbolicLink()) {
        const t = real(p, exists);
        if (t && isBound(t)) masks.push([t, "file"]);
      } else if (st.isFile()) masks.push([p, "file"]);
    }
  }

  // binds, parents first (sorted by path), rw and ro interleaved by path
  const binds = [...[...ro.keys()].map((p) => ["--ro-bind", p]), ...[...rw.keys()].map((p) => ["--bind", p])]
    .sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  // pi agent shadow goes in path order too
  const agentEntries = [];
  if (o.piAgentDir && o.shadowAgentDir) {
    agentEntries.push(["--bind", o.shadowAgentDir, o.piAgentDir]);
    for (const d of AGENT_RO_SUBDIRS) {
      const p = join(o.piAgentDir, d);
      if (exists(p)) agentEntries.push(["--ro-bind", p, p]);
    }
  }
  // One list in destination order: a dir's bind, then masks inside it, then
  // binds of its descendants (a project workspace re-exposed under a masked
  // projects/ entry). Same dest: the bind first, the mask after.
  const maskOps = [...new Map(masks.map(([d, k]) => [d, k])).entries()]
    .map(([d, k]) => (k === "dir" ? ["--tmpfs", null, d, 1] : ["--ro-bind", "/dev/null", d, 1]));
  const all = [...binds.map(([f, p]) => [f, p, p, 0]), ...agentEntries.map((e) => [...e, 0]), ...maskOps].sort((a, b) => {
    if (a[2] === b[2]) return a[3] - b[3];
    return a[2] < b[2] ? -1 : 1;
  });
  for (const [f, s, d] of all) {
    if (f === "--tmpfs") args.push("--tmpfs", d);
    else args.push(f, s, d);
  }

  args.push("--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup-try", "--cap-drop", "ALL");
  const cwd = real(o.cwd || o.sessionDir, exists);
  if (cwd) args.push("--chdir", cwd);

  const env = { TMPDIR: "/tmp" };
  if (o.botCacheDir) {
    env.XDG_CACHE_HOME = o.botCacheDir;
    env.npm_config_cache = join(o.botCacheDir, "npm");
    env.UV_CACHE_DIR = join(o.botCacheDir, "uv");
  }
  return { args, env, refused };
}

/**
 * A per-spawn shadow of the pi agent dir: a fresh 0700 dir with copies of the
 * small config files (AGENT_SHADOW_FILES, mode 0600) and empty mount points
 * for AGENT_RO_SUBDIRS. Created on the SPAWNER's side (never inside a path a
 * bot can write); cleanup() removes it with every write pi made to it.
 */
export function prepareAgentShadow(piAgentDir, { parent = tmpdir() } = {}) {
  const dir = mkdtempSync(join(parent, "crow-pi-agent-"));
  chmodSync(dir, 0o700);
  for (const f of AGENT_SHADOW_FILES) {
    const src = join(piAgentDir, f);
    try {
      if (!lstatSync(src).isFile()) continue; // never follow a symlink out of the agent dir
      copyFileSync(src, join(dir, f));
      chmodSync(join(dir, f), 0o600);
    } catch { /* absent: pi uses its defaults */ }
  }
  for (const d of AGENT_RO_SUBDIRS) {
    if (existsSync(join(piAgentDir, d))) mkdirSync(join(dir, d), { mode: 0o700 });
  }
  return { dir, cleanup: () => { try { rmSync(dir, { recursive: true, force: true }); } catch {} } };
}
