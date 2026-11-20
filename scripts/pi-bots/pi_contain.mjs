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
 *               Every OTHER entry of the data dir is masked with an empty
 *               READ-ONLY mount, so a write into another project's folder (or
 *               a bundle's state folder) FAILS instead of vanishing into a
 *               writable scratch tmpfs discarded with the spawn.
 *               The mask is NOT limited to what is on disk at spawn: the root
 *               stays read-write (SQLite needs it), so a bot could CREATE an
 *               entry a host process later trusts — `<data>/<installed-id>/
 *               .venv` is code that add-on's own uv runs OUTSIDE the sandbox.
 *               Every reserved name (RESERVED_DATA_ENTRIES, derived from the
 *               gateway's own list) and every installed bundle id (the union of
 *               the two installer records) is therefore masked whether or not it
 *               exists at spawn: an absent one gets an empty READ-ONLY mount, and
 *               the plan NAMES it as a mount point (its `mountPoints` reply).
 *               The empty 0700 dir the mount lands on is made by the SPAWNER,
 *               immediately before exec, by ensureContainMountPoints(): an empty
 *               directory of this uid, exactly the shape the installer makes for
 *               the same folder, never resolved through a symlink and never
 *               guessed. A mount point that cannot be made (a symlink, a file, a
 *               failure) or that belongs to another uid — freshly made or
 *               already there — REFUSES the spawn — bwrap mounts over a path, and
 *               a spawn that ran without one would leave the name reachable, so it
 *               is a precondition, never a best-effort side effect of the plan.
 *               Residual, documented at the mask: a top-level name that is neither
 *               reserved nor an id installed AT SPAWN — `<data>/totally-new` —
 *               stays creatable, and that is accepted: nothing on the host trusts
 *               a name Crow did not install, and the next spawn masks it as the
 *               present entry it then is. A FILE-shaped reserved entry
 *               (identity.json, instance-id, a DB) is masked only when present —
 *               an empty one planted on the host would break the gateway
 *               (INSTANCE_ID_UNREADABLE, a JSON parse of nothing). And a TRUSTED
 *               name that is a SYMLINK on the host is not masked at all
 *               (maskPathInto leaves links alone): the uv allowlist still refuses
 *               that bundle's venv/cache bind, because the realpath has to be
 *               exactly `<data>/<id>/.venv`, but a bundle command that resolves
 *               `<data>/<id>` through such a link is out of this plan's reach —
 *               the next step, if review wants it closed, is refusing the spawn
 *               at a symlinked trusted name. Making the root
 *               read-only instead would close all three,
 *               and SQLite rules it out: with journal_mode=DELETE every write
 *               creates `<db>-journal` in the data dir, and in WAL mode SQLite
 *               UNLINKS and recreates `-wal`/`-shm` when the last connection
 *               closes (servers/db.js's keeper note) — a bind-mounted file
 *               cannot be unlinked or recreated.
 *   bot         session dir + cwd + project workspace read-write; write_paths
 *               read-write; read_paths read-only (all realpath'd). A write path
 *               inside the bot's OWN pre-project world root (<crowHome>/pi-bots/<id>,
 *               where self-authoring stages skill proposals) is writable too
 *               (input `botStateDir`). That root is CREATED (0700) by the spawner before
 *               the plan when it is missing and resolves strictly inside this instance's
 *               <crowHome>/pi-bots (ensureContainOwnWorldRoot): a path that does not exist
 *               cannot be bound, and a write into the sandbox's empty tmpfs $HOME is lost.
 *               The id is the SPAWNER's own (containOwnWorldRoot), never one a def names: a def is
 *               bot-writable, so a def's session_dir cannot make this spawner create (or widen
 *               to) another bot's folder.
 *               A configured writable path that is still missing after that (anything outside
 *               pi-bots, or a root that could not be made) is listed in the plan's
 *               `droppedWrites`, so the containment status names it.
 *   MCP         each server's cwd and absolute command read-only: the command's
 *               install root, or — for a launcher in a folder never bound
 *               wholesale (~/.local/bin/uv sits beside the never-bound
 *               ~/.local/share/systemd) — exactly the executable FILE and its
 *               realpath target, never its parent folders; the file must be a
 *               regular executable and not a dotfile directly in $HOME, and it
 *               is never taken out of the operator's own PATH folders
 *               (~/bin, ~/.local/bin) unless it IS the block's pinned launcher
 *               (command_sha256, re-hashed at spawn) or a uv/uvx launcher. An
 *               absolute file named in a server's env is read-only too, UNLESS
 *               a writable bind already covers it (crow.db and tasks.db in the
 *               data dir). A uv block gets only what its OWN bundle allows:
 *               its project venv at exactly <data>/<bundle id>/.venv (matched by
 *               realpath, so a symlink elsewhere is refused) and the ONE cache
 *               path <data>/<bundle id>/.cache/uv (same rule). The id comes from
 *               the block's cwd or its absolute command resolved under
 *               <crowHome>/bundles/<id>, and only when that id passes the
 *               installer's bundle-id rule, is INSTALLED here (recorded by one of
 *               the two installer records, <crowHome>/installed.json or
 *               <crowHome>/mcp-addons.json, both read fail-closed) and is not a
 *               RESERVED data-dir entry (projects, peers, instance-sync,
 *               backups, pi-bots, secrets, env, the DB files, identity.json —
 *               the names the data-dir mask handles specially).
 *               Everything else — another bundle's venv, a `.venv` planted in
 *               <data>/projects/…, a cache anywhere but that one path, a block
 *               with no derivable bundle id — is logged and not bound: the mask
 *               on those data folders is what hides them.
 *   cache       one per-instance bot cache (npm, uv) read-write, so npx/uv
 *               work without touching the cache unsandboxed processes run
 *
 * Never bound, whatever a policy says: ~/.ssh, ~/.gnupg, ~/.claude, ~/.config
 * /gcloud (the Google Cloud CLI's credentials), ~/.config/systemd, the whole
 * $HOME, other /home users, other Crow instance homes,
 * a bot's git key dir (the contain tier has no git in v1), /etc/crow,
 * /run/credentials, /run/user, docker sockets; nor is the checkout
 * or engine ever writable. "/" in write_paths/read_paths (permissionMode
 * bypass) cannot be contained: ContainRefused.
 *
 * A hidden top-level entry of $HOME (~/.crow…, ~/.config, …) is never writable
 * from a policy, so the legacy self-authoring staging dir
 * (<crowHome>/pi-bots/<id>/proposed-skills, which the Bot Builder's review UI
 * scans) would be dropped. The ONE exception is the bot's OWN pre-project world
 * root (input `botStateDir`, always below <crowHome>/pi-bots): a write path
 * inside it is bound writable, so a contained bot's skill proposals still land
 * where the review UI looks. Nothing beside it, and nothing under a never-bound
 * path, is widened by that exception.
 *
 * Selection comes from the SPAWNER's env only (a bot def's spawn_env is
 * stripped of these names): CROW_PI_SANDBOX=contain for every pi, or
 * CROW_PI_CONTAIN_BOTS=<id,id> for listed bots, minus the ids CROW_PI_CONTAIN_EXCLUDE
 * names (an operator's exemption: contain every bot, exempt a test bot).
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
// The engine's bot-id charset, IMPORTED: an operator's exemption names a bot,
// and a token that is not a bot id is a typo, not a bot (leaf module: fs/path only).
import { BOT_ID_RE } from "./bot-workspace-env.mjs";
// The gateway's own list of the names Crow's data uses directly under the data folder
// (servers/gateway/compose-guard.js, where no bundle mount may claim one). It is IMPORTED,
// not copied, so a name the gateway starts using is masked for contained bots in the same
// commit; the leaf module imports nothing but a refusal helper, so this pulls no gateway
// state into the spawner.
import { RESERVED_DATA_NAMES } from "../../servers/gateway/compose-guard.js";

export class ContainRefused extends Error {
  constructor(msg) { super(msg); this.name = "ContainRefused"; }
}

/** Exemption tokens already reported, so one typo logs once per process instead
 *  of once per spawn (containSelected runs more than once per spawn). */
const warnedExcludeTokens = new Set();
/** Test seam only. */
export function _resetPiContainExcludeWarningsForTest() { warnedExcludeTokens.clear(); }

/**
 * `CROW_PI_CONTAIN_EXCLUDE=<bot id,...>` parsed and validated: the operator's
 * containment exemptions, and the entries that are not bot ids (typos, a path,
 * a whole sentence) — those are ignored with one log line each and never
 * exempt anything. Duplicates collapse.
 * @returns {{ids: string[], ignored: string[]}}
 */
export function containExcludeIds(env = process.env) {
  const ids = [], ignored = [];
  for (const raw of String((env && env.CROW_PI_CONTAIN_EXCLUDE) || "").split(",")) {
    const token = raw.trim();
    if (!token) continue;
    if (!BOT_ID_RE.test(token)) {
      if (!ignored.includes(token)) ignored.push(token);
      if (!warnedExcludeTokens.has(token)) {
        warnedExcludeTokens.add(token);
        console.error("[pi-contain] CROW_PI_CONTAIN_EXCLUDE: ignoring " + JSON.stringify(token.slice(0, 80)) +
          " (not a bot id: letters, digits, '_', '.', '-', starting with a letter or digit)");
      }
      continue;
    }
    if (!ids.includes(token)) ids.push(token);
  }
  return { ids, ignored };
}

/**
 * True when the operator's exemption really takes this bot OUT of the contain
 * tier: it is named in CROW_PI_CONTAIN_EXCLUDE (spawner env only) AND
 * containment would otherwise cover it (CROW_PI_SANDBOX=contain, or
 * CROW_PI_CONTAIN_BOTS lists it). An exemption WINS over every selector — that
 * is how an operator contains every bot and exempts one test bot — and an
 * exemption with nothing to exempt is not reported as one.
 */
export function containExcluded(env, botId) {
  if (!botId) return false;
  return containExemptedBots(env).includes(String(botId));
}

/**
 * The exemptions that really take a bot OUT of the contain tier here: the valid
 * ids that CROW_PI_SANDBOX=contain (all of them) or CROW_PI_CONTAIN_BOTS (the
 * overlap) would otherwise contain. Empty when nothing selects containment — an
 * exemption that exempts nothing is not shown as if it did. For status
 * surfaces (the Bot Runtime line), never for the spawn decision.
 */
export function containExemptedBots(env = process.env) {
  const mode = String((env && env.CROW_PI_SANDBOX) || "").trim().toLowerCase();
  if (mode === "off") return [];
  const { ids } = containExcludeIds(env);
  if (mode === "contain") return ids;
  const listed = String((env && env.CROW_PI_CONTAIN_BOTS) || "").split(",").map((s) => s.trim()).filter(Boolean);
  return ids.filter((id) => listed.includes(id));
}

export function containSelected(env, botId) {
  const mode = String(env.CROW_PI_SANDBOX || "").trim().toLowerCase();
  if (mode === "off") return false;
  const list = String(env.CROW_PI_CONTAIN_BOTS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const selected = mode === "contain" || (!!botId && list.includes(String(botId)));
  if (!selected) return false;
  return !containExcluded(env, botId);
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

/** The installer's bundle-id rule (routes/bundles.js isValidBundleId, skills-catalog.js
 *  isValidBundleId, satellites/installs.js BUNDLE_ID_RE): lowercase letters, digits and
 *  hyphens, starting with a letter or digit, at most 64 characters. `..`, uppercase and
 *  dots are not bundle ids. */
export const BUNDLE_ID_RE = /^[a-z0-9][a-z0-9-]{0,63}$/;

/**
 * Top-level entries of the instance's data dir that belong to the INSTANCE, never to a
 * bundle. The data-dir mask below handles them BY NAME: the DB files are kept (SQLite
 * writes -wal/-shm/-journal beside them), a sharing bot keeps identity.json, `projects`
 * is re-exposed down to the bot's own workspace, and the rest — peers, instance-sync,
 * backups, pi-bots, secrets, env, history, previews, … — are masked wholesale. So no
 * bundle may claim one: a uv bind at <data>/<such a name>/… would sit OVER that mask and
 * re-open instance state (another project's files, a peer's feed, a backup, the
 * pre-project bot roots). One list, read by the mask and by the uv allowlist
 * (bundleIdFor), so the two cannot drift.
 *
 * DERIVED from the gateway's own list of names Crow's data uses directly under the data
 * folder (servers/gateway/compose-guard.js RESERVED_DATA_NAMES), plus the names only this
 * plan has to know about: the pre-project bot roots (pi-bots/) and env/, which the compose
 * check sees under the Crow home but which sit under the data dir here; `identity.json`, the
 * FILE the sharing server derives every key from; `orchestrator-refcounts.json`, the FILE
 * shared/lifecycle.js keeps warm/release counts in; and the data-dir folders the servers join
 * a path onto themselves — `deleted-projects` (shared/project-lifecycle.js), `history`
 * (shared/history/*), `previews` (gateway/make/previews.js) and `artifacts`, the artifact
 * blob-store root (gateway/boot/mcp-mounts.js, blob-store-minio.js).
 * tests/pi-contain-plan.test.js fails if a gateway name is missing here, holds a hard-coded
 * MINIMUM of these names so the derivation cannot shrink silently, and walks servers/ and
 * scripts/ for any other `<data-ish>/<literal>` join or resolve.
 */
export const RESERVED_DATA_ENTRIES = Object.freeze([...new Set([
  ...RESERVED_DATA_NAMES,
  "pi-bots", "env", "identity.json", "orchestrator-refcounts.json", "deleted-projects", "history", "previews", "artifacts",
])]);

/**
 * The reserved names that are FILES by nature. A missing directory-shaped name is masked
 * with an empty mount point (see maskAbsentEntry); a missing FILE-shaped one is not: bwrap
 * creates the mount point on the HOST, and an empty `<data>/instance-id` makes
 * getOrCreateLocalInstanceId throw INSTANCE_ID_UNREADABLE, an empty `identity.json` makes
 * loadOrCreateIdentity's JSON.parse throw, and an empty `orchestrator-refcounts.json` makes
 * the lifecycle module's warm/release counts unreadable — a spawn would break the gateway
 * instead of protecting it. All of them are created by the instance itself, so the window is
 * a file the host has not minted yet; the residual is documented on the module header.
 */
export const RESERVED_DATA_FILES = Object.freeze(["identity.json", "instance-id", "orchestrator-refcounts.json"]);

/** Is `name` a top-level data-dir entry reserved for the instance's own use? */
export const isReservedDataEntry = (name) => typeof name === "string"
  && (RESERVED_DATA_ENTRIES.includes(name) || DB_FILE_RE.test(name));

/** One installer record as a set of ids: `null` when it cannot be read or its shape is not
 *  one the installer writes (fail closed), an EMPTY set when the file is simply absent — an
 *  instance with no add-ons has no mcp-addons.json, and one whose installs were hand-authored
 *  (the MPA layout) has no installed.json. */
function idsFromRecord(file, read, kind) {
  let raw;
  try { raw = read(file); } catch (e) { return e && e.code === "ENOENT" ? new Set() : null; }
  let parsed;
  try { parsed = JSON.parse(raw); } catch { return null; }
  if (Array.isArray(parsed)) {
    // mcp-addons.json is an id-keyed object; an array there is not a shape a writer makes.
    if (kind !== "installed") return null;
    const out = new Set();
    for (const e of parsed) {
      const id = typeof e === "string" ? e : (e && typeof e.id === "string" ? e.id : null);
      if (id) out.add(id);
    }
    return out;
  }
  if (parsed && typeof parsed === "object") return new Set(Object.keys(parsed));
  return null;
}

/**
 * The bundle ids installed on this instance: the UNION of the two installer records, both
 * under <crowHome> (a contained bot can write neither). An add-on can be registered in
 * `<crowHome>/mcp-addons.json` — its bundle dir on disk, its MCP block in that file —
 * without ever appearing in `<crowHome>/installed.json`, and it is installed all the same:
 * that is exactly what servers/gateway/routes/bundles.js dependencyInstalledIds rules for
 * `requires.bundles`, and what decides here whether an add-on's own `<data>/<id>` folder
 * (its uv venv and cache) may be bound.
 *
 * Read FAIL-CLOSED: a file that is unreadable, not JSON or of an unexpected shape yields
 * `null`, and a caller then binds nothing out of the data dir rather than guessing. Both
 * shapes installed.json is written in are accepted — an array of records (strings or `{id}`)
 * and an id-keyed object (servers/gateway/bundle-core.js readInstalled).
 * @returns {Set<string>|null}  null: an installer record cannot be read (fail closed)
 */
export function installedBundleIds(crowHome, read = (p) => readFileSync(p, "utf8")) {
  if (typeof crowHome !== "string" || !crowHome) return null;
  const installed = idsFromRecord(join(crowHome, "installed.json"), read, "installed");
  if (!installed) return null;
  const addons = idsFromRecord(join(crowHome, "mcp-addons.json"), read, "addons");
  if (!addons) return null;
  return new Set([...installed, ...addons]);
}

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
  return [join(home, ".ssh"), join(home, ".gnupg"), join(home, ".claude"), join(home, ".config", "gcloud"),
    join(home, ".config", "systemd"),
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

  /**
   * Bind `p` at its resolved path, or record the refusal in `refused`.
   * @returns {"bound"|"missing"|"refused"|"skipped"} what happened to `p`. `missing` (the path is
   *   not there at all) is the one a caller that NAMES a configured-but-absent writable path needs
   *   (buildContainPlan's droppedWrites): a structured answer from the bind itself, so no caller
   *   has to parse the refusal sentence to tell an absent path from a refused one.
   */
  function add(map, p, { write = false, label = "", policy = false } = {}) {
    if (!p) return "skipped";
    const r = real(p, exists, home);
    if (!r) { refused.push({ path: p, reason: "does not exist" + (label ? " (" + label + ")" : "") }); return "missing"; }
    const why = forbidden(r, { write, policy });
    if (why) { refused.push({ path: p, reason: why }); return "refused"; }
    map.set(r, r);
    return "bound";
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

/** Record one mask for `p` in a mask list: an empty mount over a directory (make
 *  it read-only with assembleBindArgs' `readonlyDirMasks`), /dev/null over a file.
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
 * Record the mask for a data-dir entry that does NOT exist yet, so a bot cannot CREATE it.
 *
 * The data dir root has to stay read-write (SQLite creates -wal/-shm/-journal beside its
 * DB), so `--tmpfs <missing>` is the only way to take a name out of the bot's reach — and
 * bwrap mounts ON a mount point, which therefore has to EXIST before exec. `--tmpfs` on a
 * path whose host directory is missing is not a mask this plan can rely on: the empty mount
 * has to land on a directory that is already there, and the one bwrap ends up using is not
 * one this code made or checked — bwrap creates a missing mount point itself, and because
 * the parent is a bind of the real data dir it creates it 0755 on the HOST. A mount point
 * nobody verified is a name a bot may have got to first, and a spawn that ran without it ran
 * with the name reachable (a real sandbox showed exactly that: `mkdir <data>/<id>/.venv`
 * answering ENOENT for a parent that was not there). So the plan only NAMES it
 * (mountPoints) and the spawner creates it: an empty 0700 dir of this uid, the shape the
 * gateway's own boot repair makes for the same folder (`mkdirSync(dir, { mode: 0o700 })` in
 * routes/bundles.js) — see ensureContainMountPoints(), which the spawn path calls right
 * before exec and which refuses the spawn when it cannot.
 *
 * The plan itself creates nothing: a plan is built on the spawner's side and may also be
 * built by a status surface or a test, and "did the mount point get made, and was it a
 * plain directory?" is a question only the spawn can answer.
 *
 * Always a directory mask: the name is a folder by nature (a reserved directory or a bundle
 * id). If something already sits there the caller's own stat-based mask covers it.
 */
export function maskAbsentEntry(masks, mountPoints, p) {
  mountPoints.push(p);
  masks.push([p, "dir"]);
}

/**
 * Make the empty mount points a contained spawn needs, immediately before exec.
 *
 * Each path is the destination of an empty READ-ONLY mask over a data-dir name that did not
 * exist when the plan was built (a reserved name, or an installed bundle id with no folder
 * yet). bwrap has to mount ON them, so they must exist first — and they must be exactly
 * what this creates and nothing else:
 *   - missing → `mkdir(0700)` (mkdir(2) never follows a final symlink: a link there fails
 *     EEXIST), then `chmod 0700` (a mkdir mode is umask's to narrow, the shape is not), then
 *     lstat again and require a real directory;
 *   - an existing DIRECTORY is kept as it is (the installer's own folder, or a folder an
 *     earlier spawn made) — that is the folder the mask is for — but it must be THIS
 *     spawner's uid, exactly like a freshly made one: a folder another uid owns is not this
 *     spawner's to mount over (it could be emptied or replaced under the mask);
 *   - a SYMLINK or anything that is not a directory REFUSES the spawn: mounting the empty
 *     mask over a link, or over a file, is not the containment that was planned, and a
 *     spawn that carried on would leave the name — or what a bot pointed it at — reachable;
 *   - a creation that fails REFUSES the spawn, naming the errno. Never "carry on and let
 *     bwrap decide": that is how an absent entry stayed unmasked.
 * Nothing is ever created as a FILE (RESERVED_DATA_FILES explains why), and nothing is
 * written inside a mount point.
 * @returns {string[]} the dirs this call created
 * @throws ContainRefused when a mount point exists as something else, belongs to another
 *         uid, or cannot be made
 */
export function ensureContainMountPoints(paths, { uid = process.getuid() } = {}) {
  const made = [];
  for (const p of Array.isArray(paths) ? paths : []) {
    if (typeof p !== "string" || !isAbsolute(p)) continue;
    const before = lstatOrNull(p);
    if (before) {
      if (before.isSymbolicLink()) {
        throw new ContainRefused("contain refused: " + p + " is a symlink, and a masked data-dir entry has to be a plain " +
          "directory; the empty read-only mount would land on whatever the link names");
      }
      if (!before.isDirectory()) {
        throw new ContainRefused("contain refused: " + p + " exists and is not a directory, so the empty read-only " +
          "mask of a trusted data-dir name cannot be mounted over it");
      }
      // An existing folder is refused for another uid exactly like a fresh one: the mount
      // lands on THIS folder, and a uid that owns it can empty or replace what is under the
      // mask after the check.
      if (before.uid !== uid) throw notThisUid(p, before.uid, uid);
      continue;
    }
    let err = null;
    try { mkdirSync(p, { mode: 0o700 }); } catch (e) { err = e; }
    if (!err) { try { chmodSync(p, 0o700); } catch (e) { err = e; } } // a mkdir mode is umask's to narrow; the shape is not
    const after = lstatOrNull(p);
    // A peer may have made it in the same instant: what matters is the shape now.
    if (!after || after.isSymbolicLink() || !after.isDirectory()) {
      throw new ContainRefused("contain refused: the mount point " + p + " of an empty read-only mask " +
        (err ? "cannot be created (" + ((err && err.code) || err.message || "error") + ")" : "is not a directory") +
        "; without it the name would be reachable inside the sandbox");
    }
    if (after.uid !== uid) throw notThisUid(p, after.uid, uid);
    made.push(p);
  }
  return made;
}

/**
 * The bot's OWN pre-project world root for one contained spawn: `<crowHome>/pi-bots/<bot id>`.
 *
 * That folder is the ONE hidden home entry a policy may reach (see the module header):
 * self-authoring stages skill proposals below it and the Bot Builder's review UI scans exactly
 * that path, so the contain plan binds it writable and the spawner creates it when it is missing.
 *
 * The id is the one the SPAWNER was given (`opts.botId`, taken from the bot's own `pi_bot_defs`
 * row), NEVER one a def names: a def is bot-writable — `crow.db`, which holds the defs, is bound
 * read-write into every contained bot — so a def carrying a `session_dir` (or a `bot_id`) for
 * another bot must never make this spawner create, or widen to, that bot's folder. The id is also
 * validated against the engine's bot-id charset (BOT_ID_RE, the same rule botWorkspaceEnv
 * applies) BEFORE it is joined into a path, so an id carrying a separator or a dot name can never
 * name a folder of its choosing.
 * @param {{crowHome?: string, botId?: string|null}} a
 * @returns {string|null} the folder (not resolved: the home is often a symlink, and
 *   ensureContainOwnWorldRoot resolves the tree), or null when there is no Crow home or the id is
 *   not a bot id (no derived folder at all).
 */
export function containOwnWorldRoot({ crowHome, botId } = {}) {
  if (typeof crowHome !== "string" || !crowHome) return null;
  if (typeof botId !== "string" || !BOT_ID_RE.test(botId)) return null;
  return join(crowHome, "pi-bots", botId);
}

/**
 * Make a contained bot's OWN pre-project world root before the plan is built, when it is missing.
 *
 * <crowHome>/pi-bots/<id> is the ONE hidden home entry a policy may reach (see the module header):
 * self-authoring stages skill proposals below it and the Bot Builder's review UI scans exactly
 * that path. The plan can only bind a path that EXISTS (`add()` drops a missing one), and the
 * sandbox's $HOME is an empty tmpfs — so a bot whose folder had never been created wrote
 * `contain-smoke.txt` into scratch and the write vanished with the spawn (travel-agent,
 * 2026-11-19), while the same write creates the folder on the host in the loose tier. So the
 * SPAWNER makes it, immediately before the plan is built.
 *
 * Only the bot's own root, and only when it resolves strictly inside THIS instance's
 * <crowHome>/pi-bots: never pi-bots itself, never a path with a `..` in it, never another folder,
 * never a path outside (a write_path the operator configured elsewhere keeps today's behaviour:
 * dropped, and the plan reports it), and never through a symlink — each existing component is
 * lstat-checked and mkdir(2) never follows a final link. The HOME itself (or an ancestor of it)
 * MAY be a symlink: the target is resolved through its nearest existing ancestor's realpath, so a
 * linked CROW_HOME/~/.crow still names the folder this instance's pi-bots really lives in, and
 * the missing tail is appended to that REAL root. Created 0700 and chmod'ed to 0700 (a mkdir mode
 * is umask's to narrow; every folder this spawner makes for a sandbox has that shape), owned by
 * this uid because it is made as this uid. An EXISTING root is left exactly as it is: the plan
 * binds it at its real path (and refuses it when it is a link out of pi-bots). A creation that
 * fails is logged and left to the plan's own refusal list — never a silent success, never a spawn
 * refusal the operator did not ask for.
 * @returns {string|null} the folder this call created, or null (nothing to create, not a bot's
 *          own root, or it could not be made)
 */
export function ensureContainOwnWorldRoot(botStateDir, { crowHome, uid = process.getuid() } = {}) {
  if (typeof botStateDir !== "string" || !botStateDir || !isAbsolute(botStateDir)) return null;
  if (typeof crowHome !== "string" || !crowHome) return null;
  // A `..` component is never a bot's own root: the path has to be SPELLED OUT, not walked through
  // (a resolved `..` would also hide which folder the caller really meant).
  if (botStateDir.split(sep).includes("..")) {
    console.error("[pi-contain] the bot's world root " + botStateDir + " was not created: a `..` in the path");
    return null;
  }
  // The home may itself be a symlink (a home linked onto a data disk), so both spellings are kept:
  // the lexical one to read the caller's tail below pi-bots from, and the REAL one (its nearest
  // existing ancestor resolved, the missing tail appended) as the tree everything is made in and
  // checked against.
  const homeLex = resolve(String(crowHome));
  const homeReal = realpathish(homeLex);
  const botsRootLex = join(homeLex, "pi-bots");
  const botsRoot = join(homeReal, "pi-bots");
  const target = resolve(botStateDir);
  const tail = tailBelow(botsRootLex, target) || tailBelow(botsRoot, target);
  // Strictly INSIDE this instance's pi-bots, at both spellings: the root itself is never created,
  // and nothing outside (or an ancestor of) the tree is ever a candidate.
  if (!tail) return null;
  const candidate = join(botsRoot, ...tail);
  if (candidate === botsRoot || !under(candidate, botsRoot)) return null;
  // What the caller's path really resolves to must be inside this instance's pi-bots too: a link
  // planted on the way out names a folder this spawner does not own.
  if (!under(realpathish(target), botsRoot)) {
    console.error("[pi-contain] the bot's world root " + target + " was not created: it resolves outside " + botsRoot);
    return null;
  }
  // An existing root is the plan's business: bind it, or refuse it when it is a link out.
  if (lstatOrNull(candidate)) return null;
  // pi-bots itself: created here when this instance never had one (the loose tier creates it
  // the same way, through the world root's mkdir), but never followed (a symlinked pi-bots is
  // not this instance's own tree, so nothing is created through it).
  const rootAt = lstatOrNull(botsRoot);
  if (!rootAt) {
    let err = null;
    try { mkdirSync(botsRoot, { mode: 0o700 }); } catch (e) { err = e; }
    if (!err) { try { chmodSync(botsRoot, 0o700); } catch (e) { err = e; } }
    if (err) {
      console.error("[pi-contain] the bot's world root " + target + " was not created: " + ((err && err.code) || "error") +
        " (pi-bots could not be made)");
      return null;
    }
  }
  const rootNow = lstatOrNull(botsRoot);
  if (!rootNow || rootNow.isSymbolicLink() || !rootNow.isDirectory()) {
    if (rootNow) console.error("[pi-contain] the bot's world root " + target + " is not created: " + botsRoot + " is not a plain directory");
    return null;
  }
  // One component at a time, refusing every link: a symlink planted anywhere on the way is a
  // folder this spawner does not own, so nothing is created through (or into) it.
  let made = null;
  let cur = botsRoot;
  for (const part of tail) {
    if (!part || part === "." || part === "..") return null;
    cur = join(cur, part);
    const at = lstatOrNull(cur);
    if (at) {
      if (at.isSymbolicLink() || !at.isDirectory()) {
        console.error("[pi-contain] the bot's world root " + target + " was not created: " + cur + " is " +
          (at.isSymbolicLink() ? "a symlink" : "not a directory"));
        return null;
      }
      continue;
    }
    let err = null;
    try { mkdirSync(cur, { mode: 0o700 }); } catch (e) { err = e; }
    if (!err) { try { chmodSync(cur, 0o700); } catch (e) { err = e; } } // a mkdir mode is umask's to narrow; the shape is not
    const after = lstatOrNull(cur);
    if (!after || after.isSymbolicLink() || !after.isDirectory()) {
      console.error("[pi-contain] the bot's world root " + cur + " was not created: " +
        (err ? ((err && err.code) || "error") : "not a directory"));
      return null;
    }
    if (after.uid !== uid) {
      console.error("[pi-contain] the bot's world root " + cur + " belongs to uid " + after.uid + ", not " + uid + "; not used");
      return null;
    }
    made = cur;
  }
  // Nothing was missing after all (a peer made it in the same instant): nothing was created.
  if (!made) return null;
  // Final proof: the folder really resolves to the path this call meant, still strictly inside
  // this instance's pi-bots — the same rule the plan applies to `botStateDir`.
  let realTarget = null;
  try { realTarget = realpathSync(candidate); } catch { realTarget = null; }
  if (!realTarget || realTarget !== candidate || realTarget === botsRoot || !under(realTarget, botsRoot)) {
    console.error("[pi-contain] the bot's world root " + candidate + " did not resolve to itself inside " + botsRoot + "; not bound");
    return null;
  }
  console.error("[pi-contain] created the bot's own world root " + realTarget + " (0700): writes there land on the host");
  return realTarget;
}

/** The one refusal for a mount point another uid owns (existing or freshly made). */
function notThisUid(p, got, want) {
  return new ContainRefused("contain refused: the mount point " + p + " of an empty read-only mask belongs to uid " +
    got + ", not " + want + "; it is not this spawner's to mount over");
}

/** lstat, or null when the path does not exist (never throws, never follows a link). */
function lstatOrNull(p) {
  try { return lstatSync(p); } catch { return null; }
}

/**
 * `p` with its nearest EXISTING ancestor resolved through realpath(3) and the missing tail
 * appended: the form a path that does not exist yet will really have once it is made. A symlinked
 * home (or a symlinked ancestor of it) is therefore resolved even when the leaf is missing, and
 * nothing that is not there is followed (a dangling link is left in the tail for the caller's own
 * lstat walk to refuse).
 */
function realpathish(p) {
  const abs = resolve(String(p));
  const tail = [];
  for (let cur = abs; ;) {
    try { return tail.length ? join(realpathSync(cur), ...tail) : realpathSync(cur); } catch { /* not there */ }
    const up = dirname(cur);
    if (up === cur) return abs;
    tail.unshift(basename(cur));
    cur = up;
  }
}

/** The components of `p` below `base`, or null when `p` is not strictly inside it. */
function tailBelow(base, p) {
  if (!under(p, base) || p === base) return null;
  return p.slice(base.length + 1).split(sep);
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
 *
 * `readonlyDirMasks` makes every directory mask a READ-ONLY EMPTY mount: the
 * tmpfs itself, then a `--remount-ro` of it. A writable tmpfs over another
 * project's files is a scratch pad — a bot's write "succeeds" there and is
 * discarded with the spawn — so the bot plans take the read-only shape and a
 * write fails (EROFS) instead. The remount ops go LAST, after every other
 * mount: a read-only bind of a file inside a mask (an MCP server's token under
 * a masked bundle folder) needs its mount point created while the tmpfs is
 * still writable. They are emitted in PATH order, not in the order the masks
 * were recorded: a data-dir mask set is a mix of entries that were present at
 * spawn (readdir order, a filesystem's business) and absent names the plan
 * named, and an argv a host's readdir order decides is not a stable argv.
 * Off by default: the add-on wall's own plan shares this
 * builder and its data folders are the add-on's to write.
 */
export function assembleBindArgs({ ro, rw, masks, extraEntries = [], readonlyDirMasks = false } = {}) {
  const binds = [...[...ro.keys()].map((p) => ["--ro-bind", p]), ...[...rw.keys()].map((p) => ["--bind", p])]
    .sort((a, b) => (a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0));
  const distinct = new Map(masks.map(([d, k]) => [d, k]));
  const maskOps = [...distinct.entries()]
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
  if (readonlyDirMasks) {
    const dirs = [...distinct].filter(([, k]) => k === "dir").map(([d]) => d).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    for (const d of dirs) args.push("--remount-ro", d);
  }
  return args;
}

/**
 * Build the bwrap argv (everything before "--") for one contained pi spawn.
 * Pure apart from realpath/stat/readdir: it creates NOTHING. A data-dir entry that is
 * masked because it is trusted but absent (a reserved name, or an installed bundle id with
 * no folder yet) is named in the reply's `mountPoints`, and the SPAWNER makes those empty
 * 0700 dirs just before exec (ensureContainMountPoints), refusing the spawn when one cannot
 * be made — a mask whose mount point does not exist protects nothing. Nothing is ever
 * written into a mount point and no file is ever created.
 *
 * `otherHomes` is the co-hosted Crow homes the spawner already found (its
 * instance-secrets scan's homes, including declared ones, each RESOLVED with
 * realpath). They are refused as bind sources by resolved path, so a symlinked
 * home or one declared outside $HOME is covered as well as a `$HOME/.crow-*`
 * sibling.
 *
 * `botStateDir` is the bot's OWN pre-project world root (<crowHome>/pi-bots/<the spawner's bot
 * id>, containOwnWorldRoot — never a path a def names). It is the only path under a hidden home
 * entry a policy write path may reach: the legacy self-authoring staging dir lives there and the
 * Bot Builder's review UI scans it, so it is bound writable instead of being dropped. Optional:
 * without it the hidden-entry rule applies unchanged.
 * @returns {{args: string[], env: object, refused: {path, reason}[], net: object|null, mountPoints: string[], droppedWrites: string[]}}
 *   `mountPoints` are the directories that must exist (empty, plain, 0700) before this argv
 *   runs: the destinations of the empty read-only masks over trusted-but-absent data-dir
 *   names. ensureContainMountPoints() is the only thing that may make them.
 *   `droppedWrites` names every CONFIGURED writable path (session dir, cwd, workspace,
 *   write_paths) that was dropped because it does not exist and no writable bind covers it:
 *   a write there would "succeed" into the sandbox's tmpfs and be lost, so the containment
 *   status names it (the spawner passes it to botContainment).
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
  const mountPoints = []; // dirs the spawner must make before exec (absent-entry masks)
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
  const homeRealNow = real(home, exists);
  const dataRealNow = o.dataDir ? real(o.dataDir, exists) : null;
  const commandEntries = []; // [flag, src, dest]: a symlinked launcher's LEXICAL path
  const mcpEnvFiles = [];     // absolute files a server names in its env, bound after the rw binds
  /** Is `p` already reachable through a read-only bind (that file, or a bound dir above it)? */
  const roCovers = (p) => ro.has(p) || [...ro.keys()].some((d) => {
    try { return statSync(d).isDirectory() && under(p, d); } catch { return false; }
  });
  /**
   * The operator's own PATH folders. A binary an add-on entry points at HERE is not beyond
   * a bot's reach in principle (it is a plain folder in the home), and `~/bin` is on PATH for
   * every shell, so binding "whatever file a block names there" would mount an operator tool
   * — or a file planted at that name — into the sandbox as a trusted command. Two things may
   * still come out of them:
   *   - the block's own PINNED launcher: the spawner resolved it and carried its
   *     `command_sha256` (`servers/shared/resolve-command.js`; pi-lab re-hashes it right
   *     before the spawn), so the exact bytes are the ones the entry's install consented to;
   *   - a uv/uvx LAUNCHER, the shape the installer itself puts in `~/.local/bin` — the one
   *     command a uv block cannot work without (tests/pi-contain-plan.test.js B2).
   * Everything else there is refused with the reason, never silently dropped.
   */
  const PATH_DIRS = [...new Set([
    join(home, "bin"), join(home, ".local", "bin"),
    ...[join(home, "bin"), join(home, ".local", "bin")].map((d) => real(d, exists)).filter(Boolean),
  ])];
  const pathDirOf = (p) => PATH_DIRS.find((d) => typeof p === "string" && under(p, d)) || null;
  const inPathDir = (p) => pathDirOf(p) !== null;
  const UV_LAUNCHER_NAMES = new Set(["uv", "uvx"]);
  const commandRefusalInPathDir = (s, lexical, resolved) => {
    const dir = pathDirOf(lexical) || pathDirOf(resolved);
    if (!dir) return null;
    if (UV_LAUNCHER_NAMES.has(basename(String(lexical))) || UV_LAUNCHER_NAMES.has(basename(String(resolved)))) return null;
    const pin = typeof s.command_sha256 === "string" && /^[0-9a-f]{64}$/i.test(s.command_sha256) ? s.command_sha256 : null;
    if (pin) return null;
    return "a command in the operator's own PATH folder (" + dir + ") is bound only when it is the block's pinned launcher (command_sha256) or a uv/uvx launcher";
  };
  /** Bind a directory read-only unless a bind already covers it. */
  const addRoDir = (dir, label) => {
    const r = real(dir, exists);
    if (!r) { refused.push({ path: String(dir), reason: "does not exist" + (label ? " (" + label + ")" : "") }); return false; }
    if (roCovers(r)) return true;
    add(ro, r, { label });
    return ro.has(r);
  };
  /**
   * Run one bind attempt WITHOUT recording its refusal: `[]` when it bound,
   * or the refusals it would have logged. A command has two candidate shapes
   * (an install root, else the executable file); only the last one failing is
   * worth a line, so a fallback that succeeds must not leave the first
   * candidate's refusal behind.
   */
  const quietly = (fn) => {
    const before = refused.length;
    fn();
    return refused.length > before ? refused.splice(before) : [];
  };
  /** The installed bundle ids, read once per plan from BOTH installer records
   *  (<crowHome>/installed.json and <crowHome>/mcp-addons.json): `null` when either
   *  cannot be read (fail closed — then no bundle's data folder is bound, and none is
   *  masked). */
  let installedIds = undefined; // undefined: not read yet; null: unreadable
  const installed = () => {
    if (installedIds === undefined) installedIds = crowHomeReal ? installedBundleIds(crowHomeReal) : null;
    return installedIds;
  };
  /**
   *  The bundle a server block belongs to: the id of the folder under THIS
   * instance's <crowHome>/bundles that the block's cwd — or, failing that, its
   * absolute command — resolves into (a command nested deeper than the bundle
   * root still names it). The first path segment is only a CANDIDATE: it must
   * pass the installer's bundle-id rule, must not be a reserved data-dir entry
   * (`<crowHome>/bundles/projects` is this instance's project folder, not a
   * bundle; `<data>/projects/<someone else's project>` must never be reachable
   * through the id "projects"), and the id must be INSTALLED here — recorded in
   * `<crowHome>/installed.json` OR registered in `<crowHome>/mcp-addons.json`
   * (installedBundleIds unions both, fail-closed). When no candidate qualifies
   * the block belongs to no installed bundle and gets nothing out of the data dir.
   * @returns {{id: string|null, reason: string|null}} `reason` says why no id
   */
  const bundleIdFor = (s) => {
    if (!crowHomeReal) return { id: null, reason: "there is no Crow home, so no bundle id" };
    const bundlesRoot = join(crowHomeReal, "bundles");
    let why = null;
    for (const raw of [s.cwd, s.command]) {
      if (typeof raw !== "string" || !isAbsolute(raw)) continue;
      const r = real(raw, exists);
      if (!r || r === bundlesRoot || !under(r, bundlesRoot)) continue;
      const id = r.slice(bundlesRoot.length + 1).split(sep)[0];
      if (!BUNDLE_ID_RE.test(id)) {
        why = why || JSON.stringify(id) + " is not a bundle id (the installer's rule: lowercase letters, digits and hyphens, at most 64) under <crowHome>/bundles";
        continue;
      }
      if (isReservedDataEntry(id)) {
        why = why || JSON.stringify(id) + " is a reserved data-dir entry, never a bundle id";
        continue;
      }
      const ids = installed();
      if (!ids) {
        why = why || "the bundle ids installed here cannot be read (<crowHome>/installed.json, <crowHome>/mcp-addons.json)";
        continue;
      }
      if (!ids.has(id)) {
        why = why || "bundle " + JSON.stringify(id) + " is not installed here (absent from <crowHome>/installed.json and <crowHome>/mcp-addons.json)";
        continue;
      }
      return { id, reason: null };
    }
    return { id: null, reason: why || "no derivable bundle id (<crowHome>/bundles/<id> from its cwd or command)" };
  };
  /**
   * A directory a uv block names (its venv, its cache): read-only, and only by
   * ALLOWLIST out of the block's OWN bundle folder in the instance's data dir.
   * The data dir itself is a read-write bind, but every entry in it is masked,
   * and the bind of a descendant sorts after the mask on its parent — so the
   * venv is reachable again at its own path without exposing the rest of the
   * folder.
   *
   * The mask is what makes the allowlist load-bearing: a server block's env is
   * not a trusted path list. Only `<data>/<the block's own bundle id>/.venv`
   * (matched by REALPATH, so a symlinked venv that resolves anywhere else is
   * refused) and the fixed cache path `<data>/<its bundle id>/.cache/uv` are
   * bound — nothing else under the bundle's folder. A peer bundle's venv, a
   * `.venv` planted in `<data>/projects/…`, a cache in a shared data folder or
   * anywhere else in the bundle's folder, a block with no qualifying bundle id —
   * all logged with the reason and never bound; nothing outside the data dir is
   * considered.
   */
  const addUvDataEntry = (dir, label, { bundleId = null, venv = false, why = null } = {}) => {
    if (typeof dir !== "string" || !isAbsolute(dir)) return;
    const r = real(dir, exists);
    if (!r) return; // absent: uv would create it inside the sandbox's own tmpfs
    try { if (!statSync(r).isDirectory()) return; } catch { return; }
    const kind = venv ? "venv" : "cache";
    if (!dataRealNow || !bundleId) {
      refused.push({ path: String(dir), reason: "a uv " + kind + " named by a block with no derivable bundle id is never bound (" + (why || "<crowHome>/bundles/<id> from its cwd or command") + ")" });
      return;
    }
    const own = join(dataRealNow, bundleId);
    if (venv) {
      if (r !== join(own, ".venv")) {
        refused.push({ path: String(dir), reason: "a uv venv is bound only at the block's OWN <data>/" + bundleId + "/.venv (that exact resolved path); not bound" });
        return;
      }
    } else if (r !== join(own, ".cache", "uv")) {
      // One cache path, the installer's: <data>/<id>/.cache/uv. A block's env
      // names paths and a bundle's folder holds its STATE, not just its cache,
      // so no other directory in there is re-exposed over the mask.
      refused.push({ path: String(dir), reason: "a uv cache is bound only at the block's OWN <data>/" + bundleId + "/.cache/uv (that exact resolved path); not bound" });
      return;
    }
    addRoDir(r, label);
  };
  /** A uv-launched block: `uv`/`uvx` as the command, or a venv named in its env. */
  const uvBlock = (s) => {
    const base = s.command ? basename(String(s.command)) : "";
    const named = s.env && typeof s.env.UV_PROJECT_ENVIRONMENT === "string" && !!s.env.UV_PROJECT_ENVIRONMENT;
    return base === "uv" || base === "uvx" || named;
  };
  for (const s of o.mcpServers || []) {
    if (s.cwd && real(s.cwd, exists) !== homeRealNow) add(ro, s.cwd, { label: "mcp cwd" });
    if (s.command && isAbsolute(s.command)) {
      const c = real(s.command, exists);
      if (c) {
        // Two shapes under the home: a normal install, whose root
        // (<root>/bin/<cmd>) is bound as a directory, and a launcher that lives
        // in a folder never bound wholesale (~/.local/bin/uv sits beside the
        // never-bound ~/.local/share/systemd, so its root is REFUSED). For the
        // second, bind exactly the executable FILE — never its parent folders —
        // and only when it IS one: a regular file with an execute bit, and not
        // a dotfile directly in $HOME (~/.npmrc is a setting, not a program). A
        // command under a never-bound path (~/.ssh) stays refused either way.
        // The install root's refusal is held back while the file is tried and
        // logged only when nothing ends up bound.
        const root = dirname(dirname(c)); // <root>/bin/<cmd>
        let bound = false;
        let held = [];
        // A folder inside ~/bin or ~/.local/bin is never bound wholesale: the PATH-folder
        // rule below decides what may come out of them, and it only ever yields a FILE.
        if (under(root, home) && !inPathDir(root) && !inPathDir(String(s.command))) held = quietly(() => { bound = addRoDir(root, "mcp command"); });
        if (!bound && under(c, home) && c !== homeRealNow) {
          const why = forbidden(c);
          // ~/bin and ~/.local/bin: only this block's pinned launcher or a uv/uvx launcher.
          const pathDirWhy = why ? null : commandRefusalInPathDir(s, String(s.command), c);
          let shape = null; // why the FILE cannot be a command, or null
          try {
            const st = statSync(c);
            shape = !st.isFile() ? "not a regular file"
              : (!(st.mode & 0o111) ? "not executable (mode " + (st.mode & 0o777).toString(8).padStart(4, "0") + ")" : null);
          } catch { shape = "not a regular file"; }
          if (dirname(c) === homeRealNow && basename(c).startsWith(".")) shape = "a dotfile directly in the home";
          if (why) held = [{ path: String(s.command), reason: why }];
          else if (pathDirWhy) held = [{ path: String(s.command), reason: pathDirWhy }];
          else if (roCovers(c)) bound = true; // an earlier bind (the server's cwd, a read path) already reaches it
          else if (shape) held = [{ path: String(s.command), reason: "an MCP command must be an executable regular file (" + shape + ")" }];
          else { held = quietly(() => add(ro, c, { label: "mcp command file" })); bound = !held.length; }
        }
        if (!bound) refused.push(...held);
        // pi execs the path it was GIVEN, so that lexical path must exist inside
        // too: a symlinked launcher (a common uv shape) is mounted at its own
        // path from the resolved file — "the executable file and its realpath
        // target", with no parent folder bound.
        const lexical = String(s.command);
        const reachable = roCovers(c) ? c : null;
        if (reachable && lexical !== c && !roCovers(lexical)) {
          commandEntries.push(["--ro-bind", reachable, lexical]);
        }
      }
    }
    for (const v of Object.values(s.env || {})) {
      const val = String(v || "");
      if (isAbsolute(val) && !val.includes("\n") && exists(val)) {
        try { if (statSync(val).isFile()) mcpEnvFiles.push(val); } catch {}
      }
    }
    // uv: the project venv (named by the block, else the bundle's known folder)
    // and a cache dir the block names — each only where the block's OWN bundle
    // allows it (addUvDataEntry). The add-on installer's own entries set
    // UV_NO_CACHE=1, so an unnamed cache writes nothing; a named one is bound
    // read-only, and the bot cache the spawn env points at stays writable for
    // pi's own npx/uv use.
    if (uvBlock(s)) {
      const envObj = s.env || {};
      const { id: bundleId, reason: noBundle } = bundleIdFor(s);
      // A relative UV_PROJECT_ENVIRONMENT is relative to the server's cwd, which
      // this plan does not resolve: the bundle's known folder is the fallback.
      const namedVenv = typeof envObj.UV_PROJECT_ENVIRONMENT === "string" && isAbsolute(envObj.UV_PROJECT_ENVIRONMENT)
        ? envObj.UV_PROJECT_ENVIRONMENT : null;
      const fallbackVenv = bundleId && dataRealNow ? join(dataRealNow, bundleId, ".venv") : null;
      addUvDataEntry(namedVenv || fallbackVenv, "uv venv", { bundleId, venv: true, why: noBundle });
      addUvDataEntry(envObj.UV_CACHE_DIR, "uv cache", { bundleId, why: noBundle });
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
      const present = new Set(entries);
      for (const e of entries) {
        const p = join(rd, e);
        // The instance's own state, by name (RESERVED_DATA_ENTRIES): the DB files
        // and their journals stay (SQLite writes beside them), a sharing bot keeps
        // identity.json, `projects` is re-exposed down to the bot's own workspace,
        // and every other reserved entry — peers, instance-sync, backups, pi-bots,
        // secrets, env, history, previews, … — is masked with the rest. Nothing
        // reserved is ever a bundle's data folder (isReservedDataEntry gates bundle
        // ids too).
        if (isReservedDataEntry(e)) {
          if (DB_FILE_RE.test(e) || keep.has(e)) continue;
          if (e === "projects" && wsReal && under(wsReal, p)) {
            let segs = [];
            try { segs = readdirSync(p); } catch {}
            for (const g of segs) { const q = join(p, g); if (!under(wsReal, q)) maskPath(q); }
            continue;
          }
          maskPath(p);
          continue;
        }
        if (keep.has(e)) continue;
        maskPath(p);
      }
      // The root stays READ-WRITE (see above), so masking only what is on disk leaves a
      // hole: a bot can CREATE the entry it wants and a host process later trusts it. The
      // one that matters is a bundle's own data folder — `<data>/<installed id>/.venv` is
      // code that add-on's uv runs OUTSIDE this sandbox. So every trusted name is masked
      // whether or not it is there:
      //   - every reserved name (the gateway's list plus this plan's own), as a directory;
      //   - every installed bundle id: the union of installed.json and mcp-addons.json, so
      //     an add-on registered only in mcp-addons.json keeps its venv bind AND cannot
      //     have a `.venv` / `.cache/uv` planted in a folder it has not made yet.
      // A FILE-shaped reserved entry (identity.json, instance-id) is only masked when it
      // is there: an empty one created here would break the gateway (RESERVED_DATA_FILES).
      // An unreadable installer record (installedBundleIds null) masks no id — fail closed
      // the other way: no id qualifies for a bind either (bundleIdFor).
      for (const name of RESERVED_DATA_ENTRIES) {
        if (present.has(name) || DB_FILE_RE.test(name) || RESERVED_DATA_FILES.includes(name)) continue;
        if (keep.has(name)) continue;
        maskAbsentEntry(masks, mountPoints, join(rd, name));
      }
      for (const id of installed() || []) {
        if (present.has(id) || keep.has(id)) continue;
        if (!BUNDLE_ID_RE.test(id) || isReservedDataEntry(id)) continue;
        maskAbsentEntry(masks, mountPoints, join(rd, id));
      }
    }
  }

  // bot cache
  if (o.botCacheDir) add(rw, o.botCacheDir, { write: true, label: "bot cache" });

  // bot paths
  // Every configured writable path whose absence is worth NAMING (a write there still
  // "succeeds" inside the sandbox — the empty $HOME is a tmpfs — and is lost with the spawn).
  // Recorded here, filtered at the end to the ones no writable bind really covers.
  const missingWrites = [];
  const addWrite = (p, label, opts = {}) => {
    // The bind itself says whether the path was ABSENT (a structured answer, never the refusal
    // sentence): only an absent configured path is a write that would be lost in the sandbox.
    if (add(rw, String(p), { write: true, label, ...opts }) === "missing") missingWrites.push(String(p));
  };
  for (const [p, label] of [[o.sessionDir, "session dir"], [o.cwd, "cwd"], [o.workspaceDir, "workspace"]]) {
    if (p) addWrite(p, label);
  }
  // The bot's OWN pre-project world root (<crowHome>/pi-bots/<id>): the legacy
  // self-authoring staging dir lives below it (def.session_dir/proposed-skills)
  // and the Bot Builder's review UI scans exactly that path. Mapping it into
  // the project world root instead would be a write-here/scan-there split, so
  // the folder is bound writable — and ONLY it: the root is honoured only when
  // it sits inside this instance's <crowHome>/pi-bots (never the whole pi-bots
  // tree, never the home itself), and the caller passes the SPAWNER's own id
  // (containOwnWorldRoot) rather than a path a def names — so it is never another
  // bot's folder either. Every other rule (never-bound paths, other homes, code,
  // the Crow home) still applies.
  // It must EXIST to be bound: the spawner makes it first when it is missing
  // (ensureContainOwnWorldRoot), and a root that is still missing is dropped and
  // reported (droppedWrites), never silently left writable-only-in-scratch.
  const botsRoot = crowHomeReal ? join(crowHomeReal, "pi-bots") : null;
  const botStateReal = o.botStateDir ? real(o.botStateDir, exists) : null;
  const ownStateRoot = botStateReal && botsRoot && under(botStateReal, botsRoot) && botStateReal !== botsRoot ? botStateReal : null;
  for (const p of o.writePaths || []) {
    // The operator's ruling: a policy write path that is the Crow home (or an ancestor
    // of it) refuses the SPAWN, with the reason named — the turn does not run
    // with the path silently dropped.
    const r = real(String(p), exists);
    if (r) for (const c of closedRw) {
      if (under(c, r)) throw new ContainRefused("contain refused: write_paths names " + r + ", which covers the Crow home (" + c + ") and is never writable under contain");
    }
    if (ownStateRoot && r && under(r, ownStateRoot)) {
      addWrite(p, "write_paths (the bot's own world)");
      continue;
    }
    addWrite(p, "write_paths", { policy: true });
  }
  for (const p of o.readPaths || []) add(ro, String(p), { label: "read_paths" });
  // read-only when also writable: writable wins
  for (const k of rw.keys()) ro.delete(k);

  // MCP env files, now that every writable bind is known. A file the plan
  // already binds WRITABLE — or that sits inside a writable bind with no mask
  // between the two (crow.db and tasks.db, the only data-dir entries kept
  // beside the bot's own project) — must NOT get a read-only bind on top: the
  // later ro-bind wins and the bot's own stdio MCP servers find their database
  // read-only ("attempt to write a readonly database"). Every OTHER data-dir
  // entry is masked, so a knowledge-base DB under a bundle's data folder
  // (<data>/knowledge-base-mcp/…) is masked with that folder and stays
  // writable only when the operator keeps the folder
  // (CROW_PI_CONTAIN_DATA_KEEP). A file under a never-bound path is refused
  // either way; a file inside a MASKED data entry (a bundle's token file) is
  // bound read-only at its own path, above the mask.
  const coveredByWritable = (p) => {
    for (const d of rw.keys()) {
      if (d !== p && !under(p, d)) continue;
      const hidden = masks.some(([m]) => m !== d && (m === p || under(p, m)));
      if (!hidden) return true;
    }
    return false;
  };
  for (const f of mcpEnvFiles) {
    const r = real(f, exists);
    if (r) {
      const why = forbidden(r);
      if (why) { refused.push({ path: f, reason: why }); continue; }
      if (coveredByWritable(r)) continue;
    }
    add(ro, f, { label: "mcp env file" });
  }

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
  const agentEntries = [...commandEntries];
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
  // readonlyDirMasks: a masked data folder is an empty READ-ONLY mount, so a
  // write into it FAILS loudly instead of being lost in scratch.
  args.push(...assembleBindArgs({ ro, rw, masks, extraEntries: agentEntries, readonlyDirMasks: true }));

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
  // A missing configured writable path is REPORTED (the containment status names it) unless a
  // writable bind already covers it: a missing child of a bound world root needs no bind of its
  // own, and calling that "dropped" would misdescribe a write that really lands on the host.
  const droppedWrites = [];
  for (const p of missingWrites) {
    if (droppedWrites.includes(p)) continue;
    const lexical = resolve(p);
    // The bind destinations are REAL paths; a missing path's own parent can still be
    // resolved, so compare both spellings before calling it uncovered.
    let realish = lexical;
    try { realish = join(realpathSync(dirname(lexical)), basename(lexical)); } catch { /* parent gone too */ }
    if ([...rw.keys()].some((d) => under(lexical, d) || under(realish, d))) continue;
    droppedWrites.push(p);
  }
  return { args, env, refused, net, mountPoints, droppedWrites };
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
