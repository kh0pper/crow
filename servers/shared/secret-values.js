/**
 * The instance's secret VALUES list: the exact strings Crow hides from bot
 * approval/ask cards, "needs you" pushes and their log lines
 * (servers/shared/secret-mask.js), and the file the bot engine hands pi-lab as
 * PI_BOT_SECRET_VALUES_FILE (contract with pi-lab, 2026-10-26; the private
 * engineering notes).
 *
 * The file: <CROW_HOME>/secrets/pi-bot-secret-values — one value per line, a
 * user-owned regular file, mode 600, in the 700 dir that already holds the
 * keychain key. Not the data dir: backups and instance copies take the data
 * dir, and a plaintext copy of keychain values there would undo the keychain's
 * key separation (keychain/key.js). Bots never see it: the default pi sandbox
 * hides the whole secrets dir behind a tmpfs, the contain tier never binds
 * CROW_HOME/secrets, and the read tool's roots never include it.
 *
 * This module is the READ side plus the atomic writer. It never opens a
 * database or the keychain (it is imported by MCP server processes through
 * notifications.js); collecting from those sources is
 * secret-values-collect.js, run by the bot engine at each pi spawn.
 */
import { chmodSync, closeSync, fchmodSync, fstatSync, lstatSync, mkdirSync, openSync, readdirSync, readFileSync, readlinkSync, readSync, realpathSync, renameSync, rmSync, statSync, writeFileSync, fsyncSync, constants as fsConstants } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join, resolve } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { resolveCrowHome } from "./crow-home.js";

export const SECRET_VALUES_FILENAME = "pi-bot-secret-values";
/** The display set, beside the card set (pi-lab's reader takes one plain value
 * per line, so a second FILE, not a marked section, keeps its contract). */
export const SECRET_VALUES_DISPLAY_FILENAME = "pi-bot-secret-values-display";
/** sha256 (hex) of every manual keychain value the operator saved through the
 * UI: the only values that may hide text on an approval card. */
export const CARD_HASHES_FILENAME = "card-secret-hashes";
export const MIN_SECRET_LENGTH = 6;
export const MAX_SECRET_VALUES_BYTES = 1024 * 1024;

/** <CROW_HOME>/secrets — the instance's 700 secrets dir. */
export function secretsDir(env = process.env) {
  return join(resolveCrowHome(env), "secrets");
}

export function secretValuesPath(env = process.env) {
  return join(secretsDir(env), SECRET_VALUES_FILENAME);
}

export function secretValuesDisplayPath(env = process.env) {
  return join(secretsDir(env), SECRET_VALUES_DISPLAY_FILENAME);
}

export function cardHashesPath(env = process.env) {
  return join(secretsDir(env), CARD_HASHES_FILENAME);
}

// ---- the secrets dir's anchor ----------------------------------------------
// A bot whose shell can write the host (the default sandbox's --dev-bind) can
// rename an ANCESTOR of the hidden secrets dir and put a dir of its own at the
// old path: the tmpfs moves with the renamed dir. So the dir is anchored by
// (dev, ino) the first time this process uses it, and a dir at the path that
// is not the anchored one is never trusted.
const anchors = new Map();   // path -> { dev, ino, path, fd }

/**
 * Create (700) and anchor this instance's secrets dir; returns the anchor.
 * The anchor keeps an fd on the dir open for the life of the process: every
 * read and write in it goes through /proc/self/fd/<fd> (anchoredPath), so a
 * dir renamed away is followed to where it really is, and a dir planted at
 * the old path is never used.
 */
export function anchorSecretsDir(env = process.env) {
  const dir = secretsDir(env);
  if (anchors.has(dir)) return anchors.get(dir);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let fd;
  try { fd = openSync(dir, fsConstants.O_RDONLY | fsConstants.O_DIRECTORY | fsConstants.O_NOFOLLOW); } catch { return null; }
  const st = fstatSync(fd);
  if (!st.isDirectory() || st.uid !== process.getuid()) { closeSync(fd); return null; }
  if ((st.mode & 0o777) !== 0o700) { try { chmodSync("/proc/self/fd/" + fd, 0o700); } catch { /* best effort */ } }
  const a = { dev: st.dev, ino: st.ino, path: dir, fd };
  anchors.set(dir, a);
  return a;
}

/** A name inside the ANCHORED secrets dir, through its fd (null: no anchor). */
export function anchoredPath(env = process.env, ...names) {
  const a = anchorSecretsDir(env);
  return a ? join("/proc/self/fd/" + a.fd, ...names) : null;
}

