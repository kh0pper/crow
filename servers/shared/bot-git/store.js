/**
 * Per-bot git access: the key store.
 *
 * Everything a bot's git needs lives in one 0700 dir under the instance's
 * anchored secrets dir (paths.js), and this module is the only writer:
 *
 *   <secrets>/bot-git/                    0700   (created here)
 *     <bot_id>/                           0700
 *       id_ed25519                        0600   ssh-keygen private key
 *       id_ed25519.pub                    0600   its public half (only Crow reads it)
 *       meta.json                         0600   { bot_id, created_at, fingerprint, generated_at }
 *       confirmed_hosts                   0600   owner-confirmed known_hosts lines
 *       known_hosts                       0600   GENERATED: pinned GitHub + confirmed_hosts
 *       gitconfig                         0600   GENERATED: user.name / user.email
 *
 * "Git access is on" means exactly "a valid key dir exists for this bot": no
 * bot-definition field and no permission_policy key, because a bot can edit its
 * own definition and a trusted peer can patch a policy, while this dir sits in
 * the secrets dir that is a read-only tmpfs inside every bot's sandbox.
 *
 * Every write is one recipe: `lstat` the two dirs above (real dirs, this user,
 * 0700), write a fresh temp name in the same dir with
 * O_WRONLY|O_CREAT|O_EXCL|O_NOFOLLOW at 0600, fsync, then rename over the
 * target; the temp is unlinked on any error. O_EXCL plus O_NOFOLLOW means a
 * planted file or symlink at the temp name is never written through. The
 * keygen writes are the exception (ssh-keygen makes its own files); they land
 * in a private temp dir that only replaces the key dir at the very end, and
 * ssh-keygen is a CHILD process, so it is handed the real path of that temp dir
 * (paths.childVisiblePath), never the anchored /proc/self/fd path — an fd
 * number means nothing outside this process.
 *
 * Nothing here ever returns, logs or throws key material: the private key is
 * read only by botGitSecretValues (for masking) and never by a status read.
 */
import { execFileSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import {
  chmodSync, closeSync, constants as fsConstants, fchmodSync, fstatSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readSync, readdirSync, renameSync, rmSync, unlinkSync, writeSync,
} from "node:fs";
import { join } from "node:path";
import { BOT_GIT_DIRNAME, botGitAnchored, botGitDirReal, checkKeyDir, childVisiblePath, isValidGitBotId } from "./paths.js";
import { buildKnownHosts, fingerprintOf, knownHostsName, normalizeHost, parseKeyLine } from "./host-keys.js";
import { gitconfigText } from "./identity.js";
import { anchoredPath } from "../secret-values.js";

/** File names inside a bot's key dir. */
const KEY = "id_ed25519";
const PUB = "id_ed25519.pub";
const META = "meta.json";
const CONFIRMED = "confirmed_hosts";
const KNOWN_HOSTS = "known_hosts";
const GITCONFIG = "gitconfig";

/** A stale temp dir is one a crashed generator left behind an hour ago. */
const STALE_TEMP_MS = 60 * 60 * 1000;

/** Longest key file read: an OpenSSH ed25519 private key is under 500 bytes. */
const MAX_KEY_BYTES = 16 * 1024;
/** Longest confirmed_hosts read (an owner confirms a handful of hosts). */
const MAX_HOSTS_BYTES = 64 * 1024;

let randomHex = () => randomBytes(8).toString("hex");

/**
 * TEST ONLY: make the temp-file suffix predictable, so a test can plant a file
 * (or a symlink) at the name the next write will pick. Call with null to
 * restore the real randomness.
 */
export function _setRandomHexForTest(fn) {
  randomHex = typeof fn === "function" ? fn : () => randomBytes(8).toString("hex");
}

function modeString(st) {
  return "0" + (st.mode & 0o777).toString(8);
}

function refuse(reason) {
  return { ok: false, reason };
}

/** The user every key dir must belong to. */
function uid() {
  return process.getuid();
}

/**
 * A dir a write is about to land in: a real directory (never a symlink), this
 * user's, mode 0700. A symlink here would let one bot's key dir stand in for
 * every bot's.
 */
function writeDirCheck(dir, what) {
  let st;
  try { st = lstatSync(dir); } catch { return refuse(what + " is missing"); }
  if (st.isSymbolicLink()) return refuse(what + " is a symlink");
  if (!st.isDirectory()) return refuse(what + " is not a directory");
  if (st.uid !== uid()) return refuse(what + " is owned by another user");
  if ((st.mode & 0o077) !== 0) return refuse(what + " mode " + modeString(st) + " lets group or other users in");
  return { ok: true };
}

/**
 * Read a regular file of this user's, through an anchored path: no symlink,
 * the inode checked is the inode opened, and the mode/shape the caller asks
 * for. null for anything that does not qualify (never throws).
 */
function readSmallFile(path, { max = MAX_KEY_BYTES, exactMode = null, noGroupOther = false } = {}) {
  let fd;
  try {
    const lst = lstatSync(path);
    if (lst.isSymbolicLink() || !lst.isFile()) return null;
    if (lst.uid !== uid() || lst.size > max) return null;
    if (exactMode !== null && (lst.mode & 0o777) !== exactMode) return null;
    if (noGroupOther && (lst.mode & 0o077) !== 0) return null;
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW);
    const st = fstatSync(fd);
    if (!st.isFile() || st.ino !== lst.ino || st.dev !== lst.dev || st.size > max) return null;
    if (exactMode !== null && (st.mode & 0o777) !== exactMode) return null;
    if (noGroupOther && (st.mode & 0o077) !== 0) return null;
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n <= 0) break;
      off += n;
    }
    return buf.subarray(0, off).toString("utf8");
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* already closed */ } }
  }
}

