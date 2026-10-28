/**
 * The gateway-owned staging dir for files a bot SENT (send_user_file):
 * <CROW_HOME>/secrets/perch-delivered/<sessionId>/<name>.
 *
 * The copy runs on the host, outside the bot's sandbox, so it must never
 * write through anything the bot can steer. The bot's own outputs dir is
 * writable by the bot (and so are its parents), so delivered copies live here
 * instead:
 *   - it sits INSIDE the instance's secrets dir (700, owned by this user),
 *     which the pi sandbox hides from bubblewrapped bots (a read-only tmpfs),
 *     so a bot can neither see nor plant there;
 *   - the root is created and opened through the secrets dir's anchored fd
 *     (secret-values.js anchoredPath) when the engine starts, and its own fd
 *     is held open: every later open goes through that fd, so a root (or an
 *     ancestor) renamed away and replaced is never used;
 *   - every component below the root is opened from the anchored root fd with
 *     O_DIRECTORY|O_NOFOLLOW (through /proc/self/fd/<fd>), and files are
 *     created with O_CREAT|O_EXCL|O_NOFOLLOW: no path is resolved twice.
 * The workspace route serves from here (perch-interactive-api.js).
 */
import { closeSync, constants as fs, existsSync, fstatSync, lstatSync, mkdirSync, openSync, readlinkSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { anchoredPath, secretsDir } from "./secret-values.js";

export const DELIVERED_DIRNAME = "perch-delivered";

let anchor = null;   // { fd, dev, ino }

/** Where the staging root lives (for the sandbox's hide list and docs). */
export function deliveredRootPath(crowHome) {
  return join(secretsDir({ CROW_HOME: crowHome }), DELIVERED_DIRNAME);
}

/** A session id as one safe path component. */
function safeComponent(name) {
  const s = String(name || "");
  return /^[A-Za-z0-9._-]{1,128}$/.test(s) && s !== "." && s !== "..";
}

/**
 * Create (700) and anchor the staging root; its fd stays open. Called once by
 * the engine at start with the instance env (the root is made through the
 * anchored secrets dir), or with a plain dir path (test seams). Refuses a
 * root that is not a real directory owned by this user.
 */
export function registerDeliveredRoot(envOrRoot) {
  const root = typeof envOrRoot === "string" ? envOrRoot : anchoredPath(envOrRoot, DELIVERED_DIRNAME);
  if (!root) throw new Error("no anchored secrets dir");
  try { mkdirSync(root, { mode: 0o700, recursive: typeof envOrRoot === "string" }); } catch (e) { if (e.code !== "EEXIST") throw e; }
  const fd = openSync(root, fs.O_RDONLY | fs.O_DIRECTORY | fs.O_NOFOLLOW);
  const st = fstatSync(fd);
  if (!st.isDirectory() || st.uid !== process.getuid()) { closeSync(fd); throw new Error("staging root is not this user's directory"); }
  if (anchor) { try { closeSync(anchor.fd); } catch { /* closed */ } }
  anchor = { fd, dev: st.dev, ino: st.ino };
  return anchor;
}

export function deliveredAnchor() { return anchor; }

/** A fresh fd on the anchored root (re-opened through the held fd). */
function openRoot() {
  if (!anchor) throw new Error("no staging root");
  const fd = openSync("/proc/self/fd/" + anchor.fd, fs.O_RDONLY | fs.O_DIRECTORY);
  const st = fstatSync(fd);
  if (st.dev !== anchor.dev || st.ino !== anchor.ino) { closeSync(fd); throw new Error("staging root moved"); }
  return fd;
}

/**
 * The session's staging dir as an fd. `create`: make it (700) if missing,
 * through the root fd. Caller closes the fd.
 */
export function openDeliveredDir(sessionId, { create = false } = {}) {
  if (!safeComponent(sessionId)) throw new Error("bad session id");
  const root = openRoot();
  try {
    const p = "/proc/self/fd/" + root + "/" + sessionId;
    if (create) { try { mkdirSync(p, { mode: 0o700 }); } catch (e) { if (e.code !== "EEXIST") throw e; } }
    return openSync(p, fs.O_RDONLY | fs.O_DIRECTORY | fs.O_NOFOLLOW);
  } finally { closeSync(root); }
}

/** A delivered file's name: one flat, non-dot component. */
function validName(name) {
  const n = String(name || "");
  return !!n && n.length <= 255 && !n.includes("/") && !n.includes("\0") && !n.startsWith(".");
}

/**
 * PR-E (audit item 12): pick the stored name for a delivered file.
 * Collision policy (operator decision 2026-09-13): SUFFIX, never overwrite —
 * `report.png` → `report-2.png` → `report-3.png`, first slot free of every
 * existing name in the dir(s), sync loop. A dotfile basename is renamed out of
 * dotness (the workspace route refuses any dotfile path SEGMENT, so a stored
 * `.secret` would be a permanently dead card; `secret` is served instead).
 * `dir` may be a list: a sent copy's name must not collide with a file in the
 * staging dir OR in the session's outputs dir (both are served under the same
 * flat name). Pure apart from the existence checks; the caller creates the
 * file with O_EXCL.
 */
export function resolveSentName(dir, basename) {
  const dirs = [].concat(dir).filter(Boolean);
  const clean = String(basename == null ? "" : basename).replace(/[\\/]/g, "").replace(/^\.+/, "").trim() || "file";
  const dot = clean.lastIndexOf(".");
  const stem = dot > 0 ? clean.slice(0, dot) : clean;
  const ext = dot > 0 ? clean.slice(dot) : "";
  let candidate = clean;
  for (let n = 2; dirs.some((d) => existsSync(join(d, candidate))); n++) {
    candidate = stem + "-" + n + ext;
  }
  return candidate;
}

/** Open one delivered file (flat name, never a symlink) for reading; caller closes. */
export function openDeliveredFile(sessionId, name) {
  const n = String(name || "");
  if (!validName(n)) throw new Error("bad name");
  const dfd = openDeliveredDir(sessionId);
  try {
    return openSync("/proc/self/fd/" + dfd + "/" + n, fs.O_RDONLY | fs.O_NOFOLLOW | fs.O_NONBLOCK);
  } finally { closeSync(dfd); }
}

/**
 * Remove one delivered file. Same anchoring as every other access: the
 * session dir is opened from the root fd with O_NOFOLLOW (a symlinked session
 * dir is refused), and the name is unlinked through that dir fd
 * (/proc/self/fd/<dirfd>/<name>; Node has no unlinkat). unlink never follows
 * its last component, and anything that is not a regular file (a planted
 * symlink, a dir, a fifo) is left alone and reported false. Never throws.
 */
export function unlinkDelivered(sessionId, name) {
  if (!validName(name)) return false;
  let dfd;
  try {
    dfd = openDeliveredDir(sessionId);
    const p = "/proc/self/fd/" + dfd + "/" + String(name);
    if (!lstatSync(p).isFile()) return false;
    unlinkSync(p);
    return true;
  } catch { return false; }
  finally { if (dfd !== undefined) { try { closeSync(dfd); } catch { /* closed */ } } }
}

/** The session's staging dir path for display / snapshots (never opened by path). */
export function deliveredDirPath(sessionId) {
  if (!anchor) return null;
  try { return join(readlinkSync("/proc/self/fd/" + anchor.fd), String(sessionId)); } catch { return null; }
}

/** Test seam. */
export function _resetDeliveredForTest() {
  if (anchor) { try { closeSync(anchor.fd); } catch { /* closed */ } }
  anchor = null;
}
