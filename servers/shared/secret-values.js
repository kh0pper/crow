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
import { closeSync, fstatSync, lstatSync, mkdirSync, openSync, readFileSync, readSync, renameSync, rmSync, writeFileSync, fsyncSync, constants as fsConstants } from "node:fs";
import { basename, dirname, join } from "node:path";
import { randomBytes } from "node:crypto";
import { resolveCrowHome } from "./crow-home.js";

export const SECRET_VALUES_FILENAME = "pi-bot-secret-values";
export const MIN_SECRET_LENGTH = 6;
export const MAX_SECRET_VALUES_BYTES = 1024 * 1024;
const CACHE_TTL_MS = 60_000;

/** <CROW_HOME>/secrets — the instance's 700 secrets dir. */
export function secretsDir(env = process.env) {
  return join(resolveCrowHome(env), "secrets");
}

export function secretValuesPath(env = process.env) {
  return join(secretsDir(env), SECRET_VALUES_FILENAME);
}

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

/** Secret-named values from an env-like object (a process env, a parsed .env). */
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
export function writeSecretValuesFile(path, values) {
  const list = normalizeValues(values);
  const content = list.length ? list.join("\n") + "\n" : "";
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  let st = null;
  try { st = lstatSync(path); } catch { /* absent */ }
  if (st && (!st.isFile() || st.isSymbolicLink())) throw new Error("secret values file is not a regular file: " + path);
  if (st && st.uid === process.getuid() && (st.mode & 0o777) === 0o600) {
    try { if (readFileSync(path, "utf8") === content) return { path, count: list.length, written: false }; } catch { /* rewrite */ }
  }
  const tmp = join(dir, `.${basename(path)}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`);
  try {
    const fd = openSync(tmp, fsConstants.O_WRONLY | fsConstants.O_CREAT | fsConstants.O_EXCL | fsConstants.O_NOFOLLOW, 0o600);
    try {
      writeFileSync(fd, content);
      fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(tmp, path);
  } catch (err) {
    rmSync(tmp, { force: true });
    throw err;
  }
  primeSecretValuesCache(list);
  return { path, count: list.length, written: true };
}

/**
 * Read the values file with the contract's trust checks: a regular file (not
 * a symlink), owned by this user, mode 600, under 1 MB. Anything else is null.
 */
export function readSecretValuesFile(path) {
  let fd;
  try {
    fd = openSync(path, fsConstants.O_RDONLY | fsConstants.O_NOFOLLOW | fsConstants.O_NONBLOCK);
    const st = fstatSync(fd);
    if (!st.isFile() || st.uid !== process.getuid() || (st.mode & 0o777) !== 0o600 || st.size > MAX_SECRET_VALUES_BYTES) return null;
    const buf = Buffer.alloc(st.size);
    let off = 0;
    while (off < st.size) {
      const n = readSync(fd, buf, off, st.size - off, off);
      if (n <= 0) break;
      off += n;
    }
    return { values: normalizeValues(buf.subarray(0, off).toString("utf8").split("\n")), mtimeMs: st.mtimeMs, size: st.size };
  } catch {
    return null;
  } finally {
    if (fd !== undefined) { try { closeSync(fd); } catch { /* closed */ } }
  }
}

let cache = null;   // { values, at, key }

function primeSecretValuesCache(list) {
  cache = { values: normalizeValues([...list, ...secretValuesFromEnv(process.env)]), at: Date.now(), key: null };
}

/** Drop the cached list (the next getSecretValues() re-reads). */
export function invalidateSecretValues() { cache = null; }

/**
 * The values maskSecrets() hides: the instance file (written by the bot engine
 * at every pi spawn) plus this process's own secret-named env values. Cached
 * for a minute; re-read sooner when the file's mtime/size changed. Never opens
 * a database; never throws (an unreadable file means patterns only).
 */
export function getSecretValues({ env = process.env, now = Date.now(), ttlMs = CACHE_TTL_MS } = {}) {
  const path = secretValuesPath(env);
  if (cache && now - cache.at < ttlMs) return cache.values;
  let fileVals = [];
  let key = "none";
  const f = readSecretValuesFile(path);
  if (f) { fileVals = f.values; key = f.mtimeMs + ":" + f.size; }
  if (cache && cache.key === key) { cache.at = now; return cache.values; }
  cache = { values: normalizeValues([...fileVals, ...secretValuesFromEnv(env)]), at: now, key };
  return cache.values;
}