/** Where the anchored secrets dir really is now (a real path, for hiding and for pi). */
export function secretsDirCurrentPath(env = process.env) {
  const a = anchorSecretsDir(env);
  if (!a) return null;
  try { return readlinkSync("/proc/self/fd/" + a.fd); } catch { return null; }
}

/** True when the dir at the secrets path is the anchored one. */
export function secretsDirTrusted(env = process.env) {
  const a = anchorSecretsDir(env);
  if (!a) return false;
  try {
    const st = lstatSync(a.path);
    return st.isDirectory() && !st.isSymbolicLink() && st.dev === a.dev && st.ino === a.ino;
  } catch { return false; }
}

/** CROW_HOME=<path> values in unit files and env files (read-only scan). */
function declaredHomes(dirs, depth = 2) {
  const out = [];
  const scan = (d, left) => {
    let names = [];
    try { names = readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const n of names) {
      const p = join(d, n.name);
      if (n.isDirectory()) { if (left > 0) scan(p, left - 1); continue; }
      if (!/\.(service|conf|env)$/.test(n.name)) continue;
      let text = "";
      try { const st = statSync(p); if (st.size > 256 * 1024) continue; text = readFileSync(p, "utf8"); } catch { continue; }
      for (const m of text.matchAll(/CROW_HOME=("?)([^"\s]+)\1/g)) if (m[2].startsWith("/")) out.push(m[2]);
    }
  };
  for (const d of dirs) scan(d, depth);
  return out;
}

/**
 * The secrets dirs of EVERY other Crow home on this host, found by shape (a
 * `secrets/` holding `keychain.key`), whatever the home is called: children of
 * $HOME, the default ~/.crow, and every CROW_HOME declared in user/system
 * units and /etc/crow env files (homes outside $HOME are declared there). Real paths
 * (a symlinked secrets dir is hidden at its target). The pi sandbox hides them
 * all, and the bridge trusts card values only when every one was masked: a
 * co-hosted instance's bot (same uid) must not read or write another's.
 */
export function instanceSecretsDirs(env = process.env, {
  home = env.HOME || homedir(),
  unitDirs = [join(env.HOME || homedir(), ".config", "systemd", "user"), "/etc/systemd/system"],
  envFileDirs = ["/etc/crow"],
} = {}) {
  let self = secretsDir(env);
  try { self = realpathSync(self); } catch { /* not there yet */ }
  const homes = new Set([join(home, ".crow"), ...declaredHomes(unitDirs), ...declaredHomes(envFileDirs, 0)]);
  let names = [];
  try { names = readdirSync(home, { withFileTypes: true }); } catch { names = []; }
  for (const n of names) if (n.isDirectory()) homes.add(join(home, n.name));
  const out = new Set();
  for (const h of homes) {
    const s = join(h, "secrets");
    try {
      if (!statSync(join(s, "keychain.key")).isFile()) continue;
      const r = realpathSync(s);
      if (r !== self) out.add(r);
    } catch { /* not a Crow home */ }
  }
  return [...out];
}

/** The anchor of this instance's secrets dir (for inode checks elsewhere). */
export function secretsDirAnchor(env = process.env) {
  return anchorSecretsDir(env);
}

function sha256(v) { return createHash("sha256").update(String(v)).digest("hex"); }

/** The operator's card hashes; null when the list does not exist yet. */
/** The operator's card hashes (empty when there is no list yet). */
export function readCardHashes(env = process.env) {
  const p = anchoredPath(env, CARD_HASHES_FILENAME);
  const f = p ? readSecretValuesFile(p, { raw: true }) : null;
  return new Set(f ? f.lines.filter((l) => /^[0-9a-f]{64}$/.test(l)) : []);
}

/**
 * Record values the operator saved (keychain UI add / import, or the one-time
 * confirm of existing entries: scripts/ops/keychain-card-secrets.mjs). Written
 * through the anchored dir; inside the sandbox that dir is a read-only tmpfs,
 * so a bot's shell cannot add to it.
 */
export function recordCardSecret(values, env = process.env) {
  const list = [].concat(values).filter((v) => typeof v === "string" && v);
  const p = anchoredPath(env, CARD_HASHES_FILENAME);
  if (!list.length || !p) return;
  const cur = readCardHashes(env);
  for (const v of list) cur.add(sha256(v));
  writeSecretValuesFile(p, [...cur], { raw: true });
}

export function cardHashOf(v) { return sha256(v); }

const SECRET_PARTS = new Set(["PASS", "PASSWORD", "PASSWD", "PW", "PWD", "SECRET", "SECRETS", "TOKEN", "APIKEY", "KEY",
  "CREDENTIAL", "CREDENTIALS", "DSN"]);