/**
 * The atomic write recipe (paths.js header): temp name, O_EXCL|O_NOFOLLOW,
 * fsync, rename. Throws the fs error (EEXIST from a planted temp name) and
 * leaves the target as it was; the temp name is unlinked on the way out.
 */
function writeAtomic(dir, name, content) {
  const chk = writeDirCheck(dir, "the key dir");
  if (!chk.ok) throw new Error("bot git: " + chk.reason);
  const target = join(dir, name);
  const tmp = join(dir, "." + name + "." + randomHex());
  let fd;
  try {
    fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    try {
      fchmodSync(fd, 0o600);            // a strict umask must not leave it 400
      writeSync(fd, content);
      fsyncSync(fd);
    } finally {
      closeSync(fd);
      fd = undefined;
    }
    renameSync(tmp, target);
  } catch (err) {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* already closed */ } }
    try { unlinkSync(tmp); } catch { /* nothing created */ }
    throw err;
  }
}

/** Create `bot-git/` (0700) or check the one that is there. */
function ensureBotGitDir() {
  const root = anchoredPath(process.env, BOT_GIT_DIRNAME);
  if (!root) throw new Error("bot git: the secrets dir is not available");
  let st;
  try { st = lstatSync(root); } catch (e) {
    if (!e || e.code !== "ENOENT") throw new Error("bot git: " + BOT_GIT_DIRNAME + "/ cannot be checked");
  }
  if (st) {
    const chk = writeDirCheck(root, BOT_GIT_DIRNAME + "/");
    if (!chk.ok) throw new Error("bot git: " + chk.reason);
    return root;
  }
  let created = false;
  try { mkdirSync(root, { mode: 0o700 }); created = true; } catch (e) {
    if (!e || e.code !== "EEXIST") throw new Error("bot git: " + BOT_GIT_DIRNAME + "/ cannot be created");
  }
  // Only a dir this call made is chmod'ed: a dir that was already there is
  // judged by writeDirCheck, never repaired (and chmod would follow a symlink).
  if (created) { try { chmodSync(root, 0o700); } catch { /* the check below decides */ } }
  const chk = writeDirCheck(root, BOT_GIT_DIRNAME + "/");
  if (!chk.ok) throw new Error("bot git: " + chk.reason);
  return root;
}

/**
 * ssh-keygen with a fixed argv (never a shell). Its stderr is deliberately not
 * echoed: it can carry the path, and the caller only needs "it failed".
 *
 * `keyPath` must be a CHILD-VISIBLE path (childVisiblePath): ssh-keygen is a
 * child process, so the anchored `/proc/self/fd/<fd>/…` path Crow uses itself
 * does not resolve there and the keygen would fail with ENOENT.
 */
