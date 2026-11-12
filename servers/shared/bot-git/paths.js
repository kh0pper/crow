/**
 * Per-bot git access: where a bot's git key lives, and the shape checks every
 * reader applies before it trusts that directory.
 *
 * A bot gets git access when a key directory exists for it under the instance's
 * 0700 secrets dir:
 *
 *   <secrets>/bot-git/            0700   (created here / by the writer)
 *   <secrets>/bot-git/<bot_id>/   0700
 *     id_ed25519                  0600   ssh-keygen private key
 *     …
 * Nothing about it lives in the bot definition or in permission_policy: a bot
 * can edit its own definition through its DB-touching tools, and a policy key
 * is also written by trusted peers, while the secrets dir is a read-only tmpfs
 * inside every bot's sandbox. Only the gateway writes here, and only because
 * the owner asked it to.
 *
 * Every path goes through the ANCHORED secrets dir (secret-values.js): the dir
 * is pinned by (dev, ino) with an fd held open, so a dir renamed away is
 * followed to where it really is and a dir planted at the old path is never
 * used. `checkKeyDir` then re-checks the exact inode chain, because the anchor
 * guards the secrets dir, not what a future co-host or bot uid (Phase 3) might
 * leave below it.
 *
 * `<bot_id>` comes from `opts.botId` at the spawn site, never from a bot
 * definition: a definition is bot-writable, so a def naming another bot's id
 * must never select that bot's key.
 */
import { closeSync, constants as fsConstants, fstatSync, lstatSync, openSync, realpathSync } from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { BOT_ID_RE } from "../../../scripts/pi-bots/bot-workspace-env.mjs";
import { anchoredPath, secretsDirCurrentPath } from "../secret-values.js";

/** The folder under the anchored secrets dir that holds every bot's key dir. */
export const BOT_GIT_DIRNAME = "bot-git";

/** The private key's file name inside a bot's key dir. */
const KEY_FILENAME = "id_ed25519";

/** A name a caller may ask for inside a key dir (a plain file name). */
const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

/**
 * A bot id that may name a key dir: the engine's own rule (BOT_ID_RE, the same
 * charset the bridge accepts) plus the two dot names and any separator, which
 * would step out of the key dir.
 */
export function isValidGitBotId(id) {
  return typeof id === "string" && BOT_ID_RE.test(id) && id !== "." && id !== ".." && !id.includes("/") && !id.includes("\\");
}

/**
 * The charset a key dir path may use. It is handed to git inside
 * GIT_SSH_COMMAND (a shell string git runs) and to GIT_CONFIG_GLOBAL, so a
 * path with a space, a quote, `$`, a backtick or a newline can never be
 * expressed there without quoting: such a path simply disables git.
 */
export const SAFE_PATH_RE = /^[A-Za-z0-9._\/+-]+$/;

/** True when p can be written into a git command string as-is. */
export function isSafeKeyPath(p) {
  if (typeof p !== "string" || !p || p.length > 4096) return false;
  if (!isAbsolute(p) || !SAFE_PATH_RE.test(p)) return false;
  return !p.split("/").includes("..");
}

/**
 * The real path of a bot's key dir, for hiding/exposing in the sandbox; null
 * when the id is unusable or the secrets dir has no anchor.
 */
export function botGitDirReal(botId, env = process.env) {
  if (!isValidGitBotId(botId)) return null;
  const base = secretsDirCurrentPath(env);
  if (!base) return null;
  return join(base, BOT_GIT_DIRNAME, botId);
}

/**
 * A name inside a bot's key dir, through the anchored secrets fd; null when the
 * id, a name or the anchor is unusable. Reads and writes both go through this,
 * so an fstat through the returned path is an fstat of the dir Crow anchored.
 */
export function botGitAnchored(botId, ...names) {
  if (!isValidGitBotId(botId)) return null;
  for (const name of names) {
    if (typeof name !== "string" || !NAME_RE.test(name) || name === "." || name === "..") return null;
  }
  return anchoredPath(process.env, BOT_GIT_DIRNAME, botId, ...names);
}

/**
 * The path a CHILD PROCESS must be handed for something Crow holds through an
 * ANCHORED path (`/proc/self/fd/<fd>/…`, secret-values.js): the fd number
 * exists only in THIS process, so a child (ssh-keygen, ssh, git) opening that
 * path gets ENOENT. Unquoting the magic link with realpathSync gives a path the
 * child can open too.
 *
 * The resolved path is accepted only when it names the very inode the anchored
 * path names (same dev+ino, neither of them a symlink), and `directory` also
 * demands a real dir. That check NARROWS the swap window (the resolution and
 * the stats are separate syscalls), it does not close it: only a same-uid
 * process that can rename inside the secrets dir — i.e. one outside the bot
 * sandbox — could race it, which is accepted risk R13 for v1. null for
 * anything else (never throws).
 *
 * Paths that stay INSIDE this process (every read and write of the store) keep
 * using the anchored path: the anchor, not a name, is what makes them safe.
 *
 * @param {string} anchored  a path built by anchoredPath()/botGitAnchored()
 * @param {{directory?: boolean}} [opts]
 * @returns {string|null}
 */