const NOT_SECRET_NAMES = new Set(["PWD", "OLDPWD"]);

/**
 * An env NAME that holds a credential: an `_`-separated part is one of
 * PASS/PASSWORD/PASSWD/PW/PWD/SECRET(S)/TOKEN/APIKEY/KEY/CREDENTIAL(S)/DSN, or the
 * name contains PASSWORD/PASSWD/SECRET or ends in TOKEN (PGPASSWORD,
 * GITHUBTOKEN). Narrower than bot-env.js's SECRET_NAME_RE (which also drops
 * AUTH/SESSION names from a bot's env, where erring wide costs nothing):
 * here a false positive hides an ordinary word from every card.
 * MAX_TOKENS, PWD and OLDPWD are not secrets.
 */
export function isSecretEnvName(name) {
  const n = String(name || "").toUpperCase();
  if (!n || NOT_SECRET_NAMES.has(n)) return false;
  if (n.split("_").some((p) => SECRET_PARTS.has(p))) return true;
  return /PASSWORD|PASSWD|SECRET/.test(n) || /TOKEN$/.test(n);
}

const PLACEHOLDER_RE = /(changeme|change-me|placeholder|example|dummy|your[-_]|xxxx|not[-_]?needed|no[-_]?key|none|null|undefined)/i;

/**
 * Whether a value found under a secret-looking NAME is worth hiding. Values a
 * person or the installer chose as secrets (keychain, generated bundle keys,
 * token files) skip this and only need the minimum length.
 */
export function plausibleSecretValue(v) {
  if (typeof v !== "string") return false;
  const s = v.trim();
  if (s.length < MIN_SECRET_LENGTH || /[\r\n]/.test(s)) return false;
  if (s.startsWith("/") || s.startsWith("~/") || s.startsWith("./")) return false;   // a path
  if (/^\d{1,9}$/.test(s)) return false;                                             // a number
  if (/^(true|false|yes|no|on|off|enabled|disabled|required|optional|auto|localhost)$/i.test(s)) return false;
  if (/^[a-z]+(?:[-.][a-z]+)*$/.test(s) && s.length < 24) return false;               // lowercase words
  if (PLACEHOLDER_RE.test(s)) return false;
  if (s.startsWith("$")) return false;                                                // a reference
  return true;
}

/**
 * Whether an exact value may hide text on an APPROVAL CARD (secret-mask.js,
 * card mode). Never one shaped like a flag, a domain/host name, a path, a URL
 * or shell (whitespace, operators, substitution): hiding those on a card can
 * hide what a command does, and even a trusted source can be fed a planted
 * value (the keychain backfill seals values from bundle .env files at boot).
 * Display paths (logs, notifications, transcripts) use every value.
 */