function runKeygen(execFileImpl, botId, keyPath) {
  try {
    execFileImpl("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-C", "crow-bot:" + botId, "-f", keyPath],
      { timeout: 10_000, env: { PATH: process.env.PATH || "/usr/bin:/bin", LANG: "C" } });
  } catch (err) {
    const code = err && typeof err.code === "string" && /^[A-Z]{2,}$/.test(err.code) ? " (" + err.code + ")" : "";
    throw new Error("bot git: ssh-keygen failed" + code + "; git access needs openssh-client installed");
  }
}

/** The public key line of a .pub file, or null when it is not one. */
function publicLineOf(text) {
  if (typeof text !== "string") return null;
  const line = text.trim();
  const fields = line.split(/\s+/);
  if (fields.length < 2) return null;
  // parseKeyLine validates the blob: the type it claims must be the type it
  // starts with, and the material must be base64.
  const parsed = parseKeyLine("crow-bot.invalid " + fields[0] + " " + fields[1]);
  if (!parsed) return null;
  return { line, type: parsed.type, key: parsed.key, fingerprint: fingerprintOf(parsed.key) };
}

/** The meta.json of a key dir, or null. */
function readMeta(botId) {
  const p = botGitAnchored(botId, META);
  const text = p ? readSmallFile(p, { max: 4096, exactMode: 0o600 }) : null;
  if (text == null) return null;
  try {
    const meta = JSON.parse(text);
    if (!meta || typeof meta !== "object" || meta.bot_id !== botId) return null;
    return meta;
  } catch {
    return null;
  }
}

/**
 * A bot's key-dir metadata (`{ bot_id, created_at, fingerprint, generated_at }`),
 * or null when there is no usable key dir. Read-only, through the anchored
 * secrets dir and under the same mode/shape rules as every other read; the
 * bridge uses `created_at` only as housekeeping (does this key dir belong to
 * the row that is about to spawn). Never returns key material.
 */
export function botGitMeta(botId) {
  return isValidGitBotId(botId) ? readMeta(botId) : null;
}

/** The confirmed host lines of a bot, re-serialised from parsed parts. */
function readConfirmedLines(botId) {
  const p = botGitAnchored(botId, CONFIRMED);
  const text = p ? readSmallFile(p, { max: MAX_HOSTS_BYTES, exactMode: 0o600 }) : null;
  if (text == null) return [];
  const out = [];
  const seen = new Set();
  for (const raw of text.split(/\r?\n/)) {
    const parsed = parseKeyLine(raw);
    if (!parsed) continue;
    const line = knownHostsName(parsed) + " " + parsed.type + " " + parsed.key;
    if (seen.has(line)) continue;
    seen.add(line);
    out.push(line);
  }
  return out;
}

/** `{ host, port, type, fingerprint }` per confirmed line (for the dashboard). */
function hostsOf(lines) {
  const out = [];
  for (const line of lines) {
    const parsed = parseKeyLine(line);
    if (!parsed) continue;
    out.push({ host: parsed.host, port: parsed.port, type: parsed.type, fingerprint: fingerprintOf(parsed.key) });
  }
  return out;
}

/** The key dir of a bot that has one, as `{ ok: true, dir }`, or a refusal. */
function keyDirForWrite(botId) {
  if (!isValidGitBotId(botId)) return refuse("invalid bot id");
  const dir = botGitAnchored(botId);
  if (!dir) return refuse("the secrets dir is not available");
  const chk = writeDirCheck(dir, "the key dir");
  if (!chk.ok) return chk;
  return { ok: true, dir };
}

/**
 * Whether the dir already at `bot-git/<bot_id>/` is a STALE key dir: a real
 * directory of this user's whose `meta.json` names ANOTHER bot row (a different
 * `created_at`, or no usable `meta.json` at all).
 *
 * Housekeeping, not a security boundary (C5, R8): `created_at` has one-second
 * resolution and lives in crow.db, which a bot can write in the default tier.
 * The spawn side refuses a mismatch on its own (bot_git_spawn.mjs gitPreSpawn),
 * so this never decides whether a key is TRUSTED — it decides only whether
 * `git_on` may replace a leftover dir instead of being refused forever after a
 * bot was deleted and recreated with the same id.
 *
 * False whenever freshness cannot be established: a symlink, a foreign dir, an
 * unusable key dir path, or a caller with no row timestamp all keep the plain
 * "a key already exists" refusal.
 */