export function childVisiblePath(anchored, { directory = false } = {}) {
  if (typeof anchored !== "string" || !anchored) return null;
  let resolved;
  try { resolved = realpathSync(anchored); } catch { return null; }
  let fromAnchor, fromReal;
  try {
    fromAnchor = lstatSync(anchored);
    fromReal = lstatSync(resolved);
  } catch {
    return null;
  }
  if (fromAnchor.isSymbolicLink() || fromReal.isSymbolicLink()) return null;
  if (fromAnchor.dev !== fromReal.dev || fromAnchor.ino !== fromReal.ino) return null;
  if (directory && (!fromAnchor.isDirectory() || !fromReal.isDirectory())) return null;
  return resolved;
}

function fail(reason) {
  return { ok: false, reason };
}

function modeString(st) {
  return "0" + (st.mode & 0o777).toString(8);
}

/**
 * Whether `dirReal` is a key dir Crow may read a key from. Checks, in order:
 * the path is absolute and normalised and named after a bot id; every
 * component from the secrets dir down is a real directory (never a symlink);
 * `bot-git/` and the key dir are this user's, mode 0700 (no group/other bit);
 * `id_ed25519` is a single-link regular file of this user, mode 0600, and the
 * inode checked is the inode opened (a swap between lstat and open loses).
 *
 * @param {string} dirReal   `<secrets real>/bot-git/<bot_id>`
 * @param {{uid?: number}} [opts]
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function checkKeyDir(dirReal, { uid = process.getuid() } = {}) {
  if (typeof dirReal !== "string" || !dirReal || !isAbsolute(dirReal) || resolve(dirReal) !== dirReal) {
    return fail("the key dir path is not an absolute, normalised path");
  }
  if (!isValidGitBotId(basename(dirReal))) return fail("the key dir is not named after a bot id");
  const botGitDir = dirname(dirReal);
  if (basename(botGitDir) !== BOT_GIT_DIRNAME) return fail("the key dir does not sit under " + BOT_GIT_DIRNAME + "/");
  const secretsReal = dirname(botGitDir);
  if (dirname(secretsReal) === secretsReal) return fail("the key dir has no secrets dir above it");

  // The whole chain: a symlinked ancestor would let one bot's key dir stand in
  // for every bot's.
  const chain = [["the secrets dir", secretsReal], [BOT_GIT_DIRNAME + "/", botGitDir], ["the key dir", dirReal]];
  for (const [what, p] of chain) {
    let st;
    try { st = lstatSync(p); } catch { return fail(what + " is missing"); }
    if (st.isSymbolicLink()) return fail(what + " is a symlink");
    if (!st.isDirectory()) return fail(what + " is not a directory");
  }
  for (const [what, p] of [[BOT_GIT_DIRNAME + "/", botGitDir], ["the key dir", dirReal]]) {
    let st;
    try { st = lstatSync(p); } catch { return fail(what + " is missing"); }
    if (st.uid !== uid) return fail(what + " is owned by another user");
    if ((st.mode & 0o077) !== 0) return fail(what + " mode " + modeString(st) + " lets group or other users in");
  }

  const keyPath = join(dirReal, KEY_FILENAME);
  let lst;
  try { lst = lstatSync(keyPath); } catch { return fail("the private key is missing"); }
  if (lst.isSymbolicLink()) return fail("the private key is a symlink");
  if (!lst.isFile()) return fail("the private key is not a regular file");
  if (lst.nlink !== 1) return fail("the private key is hard-linked");
  if (lst.uid !== uid) return fail("the private key is owned by another user");
  if ((lst.mode & 0o077) !== 0) return fail("the private key mode " + modeString(lst) + " lets group or other users read it");
  let fd;
  try {
    fd = openSync(keyPath, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const st = fstatSync(fd);
    if (!st.isFile() || st.ino !== lst.ino || st.dev !== lst.dev || st.nlink !== 1 ||
        st.uid !== uid || (st.mode & 0o077) !== 0) {
      return fail("the private key changed while it was checked");
    }
  } catch {
    return fail("the private key cannot be opened");
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* already closed */ } }
  }
  return { ok: true };
}

/**
 * Operator ruling on R13 (2026-11-12): two bots run as the same uid, so a bot
 * with a shell can read another bot's key dir through /proc while both are
 * spawned. The operator ACCEPTED that risk for v1: the sandbox's read-only
 * tmpfs is the boundary, not per-bot secrecy. The Bot Builder's Git access card
 * states it plainly, and the other value, "single-bot", offers git access only
 * while exactly one pi bot is enabled on this instance.
 *
 * PR C ships the ACCEPTED value (the ruling). Separate per-bot Linux users are
 * the queued follow-up; flipping back is this one line.
 */
export const GIT_SHARED_UID_POLICY = "accepted";

/** The values GIT_SHARED_UID_POLICY may take. */
export const GIT_UID_POLICIES = Object.freeze(["accepted", "single-bot"]);

let policyOverride = null;

/** TEST ONLY: run gitAllowedForInstance under the other ruling. null restores. */
export function _setGitSharedUidPolicyForTest(policy) {
  if (policy === null || policy === undefined) { policyOverride = null; return; }
  if (!GIT_UID_POLICIES.includes(policy)) throw new Error("unknown git shared-uid policy: " + String(policy));
  policyOverride = policy;
}

/**
 * Whether this instance may give bots git access at all. `enabledPiBotCount`
 * is the count of enabled pi bots (engine null or "pi"); flipping the ruling
 * is the one line above.
 */
export function gitAllowedForInstance({ enabledPiBotCount } = {}) {
  const policy = policyOverride ?? GIT_SHARED_UID_POLICY;
  if (policy === "accepted") return true;
  return enabledPiBotCount === 1;
}