export function safeShape(v) {
  const s = String(v);
  if (s.startsWith("-") || /^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\.?$/.test(s)) return false;
  if (/[\s;&|<>()$`{}\[\]*?'"\\/]/.test(s) || s.startsWith("~")) return false;
  return true;
}

/** One-line values of usable length; multi-line values (keys) contribute
 * their long lines. Deduped, longest first. */
export function normalizeValues(values) {
  const out = new Set();
  for (const raw of values || []) {
    if (typeof raw !== "string") continue;
    const lines = raw.includes("\n") ? raw.split(/\r?\n/).filter((l) => l.trim().length >= 16) : [raw];
    for (const l of lines) {
      const v = l.trim();
      if (v.length >= MIN_SECRET_LENGTH && !/[\r\n]/.test(v)) out.add(v);
    }
  }
  return [...out].sort((a, b) => b.length - a.length || (a < b ? -1 : 1));
}

/** Secret-named, plausible values from a process env (the card rule,
 * safeShape, is applied at mask time). */
export function secretValuesFromEnv(env) {
  const out = [];
  for (const [k, v] of Object.entries(env || {})) {
    if (isSecretEnvName(k) && plausibleSecretValue(v)) out.push(String(v).trim());
  }
  return out;
}

/**
 * Write the values file atomically: a fresh temp (random name, O_EXCL, mode
 * 600) in the same dir, fsync, rename. A target that is a symlink or not a
 * regular file is refused (left as it is). Unchanged content is not rewritten.
 * @returns {{path: string, count: number, written: boolean}}
 */
export function writeSecretValuesFile(path, values, { raw = false } = {}) {
  const list = raw ? [...new Set(values)].sort() : normalizeValues(values);
  const content = list.length ? list.join("\n") + "\n" : "";
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  // An existing dir is ours and 700, or nothing is written into it.
  const viaFd = dir.startsWith("/proc/self/fd/");
  const dst = viaFd ? statSync(dir) : lstatSync(dir);
  if (!dst.isDirectory() || dst.uid !== process.getuid()) throw new Error("secrets dir is not this user's directory: " + dir);
  if ((dst.mode & 0o777) !== 0o700) chmodSync(dir, 0o700);
  let st = null;
  try { st = lstatSync(path); } catch { /* absent */ }
  if (st && (!st.isFile() || st.isSymbolicLink())) throw new Error("secret values file is not a regular file: " + path);
  const cur = st ? readSecretValuesFile(path, { raw: true }) : null;
  if (cur && cur.lines.join("\n") === list.join("\n")) return { path, count: list.length, written: false };
  sweepStaleTemps(dir, basename(path));
  const tmp = join(dir, `.${basename(path)}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
  try {
    const fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    try {
      fchmodSync(fd, 0o600);                     // a strict umask must not leave it 400
      writeFileSync(fd, content);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  primeSecretValuesCache();
  return { path, count: list.length, written: true };
}

/** Temps a crashed writer left behind (plaintext), older than a minute. */
function sweepStaleTemps(dir, base) {
  const now = Date.now();
  let names = [];
  try { names = readdirSync(dir); } catch { return; }
  for (const n of names) {
    if (!n.startsWith("." + base + ".tmp-")) continue;
    try { if (now - lstatSync(join(dir, n)).mtimeMs > 60_000) rmSync(join(dir, n), { force: true }); } catch { /* raced */ }
  }
}

/**
 * Read the values file with the contract's trust checks: a regular file (not
 * a symlink), owned by this user, mode 600, under 1 MB. Anything else is null.
 */
export function readSecretValuesFile(path, { raw = false } = {}) {
  let fd;
  try {
    // pi-lab's loader checks too: no symlink anywhere in the path, and the
    // file opened is the file checked.
    const lst = lstatSync(path);
    // (a /proc/self/fd/<anchored dir> path is the anchor itself, not a symlink to trust)
    if (!path.startsWith("/proc/self/fd/") && realpathSync(path) !== resolve(path)) return null;
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (st.ino !== lst.ino || st.dev !== lst.dev) return null;
    if (!st.isFile() || st.uid !== process.getuid() || (st.mode & 0o777) !== 0o600 || st.size > MAX_SECRET_VALUES_BYTES) return null;
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n <= 0) break;
      off += n;
    }
    const lines = buf.subarray(0, off).toString("utf8").split("\n").filter((l) => l !== "");
    return { values: raw ? lines : normalizeValues(lines), lines, mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* closed */ } }
  }
}

let cache = null;   // { values, key, env, mem }
let memValues = [];      // the last DISPLAY set collected in THIS process (secret-values-collect.js)
let memCardValues = [];  // the last CARD set collected in THIS process

function primeSecretValuesCache() { cache = null; }

/**
 * Hold the instance's values in this process's memory. The bot engine does
 * this at every spawn, file or no file: where the file is not written (no
 * bubblewrap) this is how the process's own mask still gets them.
 */
export function primeSecretValues(values, cardValues = []) {
  memValues = normalizeValues(values);
  memCardValues = normalizeValues(cardValues).filter(safeShape);
  cache = null;
}

/**
 * The values that may hide text on an APPROVAL CARD: the card set collected in
 * THIS process only (operator-saved manual keychain entries, shell-safe).
 * Never a file: a file is a path, and a path can be planted.
 */
export function getCardValues() {
  return memCardValues.filter(safeShape);
}

/** Drop the cached list (the next getSecretValues() re-reads). */
export function invalidateSecretValues() { cache = null; }

function fileKey(path) {
  try { const st = lstatSync(path); return st.ino + ":" + st.mtimeMs + ":" + st.size; } catch { return "none"; }
}

/**
 * The values maskSecrets() hides on DISPLAY paths: the display file (written
 * by the bot engine at every pi spawn, read only while the secrets dir is the
 * anchored one), the display set collected in this process, and this
 * process's own secret-named env values. One lstat per call: the list is
 * re-read the moment any process replaces the file. Never opens a database;
 * never throws (an unreadable file means patterns only).
 */
export function getSecretValues({ env = process.env } = {}) {
  const path = anchoredPath(env, SECRET_VALUES_DISPLAY_FILENAME);
  const key = path ? fileKey(path) : "untrusted";
  if (cache && cache.key === key && cache.env === env && cache.mem === memValues) return cache.values;
  const f = key === "none" || key === "untrusted" ? null : readSecretValuesFile(path);
  cache = { values: normalizeValues([...(f ? f.values : []), ...memValues, ...secretValuesFromEnv(env)]), key, env, mem: memValues };
  return cache.values;
}