function staleKeyDir(botId, createdAt) {
  const rowAt = typeof createdAt === "string" && createdAt ? createdAt : null;
  if (!rowAt) return false;
  const dir = botGitAnchored(botId);
  if (!dir) return false;
  let st;
  try { st = lstatSync(dir); } catch { return false; }
  if (st.isSymbolicLink() || !st.isDirectory() || st.uid !== uid()) return false;
  const meta = readMeta(botId);
  const metaAt = meta && typeof meta.created_at === "string" ? meta.created_at : null;
  return metaAt !== rowAt;
}

/**
 * Whether a key dir exists at `bot-git/<bot_id>/` that this user could remove: a
 * real directory of this user's, never a symlink. Says nothing about whether the
 * dir is USABLE (checkKeyDir does): a damaged dir — a missing `.pub`, an
 * unusable `meta.json` — answers true, which is how the card knows the owner can
 * still clear it with Turn off.
 */
function keyDirPresent(botId) {
  const dir = botGitAnchored(botId);
  if (!dir) return false;
  let st;
  try { st = lstatSync(dir); } catch { return false; }
  return !st.isSymbolicLink() && st.isDirectory() && st.uid === uid();
}

/**
 * Whether a key dir exists for this bot even if it is not usable (see
 * `keyDirPresent`). The card uses it to offer Turn off for a damaged dir, and
 * for a stale one a recycled id left behind; removal itself applies the same
 * symlink and foreign-owner refusals as every other write.
 */
export function botKeyDirPresent(botId) {
  return isValidGitBotId(botId) && keyDirPresent(botId);
}

/**
 * Remove the key dir at `bot-git/<bot_id>/` when it is a real directory of this
 * user's. A symlink, a foreign dir and a missing dir all answer false and leave
 * whatever is there untouched.
 */
function removeKeyDir(botId) {
  if (!keyDirPresent(botId)) return false;
  const dir = botGitAnchored(botId);
  if (!dir) return false;
  try {
    rmSync(dir, { recursive: true, force: true });
  } catch {
    return false;
  }
  return true;
}

/** The fingerprint of the `.pub` already in a key dir, or null when unreadable. */
function keyDirFingerprint(botId) {
  const p = botGitAnchored(botId, PUB);
  const pub = publicLineOf(p ? readSmallFile(p, { max: 8192, noGroupOther: true }) : null);
  return pub ? pub.fingerprint : null;
}

/** A host/port pair normalised for a confirm, or null (also refuses GitHub). */
function confirmTarget(host, port) {
  const p = Number(port);
  if (!Number.isInteger(p) || p < 1 || p > 65535) return null;
  const raw = String(host == null ? "" : host).trim().toLowerCase();
  if (!raw) return null;
  const norm = normalizeHost(p === 22 ? raw : raw + ":" + p);
  if (!norm || norm.port !== p) return null;
  return norm;
}

/**
 * Generate a bot's key pair into `bot-git/<bot_id>/`.
 *
 * Refuses when a key dir already exists (never overwrites a key: the owner's
 * deploy key on the forge is the old public half). The one exception is a STALE
 * dir left by an earlier bot with the same recycled id (`staleKeyDir`): it is
 * removed and replaced, because no spawn would ever use it and its public half
 * is not this bot's deploy key. The pair is generated in a temp dir and only
 * that dir is renamed into place, so a failure at any point leaves no key dir
 * and no temp dir behind.
 *
 * `replacedFingerprint` is the stale dir's own public fingerprint, read before
 * the dir goes, so the caller can tell the owner which deploy key on the forge
 * is now dead; null when no dir was replaced (or its `.pub` was unreadable).
 *
 * @param {{botId: string, createdAt?: string|null, execFileImpl?: Function}} opts
 * @returns {{publicKey: string, fingerprint: string, replacedFingerprint: string|null}}
 */
