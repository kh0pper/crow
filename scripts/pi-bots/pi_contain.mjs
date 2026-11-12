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
 *   pi state    ~/.pi/agent = a per-spawn GENERATED dir (writable, discarded;
 *               pi_contain_agent.mjs): a door-only models.json, an empty
 *               mcp.json, the operator's settings.json/keybindings.json, and
 *               a 0600 copy of the role snapshot. No auth.json, no
 *               models-store.json, no provider key. pi creates lock dirs
 *               beside those files, and a bot must not be able to edit the
 *               real settings (packages[] loads extensions into every later
 *               pi). Its subdirs with code (pkg, agents, prompts, bin) are
 *               bound read-only on top. The operator's own pi sessions are
 *               not visible.
 *   door token  <CROW_HOME>/llm-cloud-token, read-only, and bound only when
 *               the generated models.json carries a consented `/llm/c` entry;
 *               bound at its RESOLVED path, which is exactly the path that
 *               entry's `!cat` apiKey names. The ONE file under the Crow home
 *               a contained bot reads.
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
 * a bot's git key dir (the contain tier has no git in v1), /etc/crow,
 * /run/credentials, /run/user, docker sockets; nor is the checkout
 * or engine ever writable. "/" in write_paths/read_paths (permissionMode
 * bypass) cannot be contained: ContainRefused.
 *
 * Selection comes from the SPAWNER's env only (a bot def's spawn_env is
 * stripped of these names): CROW_PI_SANDBOX=contain for every pi, or
 * CROW_PI_CONTAIN_BOTS=<id,id> for listed bots.
 *
 * A data folder that IS the Crow home (or an ancestor of it) is refused: the
 * instance's tokens, secrets/ and env/ live there, so it can never be a
 * read-write bind. Nothing of the Crow home is a read-write bind except the
 * data dir and the bot cache below it. A read_paths entry naming a NON-secret
 * entry of the home (a bundle dir, say) is bound read-only, with its .env files
 * masked; token files, secrets/ and env/ are never bound, whatever the policy.
 *
 * Co-hosted instances are matched by RESOLVED path: a home reached through a
 * symlink, or declared outside $HOME, is protected the same way as a
 * `$HOME/.crow-*` sibling.
 */
import { chmodSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve, sep } from "node:path";
import { buildContainedAgentDir } from "./pi_contain_agent.mjs";

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
/** Top-level agent files a contained spawn's generated dir carries: the two
 *  copied config files and the two this engine writes. auth.json,
 *  models-store.json and the operator's own models.json are NEVER part of it
 *  (pi_contain_agent.mjs). */
export const AGENT_SHADOW_FILES = Object.freeze(["settings.json", "keybindings.json", "models.json", "mcp.json"]);
/** Where the egress relay's socket dir appears inside a contained sandbox. */
export const NET_RELAY_MOUNT = "/run/crow-net";

/** .env scan (masking): names, skipped dirs, caps. */
export const ENV_NAME_RE = /^\.env(\..*)?$/;
export const ENV_SCAN_SKIP = new Set(["node_modules", ".git", ".venv", "__pycache__"]);
export const ENV_SCAN_MAX_DEPTH = 16;
export const ENV_SCAN_MAX_ENTRIES = 50000;

/** Data-dir entries a contained bot keeps: the DB files and their journals. */
export const DB_FILE_RE = /^(crow|tasks)\.db(-wal|-shm|-journal)?$/;

const under = (p, root) => p === root || p.startsWith(root.endsWith(sep) ? root : root + sep);

