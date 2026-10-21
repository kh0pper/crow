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
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
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
/** Data-dir entries masked by default. */
export const DATA_MASKS = Object.freeze(["identity.json"]);

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
  const masksFile = [];
  const masksDir = [];

  for (const list of [o.writePaths || [], o.readPaths || []]) {
    if (list.some((p) => p === "/" || resolve(String(p)) === "/")) {
      throw new ContainRefused("permissionMode bypass (\"/\" in write_paths/read_paths) cannot run in the contain tier");
    }
  }

  const never = neverBound(home).map((p) => (exists(p) ? (() => { try { return realpathSync(p); } catch { return p; } })() : p));
  const others = otherInstanceHomes(home, o.crowHome);
  const homesRoot = dirname(home);
  const codeRoots = [o.appRoot, o.nodeBin && dirname(dirname(o.nodeBin)), o.piLabDir].filter(Boolean)
    .map((p) => real(p, exists) || p);

  function forbidden(p, { write = false } = {}) {
    if (p === "/") return "the whole filesystem";
    if (SHARED_ROOTS.includes(p)) return "a shared system directory (" + p + ")";
    if (p === home || p === homesRoot) return "the whole home";
    if (under(home, p)) return "an ancestor of the home";
    for (const n of never) if (under(p, n) || under(n, p)) return "a protected path (" + n + ")";
    for (const x of others) if (under(p, x)) return "another Crow instance's home";
    if (under(p, homesRoot) && !under(p, home)) return "another user's home";
    if (write) for (const c of codeRoots) if (under(p, c) || under(c, p)) return "code (the checkout or the engine) is never writable";
    return null;
  }

  function add(map, p, { write = false, label = "" } = {}) {
    if (!p) return;
    const r = real(p, exists);
    if (!r) { refused.push({ path: p, reason: "does not exist" + (label ? " (" + label + ")" : "") }); return; }
    const why = forbidden(r, { write });
    if (why) { refused.push({ path: p, reason: why }); return; }
    map.set(r, r);
  }

  // engine (read-only)
  if (o.nodeBin) add(ro, dirname(dirname(o.nodeBin)), { label: "node" });
  if (o.cliPath) add(ro, packageRoot(o.cliPath, exists), { label: "pi" });
  add(ro, o.appRoot, { label: "checkout" });
  if (o.piLabDir) add(ro, o.piLabDir, { label: "pi-lab" });
  if (o.crowHome) { const sk = join(o.crowHome, "skills"); if (exists(sk)) add(ro, sk); }

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
      for (const m of DATA_MASKS) {
        if (m === "identity.json" && o.unmaskIdentity) continue;
        const p = join(rd, m);
        if (exists(p)) { try { (lstatSync(p).isDirectory() ? masksDir : masksFile).push(p); } catch {} }
      }
    }
  }

  // bot cache
  if (o.botCacheDir) add(rw, o.botCacheDir, { write: true, label: "bot cache" });

  // bot paths
  for (const p of [o.sessionDir, o.cwd, o.workspaceDir]) if (p) add(rw, p, { write: true });
  for (const p of o.writePaths || []) add(rw, String(p), { write: true, label: "write_paths" });
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
  const all = [...binds.map(([f, p]) => [f, p, p]), ...agentEntries].sort((a, b) => {
    // stable: by dest path, shadow before its subdirs
    if (a[2] === b[2]) return 0;
    return a[2] < b[2] ? -1 : 1;
  });
  for (const [f, s, d] of all) args.push(f, s, d);
  for (const m of masksDir) args.push("--tmpfs", m);
  for (const m of masksFile) args.push("--ro-bind", "/dev/null", m);

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