export function generateBotKey({ botId, createdAt = null, execFileImpl = execFileSync } = {}) {
  if (!isValidGitBotId(botId)) throw new Error("bot git: invalid bot id");
  const root = ensureBotGitDir();
  const keyDir = join(root, botId);
  let existing;
  try { existing = lstatSync(keyDir); } catch { existing = null; }
  let replacedFingerprint = null;
  if (existing) {
    const stale = staleKeyDir(botId, createdAt);
    // Read the old public half BEFORE the removal: afterwards there is nothing
    // left to name the deploy key the owner must take off the forge.
    if (stale) replacedFingerprint = keyDirFingerprint(botId);
    if (!(stale && removeKeyDir(botId))) {
      throw new Error("bot git: a key already exists for this bot");
    }
  }
  const tmpDir = join(root, ".tmp-" + botId + "-" + randomHex());
  try { mkdirSync(tmpDir, { mode: 0o700 }); } catch {
    throw new Error("bot git: a key cannot be generated right now");
  }
  let published = false;
  try {
    chmodSync(tmpDir, 0o700);
    // ssh-keygen cannot see the anchored path: /proc/self/fd/<fd> is this
    // process's fd, and the child has no fd <fd>. It is handed the real path of
    // the very dir just created (same dev+ino, a real directory), and every
    // read and write AFTER keygen keeps using the anchored path.
    const childTmp = childVisiblePath(tmpDir, { directory: true });
    if (!childTmp) throw new Error("bot git: a key cannot be generated right now");
    runKeygen(execFileImpl, botId, join(childTmp, KEY));
    // ssh-keygen's own writes are the one place the recipe does not apply: they
    // land in this private, empty temp dir.
    for (const name of [KEY, PUB]) {
      const p = join(tmpDir, name);
      let lst;
      try { lst = lstatSync(p); } catch { throw new Error("bot git: ssh-keygen did not write the expected files"); }
      if (lst.isSymbolicLink() || !lst.isFile()) throw new Error("bot git: ssh-keygen did not write the expected files");
      chmodSync(p, 0o600);
    }
    const pub = publicLineOf(readSmallFile(join(tmpDir, PUB), { max: 8192, exactMode: 0o600 }));
    if (!pub) throw new Error("bot git: ssh-keygen did not write a usable public key");
    const meta = { bot_id: botId, created_at: createdAt, fingerprint: pub.fingerprint, generated_at: new Date().toISOString() };
    writeAtomic(tmpDir, META, JSON.stringify(meta) + "\n");
    writeAtomic(tmpDir, CONFIRMED, "");
    renameSync(tmpDir, keyDir);
    published = true;
    return { publicKey: pub.line, fingerprint: pub.fingerprint, replacedFingerprint };
  } finally {
    if (!published) { try { rmSync(tmpDir, { recursive: true, force: true }); } catch { /* best effort */ } }
  }
}

/**
 * Whether a bot has a usable key dir. Reads `meta.json`, `id_ed25519.pub` and
 * `confirmed_hosts` only; the private key is checked by inode (checkKeyDir),
 * never read, and no returned string can carry key material.
 *
 * @returns {{on: false, reason?: string} | {on: true, publicKey: string, fingerprint: string, createdAt: string|null, hosts: object[]}}
 */
export function botKeyStatus(botId) {
  if (!isValidGitBotId(botId)) return { on: false, reason: "invalid bot id" };
  const dirReal = botGitDirReal(botId);
  if (!dirReal) return { on: false, reason: "the secrets dir is not available" };
  const check = checkKeyDir(dirReal);
  if (!check.ok) return { on: false, reason: check.reason };
  const meta = readMeta(botId);
  if (!meta) return { on: false, reason: "the key dir has no usable meta.json" };
  const p = botGitAnchored(botId, PUB);
  const pub = publicLineOf(p ? readSmallFile(p, { max: 8192, noGroupOther: true }) : null);
  if (!pub) return { on: false, reason: "the key dir has no usable public key" };
  return {
    on: true,
    publicKey: pub.line,
    fingerprint: pub.fingerprint,
    createdAt: typeof meta.created_at === "string" ? meta.created_at : null,
    hosts: hostsOf(readConfirmedLines(botId)),
  };
}

/**
 * Remove a bot's key dir (the C4 delete hook and the orphan sweep). The
 * fingerprint is read first, so the owner can be told which deploy key to
 * remove on the forge. A symlink or a foreign dir at the key dir path is left
 * alone: only a real dir of this user's is removed.
 *
 * @returns {{removed: boolean, fingerprint: string|null}}
 */
export function removeBotKey(botId) {
  if (!isValidGitBotId(botId)) return { removed: false, fingerprint: null };
  const status = botKeyStatus(botId);
  const fingerprint = status.on ? status.fingerprint : null;
  return { removed: removeKeyDir(botId), fingerprint };
}

/**
 * Confirm a host key for a bot: rebuild `confirmed_hosts` from its parsed lines
 * plus this one, and write it atomically. The host and the key line both go
 * through the host-keys rules, so a pasted marker, wildcard, hashed host or a
 * pinned host (github.com) is refused here as it is in buildKnownHosts.
 *
 * @returns {{ok: true, hosts: object[]} | {ok: false, reason: string}}
 */
