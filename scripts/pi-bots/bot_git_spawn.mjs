/**
 * Per-bot git access, PR B: the spawn-side decision, as two PURE functions.
 *
 * Nothing here opens a file, starts a process or reads the DB: bridge.mjs
 * gathers the facts (the key dir on disk, its meta.json, the pi_bot_defs row,
 * the enabled-pi-bot count, the key-dir check) and this module turns them into
 * "give this spawn git access, or the plain reason not to". Keeping the
 * decision pure means every rule below is testable without a spawn, and the
 * bridge has exactly one place where a git env var can appear.
 *
 * Two things are deliberate and load-bearing:
 *
 *  - The bot id comes from `opts.botId` ONLY — never the `def.bot_id || def.id`
 *    fallback the sandbox uses for containment. A bot can edit its own
 *    definition through its DB-touching tools, so a def that names another bot
 *    must never select that bot's key.
 *  - `remove` is applied whenever a key dir was chosen, even when `set` is
 *    null: a def's `spawn_env` may carry GIT_SSH_COMMAND or GIT_CONFIG_GLOBAL,
 *    and a bot that cannot have its OWN key must not keep a value it brought.
 *    That is `keyDir`, which is non-null for a bot that owns a usable key dir
 *    even when the sandbox cannot bind it (`gitDir` null, so nothing is set).
 *    With no key dir at all the env is untouched — every bot without git
 *    access spawns exactly as it did before this feature.
 *
 * The env shape is the pinned one from servers/shared/bot-git/ssh.js: no
 * inherited ssh config, no agent, no global known_hosts, host keys strict. Only
 * the pidns tier may have git (in the userns tier host /proc is visible, so a
 * same-uid bot could read another key dir through /proc/<pid>/root).
 *
 * The GIT_* scrub is HYGIENE, NOT A BOUNDARY. Removing GIT_ENV_KEYS (and
 * pinning GIT_SSH_COMMAND / GIT_CONFIG_GLOBAL) keeps a bot from pointing its
 * git at a config, an ssh binary or an askpass of its own choosing, but it
 * cannot be a boundary: a def's `spawn_env` may still set GIT_CONFIG_COUNT /
 * GIT_CONFIG_KEY_<n> / GIT_CONFIG_VALUE_<n>, GIT_CONFIG_PARAMETERS,
 * GIT_PROXY_COMMAND or GIT_ASKPASS, and none of those are stripped. That is
 * deliberate, and harmless: any of them runs INSIDE the bot's own sandbox, in a
 * git the bot itself started, with a key the bot can already read — the whole
 * point of the feature. What actually protects Crow is the mount (this bot's
 * own key dir bound read-only inside the secrets tmpfs, in its own PID
 * namespace), and the rule that the key dir fd never reaches a child that
 * cannot consume it (bridge.mjs GIT_KEYDIR_FD).
 */
import { basename } from "node:path";
import { isSafeKeyPath, isValidGitBotId } from "../../servers/shared/bot-git/paths.js";
import { gitSshCommand } from "../../servers/shared/bot-git/ssh.js";

/** File names inside a bot's key dir (store.js writes them). */
const KEY = "id_ed25519";
const KNOWN_HOSTS = "known_hosts";
const GITCONFIG = "gitconfig";

/**
 * The env keys a spawn with a key dir never inherits: its own values are set
 * afterwards, and a def's `spawn_env` must not survive in the meantime.
 */
export const GIT_ENV_KEYS = Object.freeze(["GIT_SSH", "GIT_SSH_COMMAND", "GIT_SSH_VARIANT", "GIT_CONFIG_GLOBAL"]);

/**
 * The number of ENABLED pi bots on this instance — the same filter the
 * containment status uses (bot-runtime.js containmentBots): `enabled = 1`, and
 * a definition whose `engine` is absent/null or "pi". A def that will not
 * parse counts as a pi bot (the same as there).
 *
 * @param {Array<{enabled?: any, definition?: string|null}>} rows pi_bot_defs rows
 * @returns {number}
 */
export function countEnabledPiBots(rows) {
  if (!Array.isArray(rows)) return 0;
  let n = 0;
  for (const row of rows) {
    if (!row || Number(row.enabled) !== 1) continue;
    let def = {};
    try { def = JSON.parse(row.definition || "{}") || {}; } catch { def = {}; }
    if (def.engine != null && def.engine !== "pi") continue;
    n++;
  }
  return n;
}

/**
 * Whether this spawn gets git access, and the path of the key dir to expose.
 *
 * `candidate` is the key dir the bridge found under the anchored secrets dir;
 * every flag is a fact the caller established. `gitDir` is non-null only when
 * ALL of them hold — the sandbox probe included — and `reason` names the first
 * that did not.
 *
 * The probe is the sandbox's own answer (`probePiSandbox()`): `ok` and `pidns`
 * say this host can build the PID-namespace tier, `bindFd` that its bubblewrap
 * knows `--ro-bind-fd`. Without all three the key dir cannot be bound back
 * inside the secrets tmpfs, so no fd is opened for it at all (defence in
 * depth: even a launch that silently drops the expose entry never has a live
 * descriptor to leak). `keyDir` still names the dir, so the env strip is
 * unaffected — a bot that OWNS a key never keeps a GIT_* value it brought.
 *
 * @param {{candidate?: string|null, containedSpawn?: boolean, optsBotId?: string,
 *   noGit?: boolean, gitDirExists?: boolean, metaCreatedAt?: string|null,
 *   rowCreatedAt?: string|null, keyDirCheck?: {ok: boolean, reason?: string}|null,
 *   safePath?: boolean, instanceAllowed?: boolean,
 *   probe?: {ok?: boolean, pidns?: boolean, bindFd?: boolean}|null}} facts
 * @returns {{gitDir: string|null, keyDir: string|null, reason: string|null}}
 *   `gitDir` — the key dir this spawn may really bind read-only inside its own
 *   PID namespace (the only dir an fd is opened for).
 *   `keyDir` — the key dir this bot owns, when every fact other than the
 *   sandbox probe held; gitPostLaunch keys its env strip on it.
 */