let _home = null;
function real(p, exists, home = _home) {
  if (p && home && (p === "~" || p.startsWith("~/"))) p = join(home, p.slice(1));
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

/** Co-hosted homes named `$HOME/.crow*`, at their REAL paths (a home is often
 *  a symlink into a data disk), minus this instance's own. */
function otherInstanceHomes(home, crowHome, exists) {
  const out = [];
  try {
    for (const e of readdirSync(home)) {
      const p = join(home, e);
      if (!/^\.crow(-|$)/.test(e)) continue;
      const r = real(p, exists) || p;
      if (r !== crowHome) out.push(r);
    }
  } catch {}
  return out;
}

// --- pieces shared by the bot plan and the add-on plan ---------------------

/**
 * One sandbox's bind policy: what is never a bind source (`never`), the
 * co-hosted Crow homes (`others`), and the two closures a plan builder uses —
 * `forbidden(p, {write, policy})` (a reason, or null) and
 * `add(map, p, {write, label, policy})` (bind `p` at its resolved path, or
 * record the refusal in `refused`).
 */
export function makeBindPolicy({ home, crowHome, crowHomeReal, dataDir, appRoot, nodeBin, piLabDir, otherHomes, exists = existsSync, refused = [] } = {}) {
  const instanceSecrets = [];
  if (crowHome) {
    for (const n of ["secrets", "env", "peer-tokens.json", "android-keystore", ".keystore-env"]) instanceSecrets.push(join(crowHome, n));
    try { for (const e of readdirSync(crowHome)) if (/-token$/.test(e)) instanceSecrets.push(join(crowHome, e)); } catch {}
  }
  const never = [...neverBound(home), ...instanceSecrets].map((p) => (exists(p) ? (() => { try { return realpathSync(p); } catch { return p; } })() : p));
  // No read-write bind may BE the Crow home or its secrets dir, or an ancestor
  // of either: any of those puts the instance's tokens, secrets/ and env/
  // inside the sandbox. (A write path INSIDE secrets/ is caught by `never`.)
  const closedRw = crowHomeReal ? [crowHomeReal, join(crowHomeReal, "secrets")] : [];
  // Co-hosted homes: the ones the spawner already found (secrets dirs and
  // declared homes, resolved with realpath on its side) plus the `.crow*`
  // siblings of $HOME, each resolved here. Self and anything that CONTAINS the
  // home are dropped: this instance's own home is refused by its own rules, and
  // an entry that covered the home would refuse every bind.
  const declaredHomes = (Array.isArray(otherHomes) ? otherHomes : [])
    .filter((p) => typeof p === "string" && isAbsolute(p));
  const others = [...new Set([
    ...declaredHomes.map((p) => real(p, exists, home) || resolve(p)),
    ...otherInstanceHomes(home, crowHomeReal, exists),
  ])].filter((p) => p !== home && p !== crowHomeReal && !under(home, p) && !(crowHomeReal && under(crowHomeReal, p)));
  const homesRoot = dirname(home);
  const codeRoots = [appRoot, nodeBin && dirname(dirname(nodeBin)), piLabDir].filter(Boolean)
    .map((p) => real(p, exists, home) || p);
  const dataReal = dataDir ? (real(dataDir, exists, home) || dataDir) : null;

  function forbidden(p, { write = false, policy = false } = {}) {
    if (p === "/") return "the whole filesystem";
    if (SHARED_ROOTS.includes(p)) return "a shared system directory (" + p + ")";
    if (p === home || p === homesRoot) return "the whole home";
    if (under(home, p)) return "an ancestor of the home";
    if (write) for (const c of closedRw) if (under(c, p)) return "the Crow home (" + c + ") is never writable, and neither is an ancestor of it";
    for (const n of never) if (under(p, n) || under(n, p)) return "a protected path (" + n + ")";
    // Under, equal to, or an ANCESTOR of a co-hosted home: binding a parent
    // would put that instance's home (and its secrets) inside the sandbox.
    for (const x of others) if (under(p, x) || under(x, p)) return "another Crow instance's home";
    if (under(p, homesRoot) && !under(p, home)) return "another user's home";
    if (write) for (const c of codeRoots) if (under(p, c) || under(c, p)) return "code (the checkout or the engine) is never writable";
    if (write && policy && under(p, home)) {
      const top = p.slice(home.length + 1).split(sep)[0];
      if (top.startsWith(".") && !(dataReal && under(p, dataReal))) return "a hidden entry of the home (rc files, config, PATH dirs) is never writable from a policy";
    }
    return null;
  }

  function add(map, p, { write = false, label = "", policy = false } = {}) {
    if (!p) return;
    const r = real(p, exists, home);
    if (!r) { refused.push({ path: p, reason: "does not exist" + (label ? " (" + label + ")" : "") }); return; }
    const why = forbidden(r, { write, policy });
    if (why) { refused.push({ path: p, reason: why }); return; }
    map.set(r, r);
  }

  return { forbidden, add, never, others, closedRw };
}

/**
 * The empty root of a sandbox: `--tmpfs /`, the system dirs read-only, the
 * usr-merge symlinks, a fresh procfs of the sandbox's own pid namespace, /dev
 * and /tmp, a private /run, the DNS stub, a masked /etc/crow and an empty tmpfs
 * at the home path.
 */
export function rootArgs({ systemDirs, exists = existsSync, home } = {}) {
  const args = ["--tmpfs", "/"];
  for (const d of systemDirs || ["/usr", "/etc", "/opt"]) if (exists(d)) args.push("--ro-bind", d, d);
  for (const [link, target] of [["/bin", "usr/bin"], ["/sbin", "usr/sbin"], ["/lib", "usr/lib"], ["/lib64", "usr/lib64"], ["/lib32", "usr/lib32"]]) {
    let isLink = false;
    try { isLink = lstatSync(link).isSymbolicLink(); } catch {}
    if (isLink) args.push("--symlink", target, link);
    else if (exists(link) && !systemDirs) args.push("--ro-bind", link, link);
  }
  // /proc: a fresh procfs of the sandbox's OWN pid namespace (--unshare-pid,
  // required: without it a same-uid process could signal every host process of
  // that uid; kill(2) checks the uid, not the namespace).
  args.push("--proc", "/proc", "--dev", "/dev", "--tmpfs", "/tmp", "--tmpfs", "/var/tmp", "--tmpfs", "/run");
  if (exists("/run/systemd/resolve")) args.push("--ro-bind", "/run/systemd/resolve", "/run/systemd/resolve");
  if (exists("/etc/crow")) args.push("--tmpfs", "/etc/crow");
  if (home) args.push("--tmpfs", home);
  return args;
}

/** Record one mask for `p` in a mask list: a tmpfs over a directory, /dev/null over a file.
 *  A symlink is left alone: it is harmless unless its target is itself bound (see
 *  the `.env` scan, which masks the bound target of a symlinked `.env`). */
export function maskPathInto(masks, p) {
  try {
    const st = lstatSync(p);
    if (st.isDirectory()) masks.push([p, "dir"]);
    else if (st.isSymbolicLink()) { /* left alone: only a bound target needs a mask */ }
    else masks.push([p, "file"]);
  } catch {}
}

/**
 * Mask every `.env` file found in a bound dir (the checkout's .env holds the
 * gateway's secrets; bundle .env files hold extension secrets, at any depth).
 * Every bound dir is walked (no symlinked dirs followed; package code under
 * node_modules/, .venv/, __pycache__/ and .git/ skipped; masked dirs skipped)
 * with a depth and entry cap. Hitting the cap FAILS CLOSED: a policy path is
 * not bound at all; any other bound dir refuses the spawn.
 *
 * `keep` is an optional Set of exact file paths (lexical or resolved) that stay
 * readable: an add-on's own `bundles/<id>/.env`, and nothing at all for a bot.
 */
export function scanEnvMasks({ ro, rw, masks, policyDirs = new Set(), maxDepth = ENV_SCAN_MAX_DEPTH, maxEntries = ENV_SCAN_MAX_ENTRIES, exists = existsSync, home = null, refused = [], keep = null } = {}) {
  const maskedDirs = new Set(masks.filter(([, k]) => k === "dir").map(([d]) => d));
  const boundDirs = () => [...ro.keys(), ...rw.keys()].filter((p) => { try { return statSync(p).isDirectory(); } catch { return false; } });
  const isBound = (p) => boundDirs().some((d) => under(p, d)) || ro.has(p) || rw.has(p);
  for (const d of boundDirs()) {
    const found = [];
    let seen = 0, capped = false;
    const walk = (dir, depth) => {
      if (capped) return;
      let names = [];
      try { names = readdirSync(dir); } catch { return; }
      for (const n of names) {
        if (++seen > maxEntries) { capped = true; return; }
        const p = join(dir, n);
        let st; try { st = lstatSync(p); } catch { continue; }
        if (ENV_NAME_RE.test(n)) {
          if (st.isSymbolicLink()) found.push(["link", p]);
          else if (st.isFile()) found.push(["file", p]);
          continue;
        }
        if (st.isDirectory() && !ENV_SCAN_SKIP.has(n) && !maskedDirs.has(p)) {
          if (depth >= maxDepth) { capped = true; return; }
          walk(p, depth + 1);
          if (capped) return;
        }
      }
    };
    walk(d, 1);
    if (capped) {
      if (policyDirs.has(d)) {
        ro.delete(d); rw.delete(d);
        refused.push({ path: d, reason: "too large to scan for .env files (cap " + maxEntries + " entries / depth " + maxDepth + "); not bound" });
        continue;
      }
      throw new ContainRefused(d + " is too large to scan for .env files (cap " + maxEntries + " entries / depth " + maxDepth + "); refusing to bind it unscanned");
    }
    for (const [kind, p] of found) {
      if (keep && (keep.has(p) || keep.has(real(p, exists, home)))) continue;
      if (kind === "file") masks.push([p, "file"]);
      else { const t = real(p, exists, home); if (t && isBound(t)) masks.push([t, "file"]); }
    }
  }
}

/**
 * Assemble every mount op in DESTINATION order: a dir's bind, then the masks
 * inside it, then the binds of its descendants (a project workspace re-exposed
 * under a masked projects/ entry). Same destination: the bind first, the mask
 * after. `extraEntries` are `[flag, src, dest]` triples placed in that order
 * too (the relay bind, an agent shadow, a bind-fd).
 */
export function assembleBindArgs({ ro, rw, masks, extraEntries = [] } = {}) {
  const binds = [...[...ro.keys()].map((p) => ["--ro-bind", p]), ...[...rw.keys()].map((p) => ["--bind", p])]
    .sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const maskOps = [...new Map(masks.map(([d, k]) => [d, k])).entries()]
    .map(([d, k]) => (k === "dir" ? ["--tmpfs", null, d, 1] : ["--ro-bind", "/dev/null", d, 1]));
  const all = [...binds.map(([f, p]) => [f, p, p, 0]), ...extraEntries.map((e) => [...e, 0]), ...maskOps].sort((a, b) => {
    if (a[2] === b[2]) return a[3] - b[3];
    return a[2] < b[2] ? -1 : 1;
  });
  const args = [];
  for (const [f, s, d] of all) {
    if (f === "--tmpfs") args.push("--tmpfs", d);
    else args.push(f, s, d);
  }
  return args;
}

/**
 * Build the bwrap argv (everything before "--") for one contained pi spawn.
 * Pure apart from realpath/stat; nothing is created.
 *
 * `otherHomes` is the co-hosted Crow homes the spawner already found (its
 * instance-secrets scan's homes, including declared ones, each RESOLVED with
 * realpath). They are refused as bind sources by resolved path, so a symlinked
 * home or one declared outside $HOME is covered as well as a `$HOME/.crow-*`
 * sibling.
 * @returns {{args: string[], env: object, refused: {path, reason}[]}}
 */
export function buildContainPlan(o) {
  const exists = o.exists || existsSync;
  const home = o.home;
  _home = home;
  const crowHomeReal = o.crowHome ? (real(o.crowHome, exists) || resolve(String(o.crowHome))) : null;
  // The operator's ruling (2026-11-02): a data folder that IS the Crow home,
  // or an ancestor of it, is refused rather than masked over. Binding it read-write
  // would put the instance's tokens, secrets/ and env/ inside the sandbox, and
  // an ancestor would put every instance home on the box there.
  if (crowHomeReal && o.dataDir && under(crowHomeReal, real(o.dataDir, exists) || resolve(String(o.dataDir)))) {
    throw new ContainRefused("contain refused: the data folder is the Crow home");
  }
  const refused = [];
  const ro = new Map(); // dest -> src
  const rw = new Map();
  const masks = []; // [dest, "dir"|"file"]
  function maskPath(p) { maskPathInto(masks, p); }

  for (const list of [o.writePaths || [], o.readPaths || []]) {
    if (list.some((p) => p === "/" || resolve(String(p)) === "/")) {
      throw new ContainRefused("permissionMode bypass (\"/\" in write_paths/read_paths) cannot run in the contain tier");
    }
  }

  const { forbidden, add, closedRw } = makeBindPolicy({
    home, crowHome: o.crowHome, crowHomeReal, dataDir: o.dataDir,
    appRoot: o.appRoot, nodeBin: o.nodeBin, piLabDir: o.piLabDir, otherHomes: o.otherHomes,
    exists, refused,
  });

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

  // The cloud-door token is the ONE file under the Crow home a contained bot
  // reads: a consented cloud row's models.json key is `!cat <path>`, which pi
  // runs itself on every auth resolve. Bound alone, read-only; nothing around
  // it is bound. Not via add(): `never` holds every *-token file in the home.
  if (o.cloudTokenPath) {
    const t = real(o.cloudTokenPath, exists);
    if (t) ro.set(t, t);
    else refused.push({ path: o.cloudTokenPath, reason: "the cloud door token does not exist; a consented cloud model would fail every request" });
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
  for (const p of o.writePaths || []) {
    // The operator's ruling: a policy write path that is the Crow home (or an ancestor
    // of it) refuses the SPAWN, with the reason named — the turn does not run
    // with the path silently dropped.
    const r = real(String(p), exists);
    if (r) for (const c of closedRw) {
      if (under(c, r)) throw new ContainRefused("contain refused: write_paths names " + r + ", which covers the Crow home (" + c + ") and is never writable under contain");
    }
    add(rw, String(p), { write: true, label: "write_paths", policy: true });
  }
  for (const p of o.readPaths || []) add(ro, String(p), { label: "read_paths" });
  // read-only when also writable: writable wins
  for (const k of rw.keys()) ro.delete(k);

  // ---- assemble ----
  const args = rootArgs({ systemDirs: o.systemDirs, exists, home });

  // .env files: see scanEnvMasks (everything masked; a bot keeps nothing).
  const policyDirs = new Set([...(o.writePaths || []), ...(o.readPaths || [])].map((p) => real(String(p), exists)).filter(Boolean));
  scanEnvMasks({
    ro, rw, masks, policyDirs,
    maxDepth: o.envScanMaxDepth ?? ENV_SCAN_MAX_DEPTH,
    maxEntries: o.envScanMaxEntries ?? ENV_SCAN_MAX_ENTRIES,
    exists, home, refused,
  });

  // binds, parents first (sorted by path), rw and ro interleaved by path
  // pi agent shadow goes in path order too
  const agentEntries = [];
  // Network tier (2c): the relay's socket dir, read-only, at a fixed path.
  if (o.net && o.net.relayDir) agentEntries.push(["--ro-bind", o.net.relayDir, NET_RELAY_MOUNT]);
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
  args.push(...assembleBindArgs({ ro, rw, masks, extraEntries: agentEntries }));

  args.push("--unshare-user", "--unshare-pid", "--unshare-ipc", "--unshare-uts", "--unshare-cgroup-try", "--cap-drop", "ALL");
  if (o.net) args.push("--unshare-net");
  const cwd = real(o.cwd || o.sessionDir, exists);
  if (cwd) args.push("--chdir", cwd);

  const env = { TMPDIR: "/tmp" };
  if (o.botCacheDir) {
    env.XDG_CACHE_HOME = o.botCacheDir;
    env.npm_config_cache = join(o.botCacheDir, "npm");
    env.UV_CACHE_DIR = join(o.botCacheDir, "uv");
  }
  let net = null;
  if (o.net) {
    const ports = [...new Set((o.net.loopbackPorts || []).map(Number).filter((x) => x > 0 && x < 65536))];
    let proxyPort = o.net.proxyPort || 39080;
    while (ports.includes(proxyPort)) proxyPort++;
    const proxy = "http://127.0.0.1:" + proxyPort;
    Object.assign(env, {
      HTTP_PROXY: proxy, HTTPS_PROXY: proxy, http_proxy: proxy, https_proxy: proxy, ALL_PROXY: proxy, all_proxy: proxy,
      NO_PROXY: "127.0.0.1,localhost,::1", no_proxy: "127.0.0.1,localhost,::1", NODE_USE_ENV_PROXY: "1",
    });
    net = { sock: NET_RELAY_MOUNT + "/relay.sock", ports, proxyPort };
  }
  return { args, env, refused, net };
}

/**
 * A per-spawn pi agent dir: a fresh 0700 dir filled by buildContainedAgentDir
 * (pi_contain_agent.mjs) — a door-only models.json, an empty mcp.json, the
 * operator's settings.json/keybindings.json and a 0600 role-snapshot copy, and
 * empty mount points for AGENT_RO_SUBDIRS. Nothing else: no auth.json, no
 * provider key, no models-store.json, no skills. Created on the SPAWNER's side
 * (never inside a path a bot can write); cleanup() removes it with every write
 * pi made to it.
 *
 * @returns {{dir: string, missing: Array<{provider: string, reason: string}>, env: object, cloudTokenPath: string|null, cleanup: Function}}
 *   `missing` is the providers this spawn needs with no door: wrapPiSpawn
 *   refuses the spawn while it is non-empty. `cloudTokenPath` is the RESOLVED
 *   cloud-door token file to bind read-only, or null when the generated
 *   models.json has no `/llm/c` entry (then nothing reads it).
 */
export function prepareAgentShadow(piAgentDir, {
  parent = tmpdir(), providerIds = [], rows = [], consent = null, consentSalt = null,
  gatewayPort = null, cloudTokenPath = null, modelRolesFile = null,
} = {}) {
  const dir = mkdtempSync(join(parent, "crow-pi-agent-" + process.pid + "-"));
  chmodSync(dir, 0o700);
  const generated = buildContainedAgentDir({ piAgentDir, dir, providerIds, rows, consent, consentSalt, gatewayPort, cloudTokenPath, modelRolesFile });
  return {
    dir,
    missing: generated.missing,
    env: generated.env,
    cloudTokenPath: generated.cloudTokenPath,
    cleanup: () => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch {} },
  };
}

/**
 * Remove per-spawn contain dirs (agent shadows, egress relay dirs, an add-on's
 * walled relay dirs) left in `parent` by a spawner that died before its cleanup
 * ran. The spawner's pid is in the name; only dirs owned by this uid whose
 * spawner is gone are removed, so a long-lived session of a running gateway is
 * never touched.
 */
export function sweepStaleContainDirs({ parent = tmpdir(), uid = process.getuid() } = {}) {
  let removed = 0;
  let names = [];
  try { names = readdirSync(parent); } catch { return 0; }
  for (const n of names) {
    const m = n.match(/^(?:crow-pi-(?:agent|net)|crow-addon-net)-(\d+)-/);
    if (!m) continue;
    const pid = Number(m[1]);
    if (pid === process.pid) continue;
    let alive = true;
    try { process.kill(pid, 0); } catch (e) { alive = !!(e && e.code === "EPERM"); }
    if (alive) continue;
    const p = join(parent, n);
    try {
      const st = lstatSync(p);
      if (!st.isDirectory() || st.uid !== uid) continue;
      rmSync(p, { recursive: true, force: true, maxRetries: 3 });
      removed++;
    } catch {}
  }
  return removed;
}