export function addConfirmedHost(botId, { host, port = 22, type, key } = {}) {
  const dir = keyDirForWrite(botId);
  if (!dir.ok) return dir;
  const status = botKeyStatus(botId);
  if (!status.on) return refuse(status.reason || "no git key for this bot");
  const target = confirmTarget(host, port);
  if (!target) return refuse("this host cannot be confirmed");
  const parsed = parseKeyLine(knownHostsName(target) + " " + String(type == null ? "" : type) + " " + String(key == null ? "" : key));
  if (!parsed) return refuse("that host key line is not usable");
  if (parsed.host !== target.host || parsed.port !== target.port) return refuse("that host key line is not usable");
  const line = knownHostsName(parsed) + " " + parsed.type + " " + parsed.key;
  const lines = readConfirmedLines(botId);
  if (!lines.includes(line)) lines.push(line);
  try {
    writeAtomic(dir.dir, CONFIRMED, lines.join("\n") + (lines.length ? "\n" : ""));
  } catch {
    return refuse("the confirmed hosts cannot be written");
  }
  return { ok: true, hosts: hostsOf(lines) };
}

/**
 * Drop every confirmed line for a host/port. `hosts` is the list that is left.
 *
 * @returns {{ok: true, hosts: object[]} | {ok: false, reason: string}}
 */
export function removeConfirmedHost(botId, host, port = 22) {
  const dir = keyDirForWrite(botId);
  if (!dir.ok) return dir;
  const target = confirmTarget(host, port);
  if (!target) return refuse("this host cannot be removed");
  const lines = readConfirmedLines(botId).filter((line) => {
    const parsed = parseKeyLine(line);
    if (!parsed) return false;
    return !(parsed.host === target.host && parsed.port === target.port);
  });
  try {
    writeAtomic(dir.dir, CONFIRMED, lines.join("\n") + (lines.length ? "\n" : ""));
  } catch {
    return refuse("the confirmed hosts cannot be written");
  }
  return { ok: true, hosts: hostsOf(lines) };
}

/**
 * Regenerate a bot's `known_hosts` (pinned GitHub lines + confirmed hosts).
 * The bridge calls this at every spawn; testConnection calls it before it
 * connects, so a host the owner just confirmed is trusted without waiting.
 *
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function writeKnownHosts(botId) {
  const dir = keyDirForWrite(botId);
  if (!dir.ok) return dir;
  const status = botKeyStatus(botId);
  if (!status.on) return refuse(status.reason || "no git key for this bot");
  try {
    writeAtomic(dir.dir, KNOWN_HOSTS, buildKnownHosts(readConfirmedLines(botId)));
  } catch {
    return refuse("known_hosts cannot be written");
  }
  return { ok: true };
}

/**
 * Regenerate the two generated files of a key dir: `known_hosts` and
 * `gitconfig` (identity.js). Called by the bridge at every spawn (B2).
 * The commit address is always the bot's fixed no-reply address (identity.js
 * decides it); there is no email parameter, so a caller cannot supply one.
 *
 * @returns {{ok: true} | {ok: false, reason: string}}
 */
export function writeSpawnFiles({ botId, displayName } = {}) {
  const dir = keyDirForWrite(botId);
  if (!dir.ok) return dir;
  const known = writeKnownHosts(botId);
  if (!known.ok) return known;
  let config;
  try {
    config = gitconfigText({ displayName, botId });
  } catch {
    return refuse("the bot's commit identity is not usable");
  }
  try {
    writeAtomic(dir.dir, GITCONFIG, config);
  } catch {
    return refuse("gitconfig cannot be written");
  }
  return { ok: true };
}

/**
 * Remove key dirs no bot owns any more (C5's boot sweep), plus `.tmp-*` dirs a
 * crashed generator left behind over an hour ago. Touches only entries that are
 * real directories with a valid bot id; a stray file, a symlink and a dir whose
 * name is not a bot id are left alone. Not given an array: removes nothing.
 *
 * @param {string[]} liveBotIds
 * @returns {string[]} the bot ids whose key dirs were removed
 */