export function gitPreSpawn({
  candidate = null,
  containedSpawn = false,
  optsBotId,
  noGit = false,
  gitDirExists = false,
  metaCreatedAt = null,
  rowCreatedAt = null,
  keyDirCheck = null,
  safePath = false,
  instanceAllowed = false,
  probe = null,
} = {}) {
  if (noGit === true) return { gitDir: null, keyDir: null, reason: "git access is off for this spawn" };
  // Review item 3: opts.botId only. A definition is bot-writable.
  if (!isValidGitBotId(optsBotId)) return { gitDir: null, keyDir: null, reason: "this spawn has no bot id to give git access to" };
  if (containedSpawn) return { gitDir: null, keyDir: null, reason: "the contain tier has no git access in this version" };
  if (instanceAllowed !== true) {
    return { gitDir: null, keyDir: null, reason: "git access needs this to be the only enabled bot on this instance" };
  }
  if (gitDirExists !== true) return { gitDir: null, keyDir: null, reason: "this bot has no git key" };
  if (typeof candidate !== "string" || !candidate) return { gitDir: null, keyDir: null, reason: "this bot has no git key dir" };
  // The dir must be named after THIS bot: the bridge builds it from opts.botId,
  // and this is the check that the two never drift apart.
  if (basename(candidate) !== optsBotId) return { gitDir: null, keyDir: null, reason: "the key dir belongs to another bot" };
  // Housekeeping, not a security boundary: created_at has 1-second resolution
  // and crow.db is bot-writable in the default tier. It lets a recreated bot
  // with a recycled id start clean instead of inheriting the old key.
  if (typeof metaCreatedAt !== "string" || !metaCreatedAt || metaCreatedAt !== rowCreatedAt) {
    return { gitDir: null, keyDir: null, reason: "the key dir was created for another bot row (created_at does not match)" };
  }
  if (!keyDirCheck || keyDirCheck.ok !== true) {
    return { gitDir: null, keyDir: null, reason: "the key dir is not usable" + (keyDirCheck && keyDirCheck.reason ? ": " + keyDirCheck.reason : "") };
  }
  if (safePath !== true) return { gitDir: null, keyDir: null, reason: "the key dir path cannot be used in a git command" };
  // Defence in depth (review item 1b): the fd is only ever opened for a dir
  // this host can really bind back. No pidns tier, or an old bwrap without
  // --ro-bind-fd, means no mount -- and an fd that no argv consumes would be a
  // descriptor sitting in the child's table. The key dir is still named in
  // `keyDir`: the bot owns it, so its GIT_* env is still stripped.
  if (!probe || probe.ok !== true || probe.pidns !== true || probe.bindFd !== true) {
    return { gitDir: null, keyDir: candidate, reason: "sandbox cannot bind the key dir" };
  }
  return { gitDir: candidate, keyDir: candidate, reason: null };
}

/**
 * The env changes for a spawn that was given a key dir, and the plain reason
 * git is off when the launch came out weaker than the decision above expected.
 *
 * `remove` is ALWAYS applied when a key dir was chosen (see the header);
 * `set` only when the child really got the dir read-only inside its own PID
 * namespace. `exposed` is wrapPiSpawn's report — the dirs it actually bound —
 * so a spawn that silently dropped the expose entry never gets the env that
 * points at it (fail closed).
 *
 * The caller passes gitPreSpawn's `keyDir` (not `gitDir`): a bot that owns a
 * key dir keeps the strip even when the probe refused to expose it.
 *
 * @param {{gitDir?: string|null, launch?: object|null}} opts
 * @returns {{remove: string[], set: {GIT_SSH_COMMAND: string, GIT_CONFIG_GLOBAL: string}|null, reason: string|null}}
 */
export function gitPostLaunch({ gitDir = null, launch = null } = {}) {
  if (!gitDir) return { remove: [], set: null, reason: null };
  const remove = [...GIT_ENV_KEYS];
  const l = launch || {};
  const off = (reason) => ({ remove, set: null, reason });
  if (l.wrapper !== "bwrap") return off("the spawn is not under bubblewrap");
  if (typeof l.tier === "string" && l.tier.startsWith("contain")) return off("the contain tier has no git access in this version");
  if (l.pidNamespace !== true) return off("the spawn has no private PID namespace");
  if (!Array.isArray(l.exposed) || !l.exposed.includes(gitDir)) return off("the key dir was not exposed inside the sandbox");
  const keyPath = gitDir + "/" + KEY;
  const knownHostsPath = gitDir + "/" + KNOWN_HOSTS;
  const configPath = gitDir + "/" + GITCONFIG;
  if (!isSafeKeyPath(keyPath) || !isSafeKeyPath(knownHostsPath) || !isSafeKeyPath(configPath)) {
    return off("the key dir path cannot be used in a git command");
  }
  const command = gitSshCommand({ keyPath, knownHostsPath });
  if (!command) return off("the key dir path cannot be used in a git command");
  return { remove, set: { GIT_SSH_COMMAND: command, GIT_CONFIG_GLOBAL: configPath }, reason: null };
}