export function sweepOrphanKeys(liveBotIds) {
  if (!Array.isArray(liveBotIds)) return [];
  const root = anchoredPath(process.env, BOT_GIT_DIRNAME);
  if (!root) return [];
  let entries;
  try { entries = readdirSync(root, { withFileTypes: true }); } catch { return []; }
  const live = new Set(liveBotIds.filter((id) => isValidGitBotId(id)));
  const removed = [];
  const now = Date.now();
  for (const entry of entries) {
    if (entry.name.startsWith(".tmp-")) {
      if (!entry.isDirectory()) continue;
      const p = join(root, entry.name);
      try {
        if (now - lstatSync(p).mtimeMs <= STALE_TEMP_MS) continue;
        rmSync(p, { recursive: true, force: true });
      } catch { /* raced */ }
      continue;
    }
    if (!isValidGitBotId(entry.name)) continue;
    if (!entry.isDirectory()) continue;         // never a symlink: Dirent says so
    if (live.has(entry.name)) continue;
    const p = botGitAnchored(entry.name);
    if (!p) continue;
    try {
      const st = lstatSync(p);
      if (st.isSymbolicLink() || !st.isDirectory() || st.uid !== uid()) continue;
      rmSync(p, { recursive: true, force: true });
      removed.push(entry.name);
    } catch { /* raced */ }
  }
  return removed;
}

/** The tool paths checked, in the order the installer's openssh-client puts them. */
const SSH_TOOLS = Object.freeze([
  ["ssh", ["/usr/bin/ssh", "/bin/ssh", "/usr/local/bin/ssh"]],
  ["ssh-keygen", ["/usr/bin/ssh-keygen", "/bin/ssh-keygen", "/usr/local/bin/ssh-keygen"]],
  ["ssh-keyscan", ["/usr/bin/ssh-keyscan", "/bin/ssh-keyscan", "/usr/local/bin/ssh-keyscan"]],
]);

/**
 * Whether this host can do git-over-ssh for a bot: ssh (git needs it),
 * ssh-keygen (key generation) and ssh-keyscan (confirming a host's key). A
 * missing tool turns the Git access row off with "install openssh-client".
 *
 * @returns {{ok: boolean, missing: string[]}}
 */
export function sshToolsAvailable() {
  const missing = [];
  for (const [name, candidates] of SSH_TOOLS) {
    if (!candidates.some((p) => {
      try { return lstatSync(p).isFile(); } catch { return false; }
    })) missing.push(name);
  }
  return { ok: missing.length === 0, missing };
}

/**
 * The key material that must never be shown: for every key dir, the private
 * key's base64 body joined into one line (a key pasted with its line breaks
 * removed) and each body line long enough to be worth masking on its own (a key
 * printed with its line breaks). Read through the anchored secrets dir; a key
 * dir that is not a real dir of this user's is skipped. Never throws.
 *
 * Feeds the DISPLAY set only (secret-values-collect.js): the card set is the
 * payload every bot's pi receives, so a key must never enter it.
 *
 * Every `bot-git/` path is resolved from the `env` the caller collected with
 * (not this process's), so a caller that collects for an explicit env reads the
 * key store that env names.
 *
 * The mode rule is checkKeyDir's `noGroupOther`, not exactly 0600: a key that
 * enables git is always masked, even if an owner tightened it to 0400.
 *
 * @param {object} [env] the env to resolve the secrets dir from
 * @returns {string[]}
 */
export function botGitSecretValues(env = process.env) {
  const out = [];
  try {
    const root = anchoredPath(env, BOT_GIT_DIRNAME);
    if (!root) return out;
    for (const entry of readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || !isValidGitBotId(entry.name)) continue;
      const p = anchoredPath(env, BOT_GIT_DIRNAME, entry.name, KEY);
      if (!p) continue;
      const text = readSmallFile(p, { max: MAX_KEY_BYTES, noGroupOther: true });
      if (text == null) continue;
      const body = [];
      let inBody = false;
      for (const raw of text.split(/\r?\n/)) {
        const line = raw.trim();
        if (!inBody) { if (line.startsWith("-----BEGIN ")) inBody = true; continue; }
        if (line.startsWith("-----END ")) break;
        if (line) body.push(line);
      }
      if (!body.length) continue;
      const joined = body.join("");
      if (joined.length >= 6) out.push(joined);
      for (const line of body) if (line.length >= 40) out.push(line);
    }
  } catch { /* a key store that cannot be read masks nothing from here */ }
  return out;
}